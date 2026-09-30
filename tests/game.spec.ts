import { expect, test, type Page } from '@playwright/test';
import { RULES, type GameState, type Point } from '../src/game/types';

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

async function fireAtNearest(page: Page, milliseconds = 2_200) {
  const firstTarget = await nearestTarget(page);
  expect(firstTarget).not.toBeNull();
  await page.mouse.move(firstTarget!.x, firstTarget!.y);
  await page.mouse.down();
  try {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      const target = await nearestTarget(page);
      if (target) await page.mouse.move(target.x, target.y);
      await page.waitForTimeout(80);
    }
  } finally {
    await page.mouse.up();
  }
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
  expect(afterShooting.shots).toBeGreaterThanOrEqual(3);
  expect(afterShooting.hits).toBeGreaterThanOrEqual(3);
  expect(afterShooting.kills).toBeGreaterThan(0);
  expect(afterShooting.firing).toBe(false);
  await expect(page.locator('#kills')).toHaveText(afterShooting.kills.toString().padStart(2, '0'));

  await page.waitForTimeout(450);
  expect((await snapshot(page)).shots).toBe(afterShooting.shots);
  await expect
    .poll(async () => (await snapshot(page)).zombies.filter((zombie) => zombie.hp === 0).length)
    .toBe(0);
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
  expect(resumed.elapsed - paused.elapsed).toBeLessThan(0.6);
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

for (const restartMethod of ['keyboard', 'button'] as const) {
  test(`natural death and ${restartMethod} restart reset the session`, async ({ page }) => {
    await start(page);
    await fireAtNearest(page, 900);
    await expect(page.getByRole('dialog', { name: '防线失守' })).toBeVisible({ timeout: 60_000 });
    const ended = await snapshot(page);
    expect(ended.phase).toBe('over');
    expect(ended.hp).toBe(0);
    expect(ended.firing).toBe(false);
    await expect(page.locator('#result-kills')).toHaveText(String(ended.kills));
    await page.waitForTimeout(400);
    expect((await snapshot(page)).elapsed).toBe(ended.elapsed);

    if (restartMethod === 'keyboard') await page.keyboard.press('r');
    else await page.getByRole('button', { name: '再次出击' }).click();
    await expect(page.locator('body')).toHaveAttribute('data-phase', 'playing');
    const restarted = await snapshot(page);
    expect(restarted.hp).toBe(RULES.maxHp);
    expect(restarted.kills).toBe(0);
    expect(restarted.shots).toBe(0);
    expect(restarted.hits).toBe(0);
    expect(restarted.firing).toBe(false);
    expect(restarted.elapsed).toBeLessThan(0.6);
    expect(restarted.zombies.map((zombie) => zombie.id)).toEqual([1, 2, 3]);
    expect(restarted.render.effects).toBe(0);

    await expect.poll(async () => (await snapshot(page)).elapsed).toBeGreaterThan(2);
    const later = await snapshot(page);
    expect(later.zombies).toHaveLength(3 + Math.floor(later.elapsed / RULES.spawnInterval));
    expect(later.shots).toBe(0);
    expect(later.hp).toBe(RULES.maxHp);
  });
}

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
    await page.getByRole('button', { name: '暂停游戏' }).tap();
    await expect(page.getByRole('dialog', { name: '行动暂停' })).toBeVisible();
    await expectNoHorizontalOverflow();
    await session.detach();
  });
});
