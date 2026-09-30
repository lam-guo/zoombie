export interface Point {
  x: number;
  z: number;
}

export type Phase = 'ready' | 'playing' | 'paused' | 'over';

export interface Zombie extends Point {
  id: number;
  hp: number;
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
  kills: number;
  elapsed: number;
  shots: number;
  hits: number;
  zombies: Zombie[];
}

export type GameEvent =
  | { type: 'shot'; from: Point; to: Point; hit: boolean }
  | { type: 'hit'; at: Point; killed: boolean }
  | { type: 'hurt'; hp: number }
  | { type: 'over' };

export interface GameInput {
  aim: Point;
  firing: boolean;
}

export const RULES = {
  playerX: 0,
  playerZ: 7,
  maxHp: 100,
  zombieHp: 75,
  damage: 25,
  fireInterval: 0.2,
  attackDamage: 10,
  attackInterval: 1,
  attackDistance: 1.45,
  maxZombies: 30,
  spawnInterval: 0.85,
  corpseLifetime: 1.5,
  range: 40,
} as const;
