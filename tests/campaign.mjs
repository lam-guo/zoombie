import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const screenshotDirectory = process.env.SCREENSHOT_DIR;
const errors = [];
const results = [];
let server;
let browser;

try {
  if (screenshotDirectory) await mkdir(screenshotDirectory, { recursive: true });
  let url = process.env.BASE_URL;
  if (!url) {
    server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    await server.listen();
    url = server.resolvedUrls.local[0];
  }
  browser = await chromium.launch({
    args: ['--enable-webgl', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('crash', () => errors.push('Browser page crashed'));
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  const inspectUrl = new URL(url);
  inspectUrl.searchParams.set('inspect', '');
  await page.goto(inspectUrl.href);
  await page.waitForFunction(() => Boolean(window.__game));
  const definitions = await page.evaluate(async () => {
    const { LEVELS, WEAPONS, RULES, levelTotal } = await import('/src/game/types.ts');
    return {
      levels: LEVELS.map((level) => ({ duration: level.duration, total: levelTotal(level) })),
      weapons: WEAPONS,
      rules: RULES,
    };
  });
  await page.getByRole('button', { name: '进入战斗' }).click();
  await page.clock.pauseAt(new Date('2026-01-01T00:10:00Z'));
  const started = Date.now();
  const deadline = started + 15 * 60 * 1_000;
  let savedFinalBattle = false;

  for (let level = 1; level <= definitions.levels.length; level++) {
    const definition = definitions.levels[level - 1];
    let holding = false;
    let nextProgress = 30;
    try {
      for (let frame = 0; frame < (definition.duration + 60) * 4; frame++) {
        assert(Date.now() < deadline, 'Campaign exceeded its 15 minute wall-clock budget');
        const { state, target } = await page.evaluate(() => {
          const state = window.__game.snapshot();
          const nearest = state.zombies
            .filter((zombie) => zombie.hp > 0)
            .sort(
              (a, b) =>
                Math.hypot(a.x - state.player.x, a.z - state.player.z) -
                Math.hypot(b.x - state.player.x, b.z - state.player.z),
            )[0];
          return { state, target: nearest ? window.__game.project(nearest) : null };
        });
        assert.equal(state.level, level, 'Level changed without clicking the next-level button');
        if (state.phase === 'cleared' || state.phase === 'victory') break;
        assert.equal(state.phase, 'playing', `The defender failed during level ${level}`);
        assert.equal(state.weapon, 'rifle');
        if (state.elapsed >= nextProgress) {
          console.log(
            JSON.stringify({
              level,
              elapsed: state.elapsed,
              hp: state.hp,
              kills: state.kills,
              spawned: state.spawned,
              errors: errors.length,
            }),
          );
          nextProgress += 30;
        }
        if (
          screenshotDirectory &&
          level === definitions.levels.length &&
          state.elapsed >= 30 &&
          target &&
          !savedFinalBattle
        ) {
          await page.screenshot({
            path: join(screenshotDirectory, 'zoombie-campaign-level-5-playing.png'),
          });
          savedFinalBattle = true;
        }
        if (target) {
          await page.mouse.move(target.x, target.y);
          if (!holding) {
            await page.mouse.down();
            holding = true;
          }
        } else {
          if (holding) {
            await page.mouse.up();
            holding = false;
          }
          if (
            state.reloadRemaining === 0 &&
            state.ammo.rifle < definitions.weapons.rifle.magazine
          ) {
            await page.keyboard.press('r');
          }
        }
        // One real render and combat update per 250ms of controlled time; no game state is injected.
        await page.clock.fastForward(250);
      }
    } finally {
      await page.mouse.up();
    }

    const state = await page.evaluate(() => window.__game.snapshot());
    const final = level === definitions.levels.length;
    assert.equal(state.phase, final ? 'victory' : 'cleared');
    assert.equal(state.spawned, definition.total);
    assert.equal(state.kills, definition.total);
    assert.equal(state.zombies.filter((zombie) => zombie.hp > 0).length, 0);
    assert.equal(state.firing, false);
    await page
      .getByRole('dialog', { name: final ? '全部通关' : '关卡完成' })
      .waitFor({ state: 'visible' });
    if (screenshotDirectory) {
      await page.screenshot({
        path: join(
          screenshotDirectory,
          final ? 'zoombie-campaign-victory.png' : `zoombie-campaign-level-${level}-cleared.png`,
        ),
      });
    }
    results.push({
      level,
      elapsed: state.elapsed,
      hp: state.hp,
      kills: state.kills,
      shots: state.shots,
    });
    console.log(JSON.stringify({ cleared: results.at(-1) }));
    await page.clock.fastForward(1_000);
    const frozen = await page.evaluate(() => window.__game.snapshot());
    assert.equal(frozen.elapsed, state.elapsed);
    assert.equal(frozen.spawned, state.spawned);

    if (!final) {
      await page.getByRole('button', { name: '下一关', exact: true }).click();
      const fresh = await page.evaluate(() => window.__game.snapshot());
      assert.equal(fresh.level, level + 1);
      assert.equal(fresh.hp, definitions.rules.maxHp);
      assert.equal(fresh.elapsed, 0);
      assert.equal(fresh.kills, 0);
      assert.equal(fresh.shots, 0);
      assert.equal(fresh.reloadRemaining, 0);
      for (const [weapon, ammo] of Object.entries(fresh.ammo))
        assert.equal(ammo, definitions.weapons[weapon].magazine);
    }
  }

  assert.equal(await page.getByRole('button', { name: '下一关', exact: true }).isVisible(), false);
  await page.getByRole('button', { name: '重新出击', exact: true }).click();
  const restarted = await page.evaluate(() => window.__game.snapshot());
  assert.equal(restarted.phase, 'playing');
  assert.equal(restarted.level, 1);
  assert.equal(restarted.hp, definitions.rules.maxHp);
  assert.equal(restarted.kills, 0);
  assert.equal(restarted.shots, 0);
  for (const [weapon, ammo] of Object.entries(restarted.ammo))
    assert.equal(ammo, definitions.weapons[weapon].magazine);
  console.log(
    JSON.stringify(
      {
        environment:
          'Chromium headless with SwiftShader, controlled 250ms frames; functional campaign validation, not an FPS benchmark',
        wallSeconds: (Date.now() - started) / 1_000,
        levels: results,
        restartedToLevel: restarted.level,
        screenshots: screenshotDirectory ?? null,
        errors,
      },
      null,
      2,
    ),
  );
  assert.equal(errors.length, 0, 'Browser reported errors');
} finally {
  await browser?.close();
  await server?.close();
}
