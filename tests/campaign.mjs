import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

export async function readBattle(page) {
  return page.evaluate(async () => {
    const { ZOMBIES } = await import('/src/game/types.ts');
    const state = window.__game.snapshot();
    const nearest = state.zombies
      .filter((zombie) => zombie.hp > 0)
      .sort(
        (a, b) =>
          Math.hypot(a.x - state.player.x, a.z - state.player.z) -
          Math.hypot(b.x - state.player.x, b.z - state.player.z),
      )[0];
    const distance = nearest
      ? Math.hypot(nearest.x - state.player.x, nearest.z - state.player.z)
      : Infinity;
    const boss = state.boss?.hp > 0 ? state.boss : null;
    if (boss && distance > 9) {
      const part = boss.parts.find((part) => part.hp > 0);
      const point = part
        ? window.__game.bossPartPositions().find((point) => point.id === part.id)
        : { ...boss, y: 2 };
      if (!point) throw new Error(`Living boss part ${part.id} has no rendered aiming position`);
      return { state, target: window.__game.project(point), weapon: 'sniper' };
    }
    return {
      state,
      target: nearest
        ? window.__game.project({ ...nearest, y: ZOMBIES[nearest.kind].scale })
        : null,
      weapon: 'rifle',
    };
  });
}

export async function applyBattleInput(page, battle, control, weapons) {
  const { state, target, weapon } = battle;
  if (state.hp <= state.maxHp - 50 && state.progress.medkits > 0) await page.keyboard.press('h');
  if (state.weapon !== weapon) {
    if (control.holding) await page.mouse.up();
    control.holding = false;
    await page.keyboard.press(weapon === 'sniper' ? '2' : '1');
  }
  if (target) {
    await page.mouse.move(target.x, target.y);
    if (!control.holding) {
      await page.mouse.down();
      control.holding = true;
    }
  } else {
    if (control.holding) {
      await page.mouse.up();
      control.holding = false;
    }
    if (state.reloadRemaining === 0 && state.ammo.rifle < weapons.rifle.magazine)
      await page.keyboard.press('r');
  }
}

export async function buySupplies(page, purchases, screenshotPath) {
  await page.locator('#open-shop').click();
  await page.getByRole('dialog', { name: '前线补给站' }).waitFor({ state: 'visible' });
  for (const item of [
    'rifle',
    'sniper',
    'reload',
    'health',
    'armor',
    'medkit',
    'medkit',
    'revive',
  ]) {
    const button = page.locator(`#buy-${item}`);
    if (!(await button.isEnabled())) continue;
    const before = await page.evaluate(() => window.__game.snapshot());
    const price = Number((await page.locator(`#shop-price-${item}`).textContent()).match(/\d+/)[0]);
    await button.click();
    const after = await page.evaluate(() => window.__game.snapshot());
    assert.equal(
      after.progress.coins,
      before.progress.coins - price,
      `${item} purchase deducted the wrong amount`,
    );
    assert.equal(after.phase, before.phase, 'Shopping must not advance the campaign');
    purchases.push({ level: before.level, item, price, coins: after.progress.coins });
  }
  if (screenshotPath) await page.screenshot({ path: screenshotPath });
  await page.locator('#close-shop').click();
}

async function checkBossVisibility(page) {
  const layout = await page.evaluate(() => {
    const boss = window.__game.snapshot().boss;
    const hud = document.querySelector('#boss-hud').getBoundingClientRect();
    return {
      kind: boss.kind,
      viewport: { width: innerWidth, height: innerHeight },
      hud: { left: hud.left, right: hud.right, top: hud.top, bottom: hud.bottom },
      points: [
        { name: 'boss center', ...window.__game.project({ ...boss, y: 2 }) },
        ...window.__game.bossPartPositions().map((part) => ({
          name: `weakpoint ${part.id + 1}`,
          ...window.__game.project(part),
        })),
      ],
    };
  });
  console.log(JSON.stringify({ bossVisibility: layout }));
  if (layout.kind === 'brood')
    assert.equal(layout.points.length, 4, 'The mother boss must expose all three weakpoints');
  for (const point of layout.points) {
    assert(
      point.x > 0 &&
        point.x < layout.viewport.width &&
        point.y > 0 &&
        point.y < layout.viewport.height,
      `${layout.kind} ${point.name} lies outside the viewport`,
    );
    const { left, right, top, bottom } = layout.hud;
    assert(
      !(point.x >= left && point.x <= right && point.y >= top && point.y <= bottom),
      `${layout.kind} ${point.name} is covered by the boss HUD at ${layout.viewport.width}px`,
    );
  }
}

async function resizeViewport(page, viewport) {
  await page.setViewportSize(viewport);
  // ResizeObserver runs on the browser's layout schedule, separately from the controlled RAF clock.
  for (let attempt = 0; attempt < 50; attempt++) {
    await page.clock.fastForward(16);
    const resized = await page.evaluate(() => {
      const canvas = document.querySelector('#game');
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.min(devicePixelRatio, 1.75);
      return (
        Math.abs(canvas.width - rect.width * ratio) < 2 &&
        Math.abs(canvas.height - rect.height * ratio) < 2
      );
    });
    if (resized) return;
    await page.waitForTimeout(20);
  }
  assert.fail('Canvas did not resize with the viewport');
}

async function runCampaign() {
  const screenshotDirectory = process.env.SCREENSHOT_DIR;
  const errors = [];
  const results = [];
  const purchases = [];
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
      const { LEVELS, WEAPONS, BOSSES, KILL_REWARDS, LEVEL_REWARDS, levelTotal } =
        await import('/src/game/types.ts');
      return {
        levels: LEVELS.map((level, index) => {
          const boss = Object.entries(BOSSES).find(([, boss]) => boss.level === index + 1);
          return {
            duration: level.duration,
            total: levelTotal(level),
            boss: boss?.[0] ?? null,
            earnings:
              Object.entries(level.counts).reduce(
                (sum, [kind, count]) => sum + KILL_REWARDS[kind] * count,
                0,
              ) +
              LEVEL_REWARDS[index] +
              (boss?.[1].reward ?? 0),
          };
        }),
        weapons: WEAPONS,
      };
    });
    const initialCoins = (await page.evaluate(() => window.__game.snapshot())).progress.coins;
    assert.equal(initialCoins, 0, 'Campaign validation starts with a fresh browser profile');
    await page.getByRole('button', { name: '进入战斗' }).click();
    await page.clock.pauseAt(new Date('2026-01-01T00:10:00Z'));
    const started = Date.now();
    const deadline = started + 15 * 60 * 1_000;
    let savedFinalBattle = false;
    const savedBosses = new Set();
    let savedBrokenPart = false;

    for (let level = 1; level <= definitions.levels.length; level++) {
      const definition = definitions.levels[level - 1];
      const control = { holding: false };
      let nextProgress = 30;
      try {
        for (let frame = 0; frame < (definition.duration + 60) * 4; frame++) {
          assert(Date.now() < deadline, 'Campaign exceeded its 15 minute wall-clock budget');
          let battle = await readBattle(page);
          const { state, target } = battle;
          assert.equal(state.level, level, 'Level changed without clicking the next-level button');
          if (state.phase === 'cleared' || state.phase === 'victory') break;
          assert.equal(state.phase, 'playing', `The defender failed during level ${level}`);
          if (state.elapsed >= nextProgress) {
            console.log(
              JSON.stringify({
                level,
                elapsed: state.elapsed,
                hp: state.hp,
                kills: state.kills,
                spawned: state.spawned,
                boss: state.boss && {
                  kind: state.boss.kind,
                  hp: state.boss.hp,
                  parts: state.boss.parts.map((part) => part.hp),
                },
                coins: state.progress.coins,
                errors: errors.length,
              }),
            );
            nextProgress += 30;
          }
          if (state.boss?.hp > 0 && !savedBosses.has(state.boss.kind)) {
            await checkBossVisibility(page);
            if (screenshotDirectory)
              await page.screenshot({
                path: join(screenshotDirectory, `zoombie-campaign-${state.boss.kind}-playing.png`),
              });
            await page.mouse.up();
            control.holding = false;
            await resizeViewport(page, { width: 390, height: 844 });
            await checkBossVisibility(page);
            if (screenshotDirectory)
              await page.screenshot({
                path: join(screenshotDirectory, `zoombie-campaign-${state.boss.kind}-mobile.png`),
              });
            await resizeViewport(page, { width: 1280, height: 800 });
            battle = await readBattle(page);
            savedBosses.add(state.boss.kind);
          }
          if (
            screenshotDirectory &&
            state.boss?.kind === 'brood' &&
            !savedBrokenPart &&
            state.boss.parts.some((part) => part.hp === 0)
          ) {
            await page.screenshot({
              path: join(screenshotDirectory, 'zoombie-campaign-brood-first-part-broken.png'),
            });
            savedBrokenPart = true;
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
          await applyBattleInput(page, battle, control, definitions.weapons);
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
      if (definition.boss) {
        assert.equal(state.boss?.kind, definition.boss);
        assert.equal(state.boss.hp, 0, 'A level cleared with a living boss');
        assert(
          state.boss.parts.every((part) => part.hp === 0),
          'A boss retained a living weakpoint',
        );
      }
      assert.equal(
        state.earnedCoins,
        definition.earnings,
        'Kill, boss and completion rewards must be credited exactly once',
      );
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
        earnedCoins: state.earnedCoins,
        coins: state.progress.coins,
        bossDefeated: definition.boss,
      });
      console.log(JSON.stringify({ cleared: results.at(-1) }));
      await page.clock.fastForward(1_000);
      const frozen = await page.evaluate(() => window.__game.snapshot());
      assert.equal(frozen.elapsed, state.elapsed);
      assert.equal(frozen.spawned, state.spawned);
      await buySupplies(
        page,
        purchases,
        screenshotDirectory
          ? join(screenshotDirectory, `zoombie-campaign-shop-level-${level}.png`)
          : undefined,
      );
      assert.equal(
        (await page.evaluate(() => window.__game.snapshot())).progress.coins,
        initialCoins +
          results.reduce((sum, result) => sum + result.earnedCoins, 0) -
          purchases.reduce((sum, purchase) => sum + purchase.price, 0),
        'Coins must reconcile with all earned rewards and UI purchases',
      );

      if (!final) {
        await page.getByRole('button', { name: '下一关', exact: true }).click();
        const fresh = await page.evaluate(() => window.__game.snapshot());
        assert.equal(fresh.level, level + 1);
        assert.equal(fresh.hp, fresh.maxHp);
        assert.equal(fresh.elapsed, 0);
        assert.equal(fresh.kills, 0);
        assert.equal(fresh.shots, 0);
        assert.equal(fresh.reloadRemaining, 0);
        for (const [weapon, ammo] of Object.entries(fresh.ammo))
          assert.equal(ammo, definitions.weapons[weapon].magazine);
      }
    }

    assert.equal(
      await page.getByRole('button', { name: '下一关', exact: true }).isVisible(),
      false,
    );
    const assets = (await page.evaluate(() => window.__game.snapshot())).progress;
    await page.getByRole('button', { name: '重新出击', exact: true }).click();
    const restarted = await page.evaluate(() => window.__game.snapshot());
    assert.equal(restarted.phase, 'playing');
    assert.equal(restarted.level, 1);
    assert.equal(restarted.hp, restarted.maxHp);
    assert.deepEqual(
      restarted.progress,
      assets,
      'Restarting the campaign must preserve purchased assets',
    );
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
          purchases,
          totalEarned: results.reduce((sum, result) => sum + result.earnedCoins, 0),
          totalSpent: purchases.reduce((sum, purchase) => sum + purchase.price, 0),
          finalProgress: restarted.progress,
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await runCampaign();
