import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

export async function readBattle(page) {
  return page.evaluate(async () => {
    const { ZOMBIES, WEAPONS, WEAPON_IDS, RULES } = await import('/src/game/types.ts');
    const state = window.__game.snapshot();
    const alive = state.zombies
      .filter((zombie) => zombie.hp > 0)
      .sort(
        (a, b) =>
          Math.hypot(a.x - state.player.x, a.z - state.player.z) -
          Math.hypot(b.x - state.player.x, b.z - state.player.z),
      );
    const nearest = alive[0];
    const distance = nearest
      ? Math.hypot(nearest.x - state.player.x, nearest.z - state.player.z)
      : Infinity;
    const boss = state.boss?.hp > 0 ? state.boss : null;
    const available = (weapon) => state.ammo[weapon] + state.reserve[weapon] > 0;
    const explosiveTarget =
      state.progress.grenades > 0 && state.grenades.length === 0
        ? alive.find(
            (zombie) =>
              Math.hypot(zombie.x - state.player.x, zombie.z - state.player.z) <
                RULES.grenadeRange &&
              alive.filter(
                (other) =>
                  Math.hypot(other.x - zombie.x, other.z - zombie.z) <= RULES.grenadeRadius,
              ).length >= 2,
          )
        : null;
    const grenadeTarget = explosiveTarget
      ? window.__game.project({ ...explosiveTarget, y: ZOMBIES[explosiveTarget.kind].scale })
      : null;
    let weapon = WEAPON_IDS.find(available) ?? state.weapon;
    if (distance <= WEAPONS.shotgun.range && available('shotgun')) weapon = 'shotgun';
    else if (boss && distance > 9 && available('sniper')) weapon = 'sniper';
    else if (nearest?.kind === 'tank' && distance > WEAPONS.shotgun.range && available('sniper'))
      weapon = 'sniper';
    if (boss && ((weapon === 'sniper' && distance > 9) || !nearest)) {
      const part = boss.parts.find((part) => part.hp > 0);
      const point = part
        ? window.__game.bossPartPositions().find((point) => point.id === part.id)
        : { ...boss, y: 2 };
      if (!point) throw new Error(`Living boss part ${part.id} has no rendered aiming position`);
      const inRange =
        Math.hypot(point.x - state.player.x, point.z - state.player.z) <= WEAPONS[weapon].range;
      return {
        state,
        target: inRange && available(weapon) ? window.__game.project(point) : null,
        weapon,
        grenadeTarget,
      };
    }
    return {
      state,
      target:
        nearest && distance <= WEAPONS[weapon].range && available(weapon)
          ? window.__game.project({ ...nearest, y: ZOMBIES[nearest.kind].scale })
          : null,
      weapon,
      grenadeTarget,
    };
  });
}

export async function applyBattleInput(page, battle, control, weapons) {
  const { state, target, weapon, grenadeTarget } = battle;
  if (state.hp <= state.maxHp - 50 && state.progress.medkits > 0) await page.keyboard.press('h');
  if (state.autoFire) return;
  if (grenadeTarget) {
    await page.mouse.move(grenadeTarget.x, grenadeTarget.y);
    await page.keyboard.press('g');
    const after = await page.evaluate(() => window.__game.snapshot());
    control.grenadesThrown =
      (control.grenadesThrown ?? 0) + state.progress.grenades - after.progress.grenades;
  }
  if (state.weapon !== weapon) {
    if (control.holding) await page.mouse.up();
    control.holding = false;
    await page.keyboard.press({ rifle: '1', sniper: '2', shotgun: '3' }[weapon]);
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
    if (
      state.reloadRemaining === 0 &&
      state.ammo[weapon] < weapons[weapon].magazine &&
      state.reserve[weapon] > 0
    )
      await page.keyboard.press('r');
  }
}

export async function buySupplies(page, purchases, screenshotPath) {
  await page.locator('#open-shop').click();
  await page.getByRole('dialog', { name: '前线补给站' }).waitFor({ state: 'visible' });
  for (const item of [
    'rifle',
    'shotgun',
    'sniper',
    'reload',
    'health',
    'grenade',
    'medkit',
    'armor',
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
    const state = window.__game.snapshot();
    const boss = state.boss;
    const hud = document.querySelector('#boss-hud').getBoundingClientRect();
    const health = document.querySelector('.health-block').getBoundingClientRect();
    const controls = document.querySelector('#battle-supplies').getBoundingClientRect();
    const rect = (bounds) => ({
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
    });
    const parts = window.__game.bossPartPositions();
    return {
      kind: boss.kind,
      liveParts: boss.parts.filter((part) => part.hp > 0).length,
      viewport: { width: innerWidth, height: innerHeight },
      hud: rect(hud),
      health: rect(health),
      controls: rect(controls),
      weakpointBounds: parts.map((part) => {
        const projected = [-0.55, 0.55].flatMap((x) =>
          [-0.55, 0.55].flatMap((y) =>
            [-0.55, 0.55].map((z) =>
              window.__game.project({ x: part.x + x, y: part.y + y, z: part.z + z }),
            ),
          ),
        );
        return {
          name: `weakpoint ${part.id + 1}`,
          left: Math.min(...projected.map((point) => point.x)),
          right: Math.max(...projected.map((point) => point.x)),
          top: Math.min(...projected.map((point) => point.y)),
          bottom: Math.max(...projected.map((point) => point.y)),
        };
      }),
      points: [
        { name: 'boss center', ...window.__game.project({ ...boss, y: 2 }) },
        { name: 'player center', ...window.__game.project({ ...state.player, y: 1.1 }) },
        ...parts.map((part) => ({
          name: `weakpoint ${part.id + 1}`,
          ...window.__game.project(part),
        })),
      ],
    };
  });
  console.log(JSON.stringify({ bossVisibility: layout }));
  assert.equal(
    layout.points.length,
    layout.liveParts + 2,
    'Every living weakpoint must have a visible aiming position',
  );
  for (const point of layout.points) {
    assert(
      point.x > 0 &&
        point.x < layout.viewport.width &&
        point.y > 0 &&
        point.y < layout.viewport.height,
      `${layout.kind} ${point.name} lies outside the viewport`,
    );
    for (const [name, { left, right, top, bottom }] of [
      ['Boss HUD', layout.hud],
      ['health block', layout.health],
      ['battle controls', layout.controls],
    ])
      assert(
        !(point.x >= left && point.x <= right && point.y >= top && point.y <= bottom),
        `${layout.kind} ${point.name} is covered by ${name} at ${layout.viewport.width}px`,
      );
  }
  for (const bounds of layout.weakpointBounds) {
    assert(
      bounds.left > 0 &&
        bounds.right < layout.viewport.width &&
        bounds.top > 0 &&
        bounds.bottom < layout.viewport.height,
      `${bounds.name} extends outside the viewport`,
    );
    for (const [name, overlay] of [
      ['Boss HUD', layout.hud],
      ['health block', layout.health],
      ['battle controls', layout.controls],
    ])
      assert(
        bounds.right <= overlay.left ||
          bounds.left >= overlay.right ||
          bounds.bottom <= overlay.top ||
          bounds.top >= overlay.bottom,
        `${bounds.name} overlaps ${name} at ${layout.viewport.width}x${layout.viewport.height}`,
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
  const automatic = process.env.CAMPAIGN_MODE === 'auto';
  assert(
    !process.env.CAMPAIGN_MODE || ['manual', 'auto'].includes(process.env.CAMPAIGN_MODE),
    'CAMPAIGN_MODE must be manual or auto',
  );
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
            reserve: level.reserve,
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
    if (automatic) await page.locator('#auto-fire').click();
    const started = Date.now();
    const deadline = started + 15 * 60 * 1_000;
    let savedFinalBattle = false;
    const savedBosses = new Set();
    let savedBrokenPart = false;
    let totalGrenadesThrown = 0;

    for (let level = 1; level <= definitions.levels.length; level++) {
      const definition = definitions.levels[level - 1];
      const control = { holding: false };
      const grenadesAtStart = (await page.evaluate(() => window.__game.snapshot())).progress
        .grenades;
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
            if (!automatic && state.boss.kind === 'brood')
              assert(
                state.boss.parts.every((part) => part.hp > 0),
                'Capture all three weakpoints before manual attacks',
              );
            await checkBossVisibility(page);
            if (screenshotDirectory)
              await page.screenshot({
                path: join(screenshotDirectory, `zoombie-campaign-${state.boss.kind}-playing.png`),
              });
            await page.mouse.up();
            control.holding = false;
            for (const viewport of [
              { width: 390, height: 844 },
              { width: 390, height: 640 },
              { width: 320, height: 640 },
            ]) {
              await resizeViewport(page, viewport);
              await checkBossVisibility(page);
              if (screenshotDirectory)
                await page.screenshot({
                  path: join(
                    screenshotDirectory,
                    `zoombie-campaign-${state.boss.kind}-mobile-${viewport.width}x${viewport.height}.png`,
                  ),
                });
            }
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
      const spent = Object.fromEntries(
        Object.entries(definitions.weapons).map(([weapon, spec]) => [
          weapon,
          spec.magazine + definition.reserve[weapon] - state.ammo[weapon] - state.reserve[weapon],
        ]),
      );
      assert(
        Object.values(spent).every((value) => Number.isSafeInteger(value) && value >= 0),
        'Invalid ammunition use',
      );
      assert.equal(
        Object.values(spent).reduce((sum, shots) => sum + shots, 0),
        state.shots,
        'Every fired round must leave the finite ammunition supply',
      );
      totalGrenadesThrown += control.grenadesThrown ?? 0;
      assert.equal(
        state.progress.grenades,
        grenadesAtStart - (control.grenadesThrown ?? 0),
        'Grenade use must match inventory',
      );
      if (automatic)
        assert.equal(control.grenadesThrown ?? 0, 0, 'Automatic fire must not spend grenades');
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
        spent,
        ammo: state.ammo,
        reserve: state.reserve,
        grenadesThrown: control.grenadesThrown ?? 0,
        remainingSingleTargetDamage: Object.fromEntries(
          Object.entries(definitions.weapons).map(([weapon, spec]) => [
            weapon,
            (state.ammo[weapon] + state.reserve[weapon]) *
              spec.damage *
              (1 + 0.2 * state.progress.weapons[weapon]),
          ]),
        ),
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
        assert.equal(fresh.autoFire, automatic);
        assert.deepEqual(fresh.reserve, definitions.levels[level].reserve);
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
    assert.equal(restarted.autoFire, automatic);
    assert.deepEqual(restarted.reserve, definitions.levels[0].reserve);
    const totalShots = Object.fromEntries(
      Object.keys(definitions.weapons).map((weapon) => [
        weapon,
        results.reduce((sum, result) => sum + result.spent[weapon], 0),
      ]),
    );
    assert(
      totalShots.rifle > 0 && totalShots.sniper > 0,
      'The campaign must exercise finite-supply weapon rotation',
    );
    if (!automatic) {
      assert(totalShots.shotgun > 0, 'The manual campaign must use the shotgun at close range');
      assert(totalGrenadesThrown > 0, 'The manual campaign must use earned grenades');
    }
    for (const [weapon, ammo] of Object.entries(restarted.ammo))
      assert.equal(ammo, definitions.weapons[weapon].magazine);
    console.log(
      JSON.stringify(
        {
          environment:
            'Chromium headless with SwiftShader, controlled 250ms frames; functional campaign validation, not an FPS benchmark',
          wallSeconds: (Date.now() - started) / 1_000,
          mode: automatic ? 'auto' : 'manual',
          totalGrenadesThrown,
          totalShots,
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
