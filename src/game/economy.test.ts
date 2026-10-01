import { describe, expect, it, vi } from 'vitest';
import {
  createProgress,
  getDamageMultiplier,
  getMaxHp,
  getPrice,
  getReloadMultiplier,
  loadProgress,
  purchase,
  saveProgress,
  type Progress,
  type ShopItemId,
} from './economy';
import type { WeaponId } from './types';

const storageKey = 'last-line-progress-v1';
const weaponIds: WeaponId[] = ['rifle', 'sniper', 'shotgun'];
const items: ShopItemId[] = [...weaponIds, 'health', 'reload', 'medkit', 'revive', 'armor'];

describe('progress and purchases', () => {
  it('starts with independent empty progress and baseline combat modifiers', () => {
    const progress = createProgress();
    expect(progress).toEqual({
      coins: 0,
      weapons: { rifle: 0, sniper: 0, shotgun: 0 },
      healthLevel: 0,
      reloadLevel: 0,
      medkits: 0,
      revive: false,
      armor: 0,
    });
    expect(getMaxHp(progress)).toBe(100);
    expect(getReloadMultiplier(progress)).toBe(1);
    for (const weapon of weaponIds) expect(getDamageMultiplier(progress, weapon)).toBe(1);
    progress.weapons.rifle = 1;
    expect(createProgress().weapons.rifle).toBe(0);
  });

  it.each(weaponIds)('buys all three %s upgrades at their listed prices', (weapon) => {
    const progress = createProgress();
    progress.coins = 1_000;
    for (const [level, price] of [100, 180, 300].entries()) {
      expect(getPrice(progress, weapon)).toBe(price);
      const balance = progress.coins;
      expect(purchase(progress, weapon)).toBe(true);
      expect(progress.coins).toBe(balance - price);
      expect(progress.weapons[weapon]).toBe(level + 1);
      expect(getDamageMultiplier(progress, weapon)).toBeCloseTo([1.2, 1.4, 1.6][level]);
      for (const other of weaponIds.filter((id) => id !== weapon))
        expect(progress.weapons[other]).toBe(0);
    }
    expect(progress.coins).toBe(420);
    const maxed = structuredClone(progress);
    expect(getPrice(progress, weapon)).toBeNull();
    expect(purchase(progress, weapon)).toBe(false);
    expect(progress).toEqual(maxed);
  });

  it.each(['health', 'reload'] as const)('buys and caps the three %s upgrades', (item) => {
    const progress = createProgress();
    progress.coins = 1_000;
    for (const [level, price] of [120, 220, 350].entries()) {
      expect(getPrice(progress, item)).toBe(price);
      expect(purchase(progress, item)).toBe(true);
      if (item === 'health') {
        expect(progress.healthLevel).toBe(level + 1);
        expect(getMaxHp(progress)).toBe([125, 150, 175][level]);
        expect(getReloadMultiplier(progress)).toBe(1);
      } else {
        expect(progress.reloadLevel).toBe(level + 1);
        expect(getReloadMultiplier(progress)).toBeCloseTo([0.9, 0.8, 0.7][level]);
        expect(getMaxHp(progress)).toBe(100);
      }
    }
    expect(progress.coins).toBe(310);
    const maxed = structuredClone(progress);
    expect(getPrice(progress, item)).toBeNull();
    expect(purchase(progress, item)).toBe(false);
    expect(progress).toEqual(maxed);
  });

  it.each(items)('does not partially mutate an unaffordable %s purchase', (item) => {
    const progress = createProgress();
    const price = getPrice(progress, item)!;
    progress.coins = price - 1;
    const before = structuredClone(progress);
    expect(getPrice(progress, item)).toBe(price);
    expect(purchase(progress, item)).toBe(false);
    expect(progress).toEqual(before);
    progress.coins = price;
    expect(purchase(progress, item)).toBe(true);
    expect(progress.coins).toBe(0);
  });

  it('caps medkits at three and allows replacing a consumed one', () => {
    const progress = createProgress();
    progress.coins = 200;
    for (let count = 1; count <= 3; count++) {
      expect(getPrice(progress, 'medkit')).toBe(40);
      expect(purchase(progress, 'medkit')).toBe(true);
      expect(progress.medkits).toBe(count);
    }
    const stocked = structuredClone(progress);
    expect(getPrice(progress, 'medkit')).toBeNull();
    expect(purchase(progress, 'medkit')).toBe(false);
    expect(progress).toEqual(stocked);
    progress.medkits--;
    expect(purchase(progress, 'medkit')).toBe(true);
    expect(progress.medkits).toBe(3);
    expect(progress.coins).toBe(40);
  });

  it('holds one revive token and can replace it after consumption', () => {
    const progress = createProgress();
    progress.coins = 360;
    expect(getPrice(progress, 'revive')).toBe(180);
    expect(purchase(progress, 'revive')).toBe(true);
    expect(progress.revive).toBe(true);
    const stocked = structuredClone(progress);
    expect(getPrice(progress, 'revive')).toBeNull();
    expect(purchase(progress, 'revive')).toBe(false);
    expect(progress).toEqual(stocked);
    progress.revive = false;
    expect(purchase(progress, 'revive')).toBe(true);
    expect(progress.coins).toBe(0);
  });

  it('charges the fixed armor price to replenish durability to sixty', () => {
    const progress = createProgress();
    progress.coins = 200;
    progress.armor = 17;
    expect(getPrice(progress, 'armor')).toBe(100);
    expect(purchase(progress, 'armor')).toBe(true);
    expect(progress.armor).toBe(60);
    expect(progress.coins).toBe(100);
    const stocked = structuredClone(progress);
    expect(getPrice(progress, 'armor')).toBeNull();
    expect(purchase(progress, 'armor')).toBe(false);
    expect(progress).toEqual(stocked);
  });

  it.each([NaN, Infinity, -1, 0.5, 1_000_000_001])(
    'rejects an invalid coin balance %s without mutation',
    (coins) => {
      const progress = { ...createProgress(), coins };
      const before = structuredClone(progress);
      expect(purchase(progress, 'rifle')).toBe(false);
      expect(progress).toEqual(before);
    },
  );

  it('rejects an unknown item without deducting coins', () => {
    const progress = { ...createProgress(), coins: 500 };
    const before = structuredClone(progress);
    expect(getPrice(progress, 'unknown' as ShopItemId)).toBeNull();
    expect(purchase(progress, 'unknown' as ShopItemId)).toBe(false);
    expect(progress).toEqual(before);
  });
});

describe('versioned storage', () => {
  it('returns fresh progress when an accessible store has no save', () => {
    const getItem = vi.fn(() => null);
    expect(loadProgress({ getItem })).toEqual({ progress: createProgress(), available: true });
    expect(getItem).toHaveBeenCalledWith(storageKey);
  });

  it('saves and restores every field through the exact versioned envelope', () => {
    const progress: Progress = {
      coins: 1_000_000_000,
      weapons: { rifle: 3, sniper: 2, shotgun: 1 },
      healthLevel: 3,
      reloadLevel: 3,
      medkits: 3,
      revive: true,
      armor: 60,
    };
    const setItem = vi.fn();
    expect(saveProgress({ setItem }, progress)).toBe(true);
    expect(setItem).toHaveBeenCalledExactlyOnceWith(
      storageKey,
      JSON.stringify({ version: 1, progress }),
    );
    const restored = loadProgress({ getItem: () => setItem.mock.calls[0][1] });
    expect(restored).toEqual({ progress, available: true });
    expect(restored.progress).not.toBe(progress);
    expect(restored.progress.weapons).not.toBe(progress.weapons);
  });

  it.each([
    '{',
    'null',
    '[]',
    '42',
    '"text"',
    JSON.stringify(createProgress()),
    JSON.stringify({ version: 2, progress: createProgress() }),
    JSON.stringify({ version: '1', progress: createProgress() }),
    JSON.stringify({ progress: createProgress() }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ version: 1, progress: createProgress(), extra: true }),
  ])('discards a malformed or unsupported envelope: %s', (saved) => {
    expect(loadProgress({ getItem: () => saved })).toEqual({
      progress: createProgress(),
      available: true,
    });
  });

  const valid = createProgress();
  it.each([
    ['missing coins', { ...valid, coins: undefined }],
    ['negative coins', { ...valid, coins: -1 }],
    ['fractional coins', { ...valid, coins: 0.5 }],
    ['excess coins', { ...valid, coins: 1_000_000_001 }],
    ['non-finite coins', { ...valid, coins: Infinity }],
    ['numeric string', { ...valid, coins: '100' }],
    ['missing weapon', { ...valid, weapons: { rifle: 0, sniper: 0 } }],
    ['extra weapon', { ...valid, weapons: { ...valid.weapons, laser: 0 } }],
    ['excess weapon level', { ...valid, weapons: { ...valid.weapons, rifle: 4 } }],
    ['fractional weapon level', { ...valid, weapons: { ...valid.weapons, sniper: 0.5 } }],
    ['negative weapon level', { ...valid, weapons: { ...valid.weapons, shotgun: -1 } }],
    ['excess health level', { ...valid, healthLevel: 4 }],
    ['excess reload level', { ...valid, reloadLevel: 4 }],
    ['excess medkits', { ...valid, medkits: 4 }],
    ['non-boolean revive', { ...valid, revive: 1 }],
    ['excess armor', { ...valid, armor: 61 }],
    ['fractional armor', { ...valid, armor: 0.5 }],
    ['extra field', { ...valid, extra: 1 }],
  ])('rejects the entire save for %s', (_, progress) => {
    const saved = JSON.stringify({ version: 1, progress });
    expect(loadProgress({ getItem: () => saved })).toEqual({
      progress: createProgress(),
      available: true,
    });
    const setItem = vi.fn();
    expect(saveProgress({ setItem }, progress as Progress)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('returns fresh progress with unavailable storage when reading throws', () => {
    expect(
      loadProgress({
        getItem: () => {
          throw new Error('Storage access denied');
        },
      }),
    ).toEqual({
      progress: createProgress(),
      available: false,
    });
  });

  it('reports a failed write without changing in-memory progress', () => {
    const progress = { ...createProgress(), coins: 123 };
    const before = structuredClone(progress);
    expect(
      saveProgress(
        {
          setItem: () => {
            throw new Error('Storage quota exceeded');
          },
        },
        progress,
      ),
    ).toBe(false);
    expect(progress).toEqual(before);
  });
});
