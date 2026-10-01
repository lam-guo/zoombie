import { expect, test, type Page } from '@playwright/test';
import {
  LEVELS,
  RULES,
  WEAPONS,
  ZOMBIES,
  levelTotal,
  type GameState,
  type Point,
  type WeaponId,
} from '../src/game/types';

type Snapshot = GameState & {
  fps: number;
  firing: boolean;
  render: { drawCalls: number; triangles: number; effects: number };
};

declare global {
  interface Window {
    __game: {
      snapshot(): Snapshot;
      project(point: Point): { x: number; y: number };
    };
  }
}

const browserErrors = new WeakMap<Page, string[]>();
const snapshot = (page: Page) => page.evaluate(() => window.__game.snapshot());

async function nearestTarget(page: Page) {
  return page.evaluate(() => {
    const state = window.__game.snapshot();
    const target = state.zombies
      .filter((zombie) => zombie.hp > 0)
      .sort(
        (a, b) =>
          Math.hypot(a.x - state.player.x, a.z - state.player.z) -
          Math.hypot(b.x - state.player.x, b.z - state.player.z),
      )[0];
    return target ? window.__game.project(target) : null;
  });
}

async function start(page: Page) {
  await page.getByRole('button', { name: '进入战斗' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'playing');
  await expect(page.getByRole('progressbar', { name: '生命值' })).toHaveAttribute(
    'aria-valuenow',
    '100',
  );
}

async function fireAtNearest(page: Page) {
  const before = await snapshot(page);
  const firstTarget = await nearestTarget(page);
  expect(firstTarget).not.toBeNull();
  await page.mouse.move(firstTarget!.x, firstTarget!.y);
  await page.mouse.down();
  try {
    await expect
      .poll(
        async () => {
          const target = await nearestTarget(page);
          if (target) await page.mouse.move(target.x, target.y);
          return (await snapshot(page)).kills;
        },
        { timeout: 15_000, intervals: [80, 100, 200] },
      )
      .toBeGreaterThan(before.kills);
  } finally {
    await page.mouse.up();
  }
}

async function startControlled(page: Page) {
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  // Reload so performance.now and the first animation frame share the controlled clock.
  await page.reload();
  await start(page);
  await page.clock.pauseAt(new Date('2026-01-01T00:10:00Z'));
}

async function advanceUntil(page: Page, condition: (state: Snapshot) => boolean, seconds: number) {
  for (let frame = 0; frame <= seconds * 4; frame++) {
    const state = await snapshot(page);
    if (condition(state)) return state;
    await page.clock.fastForward(250);
  }
  throw new Error(`Expected game state was not reached within ${seconds} simulated seconds`);
}

async function fireControlled(page: Page) {
  const before = await snapshot(page);
  const target =
    (await nearestTarget(page)) ??
    (await page.evaluate(() => window.__game.project({ x: 0, z: -10 })));
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  try {
    await advanceUntil(page, (state) => state.shots > before.shots, 5);
  } finally {
    await page.mouse.up();
  }
  return snapshot(page);
}

function expectFreshLevel(state: Snapshot, level: number, weapon: WeaponId) {
  expect(state.phase).toBe('playing');
  expect(state.level).toBe(level);
  expect(state.weapon).toBe(weapon);
  expect(state.hp).toBe(state.maxHp);
  expect(state.kills).toBe(0);
  expect(state.shots).toBe(0);
  expect(state.hits).toBe(0);
  expect(state.elapsed).toBe(0);
  expect(state.reloadRemaining).toBe(0);
  expect(state.firing).toBe(false);
  expect(state.ammo).toEqual(
    Object.fromEntries(Object.entries(WEAPONS).map(([id, weapon]) => [id, weapon.magazine])),
  );
  expect(state.reserve).toEqual(LEVELS[level - 1].reserve);
  expect(state.grenades).toHaveLength(0);
  expect(state.zombies).toHaveLength(state.spawned);
  expect(state.zombies.every((zombie) => zombie.hp === zombie.maxHp)).toBe(true);
  expect(state.render.effects).toBe(0);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('crash', () => errors.push('Browser page crashed'));
  await page.goto('/?inspect');
  await expect.poll(() => page.evaluate(() => Boolean(window.__game))).toBe(true);
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'ready');
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page), 'Browser must not report runtime or console errors').toEqual([]);
});

test('start, aim, hold fire, kill, and release', async ({ page }) => {
  await expect(page.getByRole('heading', { name: /最后\s*防线。/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停游戏' })).toBeDisabled();
  await start(page);
  await fireAtNearest(page);

  const afterShooting = await snapshot(page);
  const requiredHits = Math.ceil(ZOMBIES.normal.hp / WEAPONS.rifle.damage);
  expect(afterShooting.shots).toBeGreaterThanOrEqual(requiredHits);
  expect(afterShooting.hits).toBeGreaterThanOrEqual(requiredHits);
  expect(afterShooting.kills).toBeGreaterThan(0);
  expect(afterShooting.firing).toBe(false);
  await expect(page.locator('#kills')).toHaveText(afterShooting.kills.toString().padStart(2, '0'));

  await page.waitForTimeout(450);
  expect((await snapshot(page)).shots).toBe(afterShooting.shots);
  await expect
    .poll(async () => (await snapshot(page)).zombies.filter((zombie) => zombie.hp === 0).length)
    .toBe(0);
});

test('200ms frames preserve elapsed time and fire rate', async ({ page }) => {
  await startControlled(page);
  const target = await nearestTarget(page);
  await page.mouse.move(target!.x, target!.y);
  const before = await snapshot(page);
  await page.mouse.down();
  // fastForward fires the scheduled frame once; runFor would synthesize 16ms frames.
  for (let frame = 0; frame < 5; frame++) await page.clock.fastForward(200);
  await page.mouse.up();
  const after = await snapshot(page);
  expect(after.elapsed - before.elapsed).toBeCloseTo(1, 5);
  expect(after.shots - before.shots).toBe(5);
  expect(after.kills).toBeGreaterThan(before.kills);

  await page.keyboard.press('Escape');
  const paused = await snapshot(page);
  expect(paused.phase).toBe('paused');
  await page.clock.fastForward(5_000);
  expect((await snapshot(page)).elapsed).toBe(paused.elapsed);
  await page.keyboard.press('Escape');
  await page.clock.fastForward(200);
  const resumed = await snapshot(page);
  expect(resumed.phase).toBe('playing');
  expect(resumed.elapsed - paused.elapsed).toBeCloseTo(0.2, 5);
  expect(resumed.shots).toBe(paused.shots);
  expect(resumed.firing).toBe(false);
});

test('Escape pauses and resumes without catching up or resuming held fire', async ({ page }) => {
  await start(page);
  const target = await nearestTarget(page);
  await page.mouse.move(target!.x, target!.y);
  await page.mouse.down();
  await expect.poll(async () => (await snapshot(page)).shots).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '行动暂停' })).toBeVisible();
  await page.mouse.up();
  const paused = await snapshot(page);
  expect(paused.firing).toBe(false);
  await page.waitForTimeout(1_100);
  const stillPaused = await snapshot(page);
  expect(stillPaused.elapsed).toBe(paused.elapsed);
  expect(stillPaused.hp).toBe(paused.hp);
  expect(stillPaused.shots).toBe(paused.shots);
  expect(stillPaused.zombies).toEqual(paused.zombies);

  await page.keyboard.press('Escape');
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'playing');
  await expect.poll(async () => (await snapshot(page)).elapsed).toBeGreaterThan(paused.elapsed);
  const resumed = await snapshot(page);
  expect(resumed.shots).toBe(paused.shots);
  expect(resumed.firing).toBe(false);

  await page.getByRole('button', { name: '暂停游戏' }).click();
  await expect(page.getByRole('dialog', { name: '行动暂停' })).toBeVisible();
  await page.getByRole('button', { name: '继续战斗' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-phase', 'playing');
});

// Full Chromium models tabs sharing a window; headless-shell pages remain focused.
const fullBrowserTest = test.extend({ channel: 'chromium' });

test.describe('browser focus', () => {
  fullBrowserTest(
    'losing browser focus cancels held fire and pauses the game',
    async ({ page, context }) => {
      // Playwright otherwise forces every tab to remain focused, even after switching tabs.
      const session = await context.newCDPSession(page);
      await session.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      await page.bringToFront();
      await start(page);
      const target = await nearestTarget(page);
      await page.mouse.move(target!.x, target!.y);
      await page.mouse.down();
      await expect.poll(async () => (await snapshot(page)).firing).toBe(true);

      const otherTab = await context.newPage();
      await otherTab.goto('about:blank');
      await otherTab.bringToFront();
      await expect.poll(async () => (await snapshot(page)).phase).toBe('paused');
      const paused = await snapshot(page);
      expect(paused.firing).toBe(false);
      await page.waitForTimeout(400);
      expect((await snapshot(page)).shots).toBe(paused.shots);
      await otherTab.close();
      await page.bringToFront();
      await page.mouse.up();
      await page.getByRole('button', { name: '继续战斗' }).click();
      expect((await snapshot(page)).firing).toBe(false);
      await session.detach();
    },
  );
});

test('three weapon magazines persist and switching cancels held fire and reloading', async ({
  page,
}) => {
  await startControlled(page);
  const rifle = await fireControlled(page);
  expect(rifle.ammo.rifle).toBeLessThan(WEAPONS.rifle.magazine);

  await page.mouse.down();
  await page.keyboard.press('2');
  const switched = await snapshot(page);
  expect(switched.weapon).toBe('sniper');
  expect(switched.firing).toBe(false);
  await expect(page.getByRole('button', { name: '狙击枪', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.clock.fastForward(250);
  expect((await snapshot(page)).shots).toBe(switched.shots);
  await page.mouse.up();
  const sniper = await fireControlled(page);
  expect(sniper.ammo.sniper).toBeLessThan(WEAPONS.sniper.magazine);

  await page.getByRole('button', { name: '霰弹枪', exact: true }).click();
  const shotgun = await fireControlled(page);
  expect(shotgun.ammo.shotgun).toBeLessThan(WEAPONS.shotgun.magazine);
  await page.keyboard.press('1');
  expect((await snapshot(page)).ammo.rifle).toBe(rifle.ammo.rifle);
  await page.keyboard.press('r');
  expect((await snapshot(page)).reloadRemaining).toBeGreaterThan(0);
  await page.getByRole('button', { name: '狙击枪', exact: true }).click();
  const cancelled = await snapshot(page);
  expect(cancelled.reloadRemaining).toBe(0);
  expect(cancelled.ammo.rifle).toBe(rifle.ammo.rifle);
  expect(cancelled.ammo.sniper).toBe(sniper.ammo.sniper);
  await page.keyboard.press('3');
  expect((await snapshot(page)).ammo.shotgun).toBe(shotgun.ammo.shotgun);
  await expect(page.getByRole('button', { name: '霰弹枪', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('manual reload blocks shots and pauses without losing reload progress', async ({ page }) => {
  await startControlled(page);
  const fired = await fireControlled(page);
  await page.keyboard.press('r');
  const loading = await snapshot(page);
  expect(loading.phase).toBe('playing');
  expect(loading.level).toBe(1);
  expect(loading.shots).toBe(fired.shots);
  expect(loading.ammo.rifle).toBe(fired.ammo.rifle);
  expect(loading.reloadRemaining).toBeCloseTo(WEAPONS.rifle.reloadTime, 5);
  await page.mouse.down();
  await page.clock.fastForward(250);
  expect((await snapshot(page)).shots).toBe(fired.shots);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  const paused = await snapshot(page);
  await page.clock.fastForward(5_000);
  expect((await snapshot(page)).reloadRemaining).toBe(paused.reloadRemaining);
  await page.keyboard.press('Escape');
  const loaded = await advanceUntil(
    page,
    (state) => state.reloadRemaining === 0,
    WEAPONS.rifle.reloadTime + 1,
  );
  expect(loaded.ammo.rifle).toBe(WEAPONS.rifle.magazine);
  expect(loaded.shots).toBe(fired.shots);
  expect(loaded.firing).toBe(false);
});

test('an empty magazine automatically reloads and held fire resumes', async ({ page }) => {
  await startControlled(page);
  const point = await page.evaluate(() => window.__game.project({ x: 0, z: -10 }));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    const empty = await advanceUntil(page, (state) => state.reloadRemaining > 0, 10);
    expect(empty.ammo.rifle).toBe(0);
    expect(empty.shots).toBe(WEAPONS.rifle.magazine);
    await page.clock.fastForward(250);
    expect((await snapshot(page)).shots).toBe(empty.shots);
    const firingAgain = await advanceUntil(
      page,
      (state) => state.shots > empty.shots,
      WEAPONS.rifle.reloadTime + 1,
    );
    expect(firingAgain.ammo.rifle).toBeGreaterThan(0);
    expect(firingAgain.ammo.rifle).toBeLessThan(WEAPONS.rifle.magazine);
    expect(firingAgain.reloadRemaining).toBe(0);
  } finally {
    await page.mouse.up();
  }
});

for (const weapon of ['sniper', 'shotgun'] as const) {
  test(`${weapon} loads individual rounds, pauses, and can fire before loading the next round`, async ({
    page,
  }) => {
    await startControlled(page);
    await page.keyboard.press(weapon === 'sniper' ? '2' : '3');
    await fireControlled(page);
    const fired = await fireControlled(page);
    await page.keyboard.press('r');
    const oneLoaded = await advanceUntil(
      page,
      (state) => state.ammo[weapon] === fired.ammo[weapon] + 1,
      WEAPONS[weapon].reloadTime + 1,
    );
    expect(oneLoaded.reserve[weapon]).toBe(fired.reserve[weapon] - 1);
    expect(oneLoaded.reloadRemaining).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await page.clock.fastForward(5_000);
    const paused = await snapshot(page);
    expect(paused.ammo).toEqual(oneLoaded.ammo);
    expect(paused.reserve).toEqual(oneLoaded.reserve);
    expect(paused.reloadRemaining).toBe(oneLoaded.reloadRemaining);
    await page.keyboard.press('Escape');
    const interrupted = await fireControlled(page);
    expect(interrupted.ammo[weapon]).toBe(oneLoaded.ammo[weapon] - 1);
    expect(interrupted.reserve[weapon]).toBe(oneLoaded.reserve[weapon]);
    expect(interrupted.reloadRemaining).toBe(0);

    while ((await snapshot(page)).ammo[weapon] > 0) await fireControlled(page);
    const empty = await snapshot(page);
    expect(empty.reloadRemaining).toBeGreaterThan(0);
    await page.mouse.down();
    const resumed = await advanceUntil(
      page,
      (state) => state.shots > empty.shots,
      WEAPONS[weapon].reloadTime + WEAPONS[weapon].fireInterval + 1,
    );
    await page.mouse.up();
    expect(resumed.shots).toBe(empty.shots + 1);
    expect(resumed.ammo[weapon]).toBe(0);
    expect(resumed.reserve[weapon]).toBe(empty.reserve[weapon] - 1);
    expect(resumed.reloadRemaining).toBeGreaterThan(0);
  });
}

test('optional auto fire pauses, resumes, and switches only after the rifle supply is exhausted', async ({
  page,
}) => {
  await startControlled(page);
  await page.clock.fastForward(250);
  expect((await snapshot(page)).shots).toBe(0);
  await page.getByRole('button', { name: '自动射击', exact: true }).click();
  await expect(page.locator('#auto-fire')).toHaveAttribute('aria-pressed', 'true');
  const shooting = await advanceUntil(page, (state) => state.kills > 0, 5);
  expect(shooting.autoFire).toBe(true);
  expect(shooting.firing).toBe(false);
  await page.keyboard.press('Escape');
  const paused = await snapshot(page);
  await page.clock.fastForward(5_000);
  expect((await snapshot(page)).shots).toBe(paused.shots);
  expect((await snapshot(page)).reserve).toEqual(paused.reserve);
  await page.keyboard.press('Escape');
  await advanceUntil(page, (state) => state.shots > paused.shots, 5);
  const loading = await advanceUntil(page, (state) => state.reloadRemaining > 0, 35);
  expect(loading.weapon).toBe('rifle');
  expect(loading.reserve.rifle).toBeGreaterThan(0);
  const switched = await advanceUntil(
    page,
    (state) => state.weapon !== 'rifle',
    LEVELS[0].duration,
  );
  expect(switched.ammo.rifle + switched.reserve.rifle).toBe(0);
  expect(switched.autoFire).toBe(true);
  await page.keyboard.press('f');
  const manual = await snapshot(page);
  expect(manual.autoFire).toBe(false);
  await page.clock.fastForward(250);
  expect((await snapshot(page)).shots).toBe(manual.shots);
});

test('natural death and R retry reset the current level and preserve the selected weapon', async ({
  page,
}) => {
  await startControlled(page);
  await page.keyboard.press('2');
  await fireControlled(page);
  const ended = await advanceUntil(page, (state) => state.phase === 'over', 45);
  await expect(page.getByRole('dialog', { name: '防线失守' })).toBeVisible();
  expect(ended.hp).toBe(0);
  expect(ended.firing).toBe(false);
  await expect(page.locator('#result-kills')).toHaveText(String(ended.kills));
  await page.clock.fastForward(5_000);
  expect((await snapshot(page)).elapsed).toBe(ended.elapsed);
  await page.keyboard.press('r');
  expectFreshLevel(await snapshot(page), 1, 'sniper');
  await page.clock.fastForward(250);
  const playing = await snapshot(page);
  expect(playing.elapsed).toBeCloseTo(0.25, 5);
  expect(playing.shots).toBe(0);
  expect(playing.zombies).toHaveLength(playing.spawned);
});

test('clear level one, advance to level two, and retry that level after defeat', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await startControlled(page);
  await page.locator('#auto-fire').click();
  await advanceUntil(page, (state) => state.phase === 'cleared', LEVELS[0].duration + 60);
  await expect(page.getByRole('dialog', { name: '关卡完成' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
  const clearPanel = page.getByRole('dialog', { name: '关卡完成' });
  const modalBounds = await clearPanel.boundingBox();
  const arenaBounds = await page.locator('#arena').boundingBox();
  expect(modalBounds!.y).toBeGreaterThanOrEqual(arenaBounds!.y);
  expect(modalBounds!.y + modalBounds!.height).toBeLessThanOrEqual(
    arenaBounds!.y + arenaBounds!.height,
  );
  await page.locator('#next-level').scrollIntoViewIfNeeded();
  await expect(page.locator('#next-level')).toBeInViewport();
  const cleared = await snapshot(page);
  expect(cleared.kills).toBe(levelTotal(LEVELS[0]));
  expect(cleared.spawned).toBe(levelTotal(LEVELS[0]));
  expect(cleared.zombies.filter((zombie) => zombie.hp > 0)).toHaveLength(0);
  expect(cleared.firing).toBe(false);
  await page.clock.fastForward(5_000);
  const stillCleared = await snapshot(page);
  expect(stillCleared.elapsed).toBe(cleared.elapsed);
  expect(stillCleared.spawned).toBe(cleared.spawned);
  await page.getByRole('button', { name: '下一关', exact: true }).click();
  expectFreshLevel(await snapshot(page), 2, cleared.weapon);
  expect((await snapshot(page)).autoFire).toBe(true);
  await page.locator('#auto-fire').click();
  await advanceUntil(page, (state) => state.phase === 'over', 45);
  await expect(page.getByRole('dialog', { name: '防线失守' })).toBeVisible();
  await page.getByRole('button', { name: '重试本关', exact: true }).click();
  expectFreshLevel(await snapshot(page), 2, cleared.weapon);
});

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('fits the screen and supports touch hold and release', async ({ page, context }) => {
    const expectNoHorizontalOverflow = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        390,
      );
      await expect(page.locator('#game')).toBeInViewport();
    };
    await expectNoHorizontalOverflow();
    await page.getByRole('button', { name: '进入战斗' }).tap();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'playing');
    await expectNoHorizontalOverflow();
    await page.getByRole('button', { name: '狙击枪', exact: true }).tap();
    await expect(page.getByRole('button', { name: '狙击枪', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: '步枪', exact: true }).tap();

    const target = await nearestTarget(page);
    const session = await context.newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: target!.x, y: target!.y }],
    });
    await expect.poll(async () => (await snapshot(page)).shots).toBeGreaterThanOrEqual(3);
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const released = await snapshot(page);
    expect(released.firing).toBe(false);
    expect(released.hits).toBeGreaterThan(0);
    await page.waitForTimeout(350);
    expect((await snapshot(page)).shots).toBe(released.shots);
    await page.getByRole('button', { name: '装填弹匣' }).tap();
    expect((await snapshot(page)).reloadRemaining).toBeGreaterThan(0);
    await page.getByRole('button', { name: '暂停游戏' }).tap();
    await expect(page.getByRole('dialog', { name: '行动暂停' })).toBeVisible();
    await expectNoHorizontalOverflow();
    await session.detach();
  });
});
