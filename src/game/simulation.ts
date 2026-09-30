import {
  RULES,
  type GameEvent,
  type GameInput,
  type GameState,
  type Point,
  type Zombie,
} from './types';

const EPSILON = 1e-8;
const MAX_STEP = 1 / 60;

export class Simulation {
  readonly state: GameState;
  private nextId = 1;
  private fireCooldown = 0;
  private spawnCooldown: number = RULES.spawnInterval;

  constructor(private readonly random: () => number = Math.random) {
    this.state = {
      phase: 'ready',
      player: { x: RULES.playerX, z: RULES.playerZ },
      hp: RULES.maxHp,
      kills: 0,
      elapsed: 0,
      shots: 0,
      hits: 0,
      zombies: [],
    };
    for (const [x, z] of [
      [-5, -6],
      [0, -9],
      [5, -5],
      [-2.5, -1],
      [2.8, 0],
      [-6.5, 1],
    ]) {
      this.state.zombies.push(this.createZombie(x, z));
    }
  }

  start(): void {
    this.nextId = 1;
    this.fireCooldown = 0;
    this.spawnCooldown = RULES.spawnInterval;
    Object.assign(this.state, {
      phase: 'playing',
      player: { x: RULES.playerX, z: RULES.playerZ },
      hp: RULES.maxHp,
      kills: 0,
      elapsed: 0,
      shots: 0,
      hits: 0,
      zombies: [],
    });
    for (const [x, z] of [
      [-3, -4],
      [0, -1],
      [3.5, -6],
    ]) {
      this.state.zombies.push(this.createZombie(x, z));
    }
  }

  pause(): void {
    if (this.state.phase === 'playing') this.state.phase = 'paused';
  }

  resume(): void {
    if (this.state.phase === 'paused') this.state.phase = 'playing';
  }

  step(dt: number, input: GameInput): GameEvent[] {
    const events: GameEvent[] = [];
    if (this.state.phase !== 'playing' || !Number.isFinite(dt) || dt <= 0) return events;

    let remaining = dt;
    while (remaining > EPSILON && this.state.phase === 'playing') {
      const delta = Math.min(remaining, MAX_STEP);
      this.advance(delta, input, events);
      remaining -= delta;
    }
    return events;
  }

  private advance(dt: number, input: GameInput, events: GameEvent[]): void {
    this.state.elapsed += dt;
    const canFire = input.firing && input.aim.z < this.state.player.z;
    if (canFire && this.fireCooldown <= EPSILON) {
      this.shoot(input.aim, events);
      this.fireCooldown += RULES.fireInterval;
    }
    this.fireCooldown -= dt;
    if (!canFire) this.fireCooldown = Math.max(0, this.fireCooldown);

    for (const zombie of this.state.zombies) {
      zombie.hitTime = Math.max(0, zombie.hitTime - dt);
      if (zombie.hp <= 0) {
        zombie.deadTime += dt;
        continue;
      }

      zombie.attackCooldown = Math.max(0, zombie.attackCooldown - dt);
      const dx = this.state.player.x - zombie.x;
      const dz = this.state.player.z - zombie.z;
      const distance = Math.hypot(dx, dz);
      const movement = Math.min(zombie.speed * dt, Math.max(0, distance - RULES.attackDistance));
      if (distance > EPSILON) {
        zombie.x += (dx / distance) * movement;
        zombie.z += (dz / distance) * movement;
      }

      if (
        distance - movement <= RULES.attackDistance + EPSILON &&
        zombie.attackCooldown <= EPSILON
      ) {
        zombie.attackCooldown = RULES.attackInterval;
        this.state.hp = Math.max(0, this.state.hp - RULES.attackDamage);
        events.push({ type: 'hurt', hp: this.state.hp });
        if (this.state.hp === 0) {
          this.state.phase = 'over';
          events.push({ type: 'over' });
          break;
        }
      }
    }

    this.state.zombies = this.state.zombies.filter(
      (zombie) => zombie.hp > 0 || zombie.deadTime < RULES.corpseLifetime - EPSILON,
    );
    if (this.state.phase === 'over') return;
    this.separateZombies();

    this.spawnCooldown -= dt;
    if (this.spawnCooldown <= EPSILON) {
      this.spawnCooldown += RULES.spawnInterval;
      if (this.state.zombies.filter((zombie) => zombie.hp > 0).length < RULES.maxZombies) {
        this.state.zombies.push(this.createZombie(this.random() * 16 - 8, -17 - this.random() * 4));
      }
    }
  }

  private createZombie(x: number, z: number): Zombie {
    return {
      id: this.nextId++,
      x,
      z,
      hp: RULES.zombieHp,
      radius: 0.48,
      speed: 0.9 + this.random() * 0.35,
      attackCooldown: 0,
      hitTime: 0,
      deadTime: -1,
      variant: Math.floor(this.random() * 3),
    };
  }

  private shoot(aim: Point, events: GameEvent[]): void {
    const from = { ...this.state.player };
    const distance = Math.hypot(aim.x - from.x, aim.z - from.z);
    const direction = { x: (aim.x - from.x) / distance, z: (aim.z - from.z) / distance };
    let nearest: Zombie | undefined;
    let hitDistance: number = RULES.range;

    for (const zombie of this.state.zombies) {
      if (zombie.hp <= 0) continue;
      const dx = zombie.x - from.x;
      const dz = zombie.z - from.z;
      const along = dx * direction.x + dz * direction.z;
      const perpendicularSquared = dx * dx + dz * dz - along * along;
      if (perpendicularSquared > zombie.radius * zombie.radius) continue;
      const halfChord = Math.sqrt(
        Math.max(0, zombie.radius * zombie.radius - perpendicularSquared),
      );
      if (along + halfChord < 0) continue;
      const intersection = Math.max(0, along - halfChord);
      if (intersection <= hitDistance) {
        nearest = zombie;
        hitDistance = intersection;
      }
    }

    this.state.shots += 1;
    events.push({
      type: 'shot',
      from,
      to: { x: from.x + direction.x * hitDistance, z: from.z + direction.z * hitDistance },
      hit: Boolean(nearest),
    });
    if (nearest) {
      nearest.hp = Math.max(0, nearest.hp - RULES.damage);
      nearest.hitTime = 0.16;
      this.state.hits += 1;
      const killed = nearest.hp === 0;
      if (killed) {
        nearest.deadTime = 0;
        this.state.kills += 1;
      }
      events.push({ type: 'hit', at: { x: nearest.x, z: nearest.z }, killed });
    }
  }

  private separateZombies(): void {
    const living = this.state.zombies.filter((zombie) => zombie.hp > 0);
    for (let i = 0; i < living.length; i++) {
      for (let j = i + 1; j < living.length; j++) {
        const a = living[i];
        const b = living[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const distance = Math.hypot(dx, dz);
        const overlap = a.radius + b.radius - distance;
        if (overlap <= 0) continue;
        const push = overlap * 0.35;
        const x = distance > EPSILON ? dx / distance : 1;
        const z = distance > EPSILON ? dz / distance : 0;
        a.x -= x * push;
        a.z -= z * push;
        b.x += x * push;
        b.z += z * push;
      }
    }
    // Separation must not push enemies outside the forward-only shooting area.
    for (const zombie of living) {
      zombie.z = Math.min(zombie.z, this.state.player.z - zombie.radius * 2);
    }
  }
}
