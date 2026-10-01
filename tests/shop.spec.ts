import { expect, test, type Page } from '@playwright/test';
import { createProgress, type Progress } from '../src/game/economy';
import type { GameState } from '../src/game/types';

const snapshot = (page: Page) => page.evaluate(() => window.__game.snapshot());
const errors = new WeakMap<Page, string[]>();

test.beforeEach(async ({ page }) => {
  const messages: string[] = [];
  errors.set(page, messages);
  page.on('pageerror', (error) => messages.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') messages.push(message.text());
  });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
});

async function open(page: Page, progress?: Progress) {
  if (progress) {
    // Seed a legitimate prior save once; purchases and combat below use only public inputs.
    await page.addInitScript((saved) => {
      if (!sessionStorage.getItem('fixture-loaded')) {
        localStorage.setItem(
          'last-line-progress-v1',
          JSON.stringify({ version: 1, progress: saved }),
        );
        sessionStorage.setItem('fixture-loaded', 'true');
      }
    }, progress);
  }
  await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
  await page.goto('/?inspect');
  await expect.poll(() => page.evaluate(() => Boolean(window.__game))).toBe(true);
  await page.clock.pauseAt(new Date('2026-01-01T00:10:00Z'));
}

async function advanceUntil(page: Page, condition: (state: GameState) => boolean, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    const state = await snapshot(page);
    if (condition(state)) return state;
    await page.clock.fastForward(250);
  }
  throw new Error('Expected combat state was not reached');
}

test('empty wallet, shop focus, and battle purchase restrictions', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: '补给站', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '前线补给站' })).toBeVisible();
  await expect(page.locator('#shop-coins')).toHaveText('0');
  await expect(page.locator('#buy-rifle')).toBeDisabled();
  await expect(page.locator('#buy-medkit')).toBeDisabled();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#leave-shop')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#close-shop')).toBeFocused();
  await page.keyboard.press('r');
  expect((await snapshot(page)).phase).toBe('ready');
  await page.keyboard.press('Escape');
  await expect(page.locator('#open-shop')).toBeFocused();
  await page.locator('#start').click();
  await expect(page.locator('#open-shop')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#open-shop')).toBeDisabled();
});

test('purchases deduct coins, persist across reload, and apply upgrades on deployment', async ({
  page,
}) => {
  await open(page, { ...createProgress(), coins: 1_000 });
  await page.locator('#open-shop').click();
  for (const id of ['rifle', 'health', 'reload', 'medkit', 'revive', 'armor'])
    await page.locator(`#buy-${id}`).click();
  await expect(page.locator('#shop-coins')).toHaveText('340');
  await expect(page.locator('#buy-revive')).toBeDisabled();
  await expect(page.locator('#buy-armor')).toBeDisabled();
  const saved = (await snapshot(page)).progress;
  expect(saved).toEqual({
    coins: 340,
    weapons: { rifle: 1, sniper: 0, shotgun: 0 },
    healthLevel: 1,
    reloadLevel: 1,
    medkits: 1,
    revive: true,
    armor: 60,
  });
  await page.reload();
  expect((await snapshot(page)).progress).toEqual(saved);
  expect((await snapshot(page)).level).toBe(1);
  await page.locator('#start').click();
  expect((await snapshot(page)).maxHp).toBe(125);
  await expect(page.getByRole('progressbar', { name: '生命值' })).toHaveAttribute(
    'aria-valuemax',
    '125',
  );
  await page.keyboard.press('h');
  expect((await snapshot(page)).progress.medkits).toBe(1);
  // A reload with an already-paused clock needs one render before projecting mouse coordinates.
  await page.clock.fastForward(250);
  const point = await page.evaluate(() => window.__game.project({ x: 0, z: -10 }));
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await advanceUntil(page, (state) => state.shots > 0, 2);
  await page.mouse.up();
  await page.keyboard.press('r');
  expect((await snapshot(page)).reloadRemaining).toBeCloseTo(1.62, 5);
});

test('armor absorbs first, medkits heal, revival triggers once, and retry keeps spent supplies', async ({
  page,
}) => {
  await open(page, { ...createProgress(), medkits: 1, revive: true, armor: 60 });
  await page.locator('#start').click();
  const armored = await advanceUntil(page, (state) => state.progress.armor < 60);
  expect(armored.hp).toBe(100);
  const injured = await advanceUntil(page, (state) => state.hp <= 60);
  expect(injured.progress.armor).toBe(0);
  await page.locator('#use-medkit').click();
  const healed = await snapshot(page);
  expect(healed.hp).toBe(Math.min(100, injured.hp + 50));
  expect(healed.progress.medkits).toBe(0);
  const revived = await advanceUntil(page, (state) => !state.progress.revive);
  expect(revived.hp).toBe(100);
  expect(revived.invulnerable).toBeGreaterThan(0);
  expect(revived.phase).toBe('playing');
  await page.keyboard.press('Escape');
  const paused = await snapshot(page);
  await page.clock.fastForward(5_000);
  expect((await snapshot(page)).invulnerable).toBe(paused.invulnerable);
  await page.keyboard.press('Escape');
  const ended = await advanceUntil(page, (state) => state.phase === 'over');
  expect(ended.hp).toBe(0);
  await page.locator('#restart').click();
  const retried = await snapshot(page);
  expect(retried.hp).toBe(100);
  expect(retried.progress).toMatchObject({ armor: 0, medkits: 0, revive: false });
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('last-line-progress-v1')!),
  );
  expect(persisted.progress).toEqual(retried.progress);
});

test('blocked storage keeps game playable and explains session-only progress', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await open(page);
  await page.locator('#open-shop').click();
  await expect(page.locator('#save-status')).toContainText('存储不可用');
  await page.locator('#close-shop').click();
  await page.locator('#start').click();
  expect((await snapshot(page)).phase).toBe('playing');
});

test.describe('mobile shop', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('touch shop scrolls to supplies without overflowing the viewport', async ({ page }) => {
    await open(page, { ...createProgress(), coins: 500 });
    await page.locator('#open-shop').tap();
    await page.locator('#buy-revive').tap();
    await page.locator('#buy-armor').tap();
    expect((await snapshot(page)).progress).toMatchObject({ coins: 220, revive: true, armor: 60 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
    await page.locator('#leave-shop').tap();
    await page.locator('#start').tap();
    await expect(page.locator('#use-medkit')).toBeInViewport();
    await expect(page.locator('#reload')).toBeInViewport();
  });
});
