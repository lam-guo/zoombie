import type { Progress } from './economy';

export interface Point {
  x: number;
  z: number;
  y?: number;
}
export type WeaponId = 'rifle' | 'sniper' | 'shotgun';
export type ZombieKind = 'normal' | 'tank' | 'runner' | 'small';
export type Phase = 'ready' | 'playing' | 'paused' | 'over' | 'cleared' | 'victory';

export const WEAPONS = {
  rifle: {
    name: '突击步枪',
    code: 'AR-01',
    description: '稳定连射 · 单体压制',
    magazine: 30,
    damage: 25,
    fireInterval: 0.2,
    reloadTime: 1.8,
    range: 40,
    penetration: 1,
    halfAngle: 0,
    color: '#deed95',
  },
  sniper: {
    name: '狙击步枪',
    code: 'SR-02',
    description: '穿透三体 · 远距重击',
    magazine: 5,
    damage: 180,
    fireInterval: 1.15,
    reloadTime: 2.8,
    range: 40,
    penetration: 3,
    halfAngle: 0,
    color: '#91d4e5',
  },
  shotgun: {
    name: '霰弹枪',
    code: 'SG-03',
    description: '近距扇面 · 群体清除',
    magazine: 6,
    damage: 90,
    fireInterval: 0.85,
    reloadTime: 2.6,
    range: 9,
    penetration: 0,
    halfAngle: Math.PI / 10,
    color: '#efb279',
  },
} as const;
export const WEAPON_IDS: WeaponId[] = ['rifle', 'sniper', 'shotgun'];
export const ZOMBIES = {
  normal: { name: '游荡者', hp: 75, speed: 1.1, radius: 0.48, scale: 1, color: '#91a37b' },
  tank: { name: '重装者', hp: 200, speed: 0.7, radius: 0.65, scale: 1.35, color: '#ad7966' },
  runner: { name: '疾行者', hp: 40, speed: 1.8, radius: 0.4, scale: 0.9, color: '#cdab70' },
  small: { name: '潜行者', hp: 50, speed: 1.2, radius: 0.27, scale: 0.65, color: '#7dc2b1' },
} as const;
export interface LevelDefinition {
  name: string;
  subtitle: string;
  duration: number;
  batchSize: number;
  counts: Record<ZombieKind, number>;
  color: string;
}
export const LEVELS: readonly LevelDefinition[] = [
  {
    name: '外围接触',
    subtitle: '熟悉武器，守住检查站。',
    duration: 60,
    batchSize: 3,
    counts: { normal: 30, runner: 0, tank: 0, small: 0 },
    color: '#a8c8b2',
  },
  {
    name: '疾速突袭',
    subtitle: '疾行者出现。优先处理快速目标。',
    duration: 85,
    batchSize: 4,
    counts: { normal: 40, runner: 8, tank: 0, small: 0 },
    color: '#93becf',
  },
  {
    name: '重装压境',
    subtitle: '狙击重击能够克制重甲巨兽。',
    duration: 110,
    batchSize: 5,
    counts: { normal: 42, runner: 16, tank: 10, small: 0 },
    color: '#cabc93',
  },
  {
    name: '暗巷围袭',
    subtitle: '小型目标混入。近距霰弹可以解围。',
    duration: 135,
    batchSize: 6,
    counts: { normal: 44, runner: 20, tank: 18, small: 10 },
    color: '#9eaed2',
  },
  {
    name: '最后防线',
    subtitle: '先击破孵化主宰的三个发光弱点。',
    duration: 160,
    batchSize: 7,
    counts: { normal: 50, runner: 26, tank: 28, small: 16 },
    color: '#d6a091',
  },
];
export const levelTotal = (level: LevelDefinition): number =>
  Object.values(level.counts).reduce((sum, count) => sum + count, 0);

export const KILL_REWARDS: Record<ZombieKind, number> = {
  normal: 4,
  runner: 5,
  small: 6,
  tank: 10,
};
export const LEVEL_REWARDS = [50, 80, 120, 160, 240] as const;
export type BossKind = 'bulwark' | 'brood';
export const BOSSES = {
  bulwark: {
    name: '重甲巨兽',
    level: 3,
    spawnAt: 70,
    hp: 1600,
    radius: 1.7,
    speed: 1.6,
    stopZ: 0,
    attackInterval: 8,
    attackDamage: 20,
    reward: 150,
  },
  brood: {
    name: '孵化主宰',
    level: 5,
    spawnAt: 100,
    hp: 900,
    radius: 2.1,
    speed: 1.3,
    stopZ: 0,
    attackInterval: 8,
    attackDamage: 16,
    reward: 250,
  },
} as const;
export interface Boss extends Point {
  kind: BossKind;
  hp: number;
  maxHp: number;
  parts: { id: number; hp: number; maxHp: number }[];
  attackRemaining: number;
  deadTime: number;
  hitTime: number;
}
export const BOSS_PART_RADIUS = 0.55;
export function bossPartPosition(boss: Boss, id: number): Point & { y: number; bossPart: number } {
  const side = id - 1;
  return {
    x: boss.x + side * 1.75,
    z: boss.z + (side === 0 ? -0.15 : 0.5),
    y: side === 0 ? 2.85 : 2.3,
    bossPart: id,
  };
}

export interface Zombie extends Point {
  id: number;
  kind: ZombieKind;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  attackCooldown: number;
  hitTime: number;
  deadTime: number;
  variant: number;
}
export interface GameState {
  phase: Phase;
  player: Point;
  hp: number;
  maxHp: number;
  invulnerable: number;
  progress: Progress;
  earnedCoins: number;
  kills: number;
  elapsed: number;
  shots: number;
  hits: number;
  zombies: Zombie[];
  boss: Boss | null;
  level: number; // 1-based, from 1 through LEVELS.length
  spawned: number;
  weapon: WeaponId;
  ammo: Record<WeaponId, number>;
  reloadRemaining: number;
}
export type GameEvent =
  | { type: 'shot'; weapon: WeaponId; from: Point; to: Point; hit: boolean }
  | { type: 'hit'; at: Point; killed: boolean }
  | { type: 'reload'; weapon: WeaponId }
  | { type: 'loaded'; weapon: WeaponId }
  | { type: 'hurt'; hp: number }
  | { type: 'over' }
  | { type: 'coins'; amount: number; at?: Point }
  | { type: 'bossBreak'; at: Point; part: number }
  | { type: 'bossWarning' }
  | { type: 'revive' }
  | { type: 'heal' }
  | { type: 'clear'; level: number; final: boolean };
export interface GameInput {
  aim: Point & { bossPart?: number };
  firing: boolean;
}
export const RULES = {
  playerX: 0,
  playerZ: 7,
  maxHp: 100,
  attackDamage: 10,
  attackInterval: 1,
  attackDistance: 1.45,
  maxZombies: 30,
  corpseLifetime: 1.5,
} as const;
