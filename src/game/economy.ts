import type { WeaponId } from './types';

export interface Progress {
  coins: number;
  weapons: Record<WeaponId, number>;
  healthLevel: number;
  reloadLevel: number;
  medkits: number;
  grenades: number;
  revive: boolean;
  armor: number;
}

export type ShopItemId = WeaponId | 'health' | 'reload' | 'medkit' | 'grenade' | 'revive' | 'armor';

export const MAX_COINS = 1_000_000_000;
const STORAGE_KEY = 'last-line-progress-v1';
const WEAPON_PRICES = [100, 180, 300] as const;
const UPGRADE_PRICES = [120, 220, 350] as const;
const WEAPON_IDS: readonly WeaponId[] = ['rifle', 'sniper', 'shotgun'];

export function createProgress(): Progress {
  return {
    coins: 0,
    weapons: { rifle: 0, sniper: 0, shotgun: 0 },
    healthLevel: 0,
    reloadLevel: 0,
    medkits: 0,
    grenades: 0,
    revive: false,
    armor: 0,
  };
}

export const getDamageMultiplier = (progress: Progress, weapon: WeaponId): number =>
  1 + 0.2 * progress.weapons[weapon];

export const getMaxHp = (progress: Progress): number => 100 + 25 * progress.healthLevel;

export const getReloadMultiplier = (progress: Progress): number => 1 - 0.1 * progress.reloadLevel;

export function getPrice(progress: Progress, item: ShopItemId): number | null {
  switch (item) {
    case 'rifle':
    case 'sniper':
    case 'shotgun':
      return WEAPON_PRICES[progress.weapons[item]] ?? null;
    case 'health':
      return UPGRADE_PRICES[progress.healthLevel] ?? null;
    case 'reload':
      return UPGRADE_PRICES[progress.reloadLevel] ?? null;
    case 'medkit':
      return progress.medkits < 3 ? 40 : null;
    case 'grenade':
      return progress.grenades < 3 ? 60 : null;
    case 'revive':
      return progress.revive ? null : 180;
    case 'armor':
      return progress.armor < 60 ? 100 : null;
    default:
      return null;
  }
}

export function purchase(progress: Progress, item: ShopItemId): boolean {
  if (!isProgress(progress)) return false;
  const price = getPrice(progress, item);
  if (price === null || progress.coins < price) return false;

  switch (item) {
    case 'rifle':
    case 'sniper':
    case 'shotgun':
      progress.weapons[item]++;
      break;
    case 'health':
      progress.healthLevel++;
      break;
    case 'reload':
      progress.reloadLevel++;
      break;
    case 'medkit':
      progress.medkits++;
      break;
    case 'grenade':
      progress.grenades++;
      break;
    case 'revive':
      progress.revive = true;
      break;
    case 'armor':
      progress.armor = 60;
      break;
  }
  progress.coins -= price;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function integerInRange(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isProgress(value: unknown): value is Progress {
  if (
    !isRecord(value) ||
    !hasKeys(value, [
      'coins',
      'weapons',
      'healthLevel',
      'reloadLevel',
      'medkits',
      'grenades',
      'revive',
      'armor',
    ])
  )
    return false;
  const weapons = value.weapons;
  return (
    isRecord(weapons) &&
    hasKeys(weapons, WEAPON_IDS) &&
    WEAPON_IDS.every((weapon) => integerInRange(weapons[weapon], 3)) &&
    integerInRange(value.coins, MAX_COINS) &&
    integerInRange(value.healthLevel, 3) &&
    integerInRange(value.reloadLevel, 3) &&
    integerInRange(value.medkits, 3) &&
    integerInRange(value.grenades, 3) &&
    typeof value.revive === 'boolean' &&
    integerInRange(value.armor, 60)
  );
}

export function loadProgress(storage: Pick<Storage, 'getItem'>): {
  progress: Progress;
  available: boolean;
} {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { progress: createProgress(), available: false };
  }

  if (raw !== null) {
    try {
      const saved: unknown = JSON.parse(raw);
      if (
        isRecord(saved) &&
        hasKeys(saved, ['version', 'progress']) &&
        saved.version === 2 &&
        isProgress(saved.progress)
      ) {
        return { progress: saved.progress, available: true };
      }
      // Preserve existing assets while adding an empty grenade inventory to v1 saves.
      if (
        isRecord(saved) &&
        hasKeys(saved, ['version', 'progress']) &&
        saved.version === 1 &&
        isRecord(saved.progress) &&
        !Object.hasOwn(saved.progress, 'grenades')
      ) {
        const migrated = { ...saved.progress, grenades: 0 };
        if (isProgress(migrated)) return { progress: migrated, available: true };
      }
    } catch {
      // An unreadable save is discarded as a whole, without restoring partial purchases.
    }
  }
  return { progress: createProgress(), available: true };
}

export function saveProgress(storage: Pick<Storage, 'setItem'>, progress: Progress): boolean {
  try {
    if (!isProgress(progress)) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, progress }));
    return true;
  } catch {
    return false;
  }
}
