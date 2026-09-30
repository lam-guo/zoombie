import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const duration = Number(process.env.SOAK_SECONDS ?? 300);
assert(Number.isFinite(duration) && duration > 0, 'SOAK_SECONDS must be positive');
const errors = [];
const samples = [];
let server;
let browser;
let retries = 0;
let clearedLevels = 0;
let victories = 0;
let highestLevel = 1;
let finishedShots = 0;
let finishedKills = 0;
let finishedElapsed = 0;
let lastState;

try {
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
  const inspectUrl = new URL(url);
  inspectUrl.searchParams.set('inspect', '');
  await page.goto(inspectUrl.href);
  await page.waitForFunction(() => Boolean(window.__game));
  const definitions = await page.evaluate(async () => {
    const { LEVELS, WEAPONS, RULES, levelTotal } = await import('/src/game/types.ts');
    return { totals: LEVELS.map(levelTotal), weapons: WEAPONS, rules: RULES };
  });
  await page.getByRole('button', { name: '进入战斗' }).click();
  const started = Date.now();
  let nextSample = started;
  let holding = false;

  while (Date.now() - started < duration * 1_000) {
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
    lastState = state;
    highestLevel = Math.max(highestLevel, state.level);
    if (Date.now() >= nextSample) {
      const sample = {
        second: Math.round((Date.now() - started) / 1_000),
        level: state.level,
        phase: state.phase,
        fps: state.fps,
        ammo: state.ammo[state.weapon],
        reloadRemaining: state.reloadRemaining,
        errors: errors.length,
        live: state.zombies.filter((zombie) => zombie.hp > 0).length,
        corpses: state.zombies.filter((zombie) => zombie.hp <= 0).length,
        effects: state.render.effects,
        drawCalls: state.render.drawCalls,
        triangles: state.render.triangles,
      };
      samples.push(sample);
      assert(
        sample.live <= definitions.rules.maxZombies,
        `Live zombie limit exceeded: ${sample.live}`,
      );
      // A shotgun can clear all 30 live targets twice within the 1.5 second corpse lifetime.
      assert(
        sample.corpses <= definitions.rules.maxZombies * 2,
        `Corpses are not being recycled: ${sample.corpses}`,
      );
      assert(sample.effects <= 61, `Effect pool capacity exceeded: ${sample.effects}`);
      assert(state.hp >= 0 && state.hp <= definitions.rules.maxHp, `Invalid health: ${state.hp}`);
      assert(state.spawned <= definitions.totals[state.level - 1], 'Level spawn quota exceeded');
      assert(
        state.reloadRemaining >= 0 &&
          state.reloadRemaining <= definitions.weapons[state.weapon].reloadTime,
        'Invalid reload progress',
      );
      for (const [weapon, ammo] of Object.entries(state.ammo)) {
        assert(
          Number.isInteger(ammo) && ammo >= 0 && ammo <= definitions.weapons[weapon].magazine,
          `Invalid ${weapon} magazine: ${ammo}`,
        );
      }
      assert(
        state.zombies.every((zombie) => Number.isFinite(zombie.x) && Number.isFinite(zombie.z)),
        'Zombie position is not finite',
      );
      if (sample.second % 30 === 0) console.log(JSON.stringify({ progress: sample }));
      nextSample += 1_000;
    }

    if (state.phase === 'over' || state.phase === 'cleared' || state.phase === 'victory') {
      await page.mouse.up();
      holding = false;
      finishedShots += state.shots;
      finishedKills += state.kills;
      finishedElapsed += state.elapsed;
      if (state.phase === 'over') {
        retries++;
        await page.getByRole('button', { name: '重试本关', exact: true }).click();
      } else {
        assert.equal(
          state.kills,
          definitions.totals[state.level - 1],
          'A level cleared before every enemy was killed',
        );
        clearedLevels++;
        if (state.phase === 'victory') {
          victories++;
          await page.getByRole('button', { name: '重新出击', exact: true }).click();
        } else {
          await page.getByRole('button', { name: '下一关', exact: true }).click();
        }
      }
    } else if (state.phase === 'paused') {
      throw new Error('The soak session unexpectedly paused');
    } else if (target) {
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
      if (state.reloadRemaining === 0 && state.ammo.rifle < definitions.weapons.rifle.magazine) {
        await page.keyboard.press('r');
      }
    }
    await page.waitForTimeout(100);
  }
  await page.mouse.up();
  lastState = await page.evaluate(() => window.__game.snapshot());
  const fps = samples
    .map((sample) => sample.fps)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const percentile = (fraction) =>
    fps.length ? fps[Math.floor((fps.length - 1) * fraction)] : null;
  const peak = (key) => Math.max(0, ...samples.map((sample) => sample[key]));
  const summary = {
    environment:
      'Chromium headless with SwiftShader software rendering; not a hardware FPS benchmark',
    durationSeconds: (Date.now() - started) / 1_000,
    simulatedSeconds: finishedElapsed + lastState.elapsed,
    viewport: { width: 1280, height: 800 },
    sampleCount: samples.length,
    fps: { median: percentile(0.5), p5: percentile(0.05) },
    peak: {
      live: peak('live'),
      corpses: peak('corpses'),
      effects: peak('effects'),
      drawCalls: peak('drawCalls'),
      triangles: peak('triangles'),
    },
    retries,
    clearedLevels,
    victories,
    highestLevel,
    shots: finishedShots + lastState.shots,
    kills: finishedKills + lastState.kills,
    errors,
  };
  console.log(JSON.stringify(summary, null, 2));
  assert.equal(errors.length, 0, 'Browser reported errors');
  assert(summary.shots > 0 && summary.kills > 0, 'The soak run must exercise shooting and kills');
} finally {
  await browser?.close();
  await server?.close();
}
