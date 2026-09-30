import {
  LEVELS,
  RULES,
  WEAPONS,
  ZOMBIES,
  levelTotal,
  type GameEvent,
  type GameInput,
  type GameState,
  type Point,
  type WeaponId,
  type Zombie,
  type ZombieKind,
} from './types';

const EPSILON = 1e-8;
const MAX_STEP = 1 / 60;
type Spawn = Point & { kind: ZombieKind };
type Batch = { at: number; kinds: ZombieKind[] };

export class Simulation {
  readonly state: GameState;
  private nextId = 1;
  private fireCooldown = 0;
  private batches: Batch[] = [];
  private nextBatch = 0;
  private pending: Spawn[] = [];

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
      level: 1,
      spawned: 0,
      weapon: 'rifle',
      ammo: this.fullMagazines(),
      reloadRemaining: 0,
    };
    for (const [x, z] of [
      [-5, -6],
      [0, -9],
      [5, -5],
      [-2.5, -1],
      [2.8, 0],
      [-6.5, 1],
    ]) {
      this.state.zombies.push(this.createZombie('normal', x, z));
    }
  }

  start(): void {
    this.resetLevel(1, 'rifle');
  }

  retry(): void {
    if (this.state.phase === 'over' || this.state.phase === 'paused') {
      this.resetLevel(this.state.level, this.state.weapon);
    }
  }

  nextLevel(): void {
    if (this.state.phase === 'cleared') this.resetLevel(this.state.level + 1, this.state.weapon);
  }

  selectWeapon(weapon: WeaponId): void {
    if (this.state.phase !== 'playing' || weapon === this.state.weapon) return;
    this.state.weapon = weapon;
    this.state.reloadRemaining = 0;
  }

  reload(): GameEvent[] {
    const { weapon } = this.state;
    if (
      this.state.phase !== 'playing' ||
      this.state.reloadRemaining > 0 ||
      this.state.ammo[weapon] === WEAPONS[weapon].magazine
    )
      return [];
    this.state.reloadRemaining = WEAPONS[weapon].reloadTime;
    return [{ type: 'reload', weapon }];
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

  private fullMagazines(): Record<WeaponId, number> {
    return {
      rifle: WEAPONS.rifle.magazine,
      sniper: WEAPONS.sniper.magazine,
      shotgun: WEAPONS.shotgun.magazine,
    };
  }

  private resetLevel(level: number, weapon: WeaponId): void {
    this.nextId = 1;
    this.fireCooldown = 0;
    this.nextBatch = 0;
    this.pending = [];
    Object.assign(this.state, {
      phase: 'playing',
      player: { x: RULES.playerX, z: RULES.playerZ },
      hp: RULES.maxHp,
      kills: 0,
      elapsed: 0,
      shots: 0,
      hits: 0,
      zombies: [],
      level,
      spawned: 3,
      weapon,
      ammo: this.fullMagazines(),
      reloadRemaining: 0,
    });
    for (const [x, z] of [
      [-3, -4],
      [0, -1],
      [3.5, -6],
    ]) {
      this.state.zombies.push(this.createZombie('normal', x, z));
    }
    this.batches = this.planBatches();
  }

  private planBatches(): Batch[] {
    const level = LEVELS[this.state.level - 1];
    const kinds = (Object.entries(level.counts) as [ZombieKind, number][]).flatMap(
      ([kind, count]) => Array<ZombieKind>(count - (kind === 'normal' ? 3 : 0)).fill(kind),
    );
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    const batchCount = Math.ceil(kinds.length / level.batchSize);
    const earlySlots =
      Math.floor(((level.duration - 20 + EPSILON) / level.duration) * batchCount) * level.batchSize;
    // Move heavy enemies out of the final twenty seconds without changing the quota.
    let early = 0;
    for (let i = earlySlots; i < kinds.length; i++) {
      if (kinds[i] !== 'tank') continue;
      while (kinds[early] === 'tank') early++;
      [kinds[early], kinds[i]] = [kinds[i], kinds[early]];
      early++;
    }
    return Array.from({ length: batchCount }, (_, index) => ({
      at: ((index + 1) / batchCount) * level.duration,
      kinds: kinds.slice(index * level.batchSize, (index + 1) * level.batchSize),
    }));
  }

  private advance(dt: number, input: GameInput, events: GameEvent[]): void {
    this.state.elapsed += dt;
    if (this.state.reloadRemaining > 0) {
      this.state.reloadRemaining = Math.max(0, this.state.reloadRemaining - dt);
      if (this.state.reloadRemaining <= EPSILON) {
        this.state.reloadRemaining = 0;
        this.state.ammo[this.state.weapon] = WEAPONS[this.state.weapon].magazine;
        events.push({ type: 'loaded', weapon: this.state.weapon });
      }
    }
    if (this.state.ammo[this.state.weapon] === 0 && this.state.reloadRemaining === 0) {
      events.push(...this.reload());
    }
    const canFire =
      input.firing && input.aim.z < this.state.player.z && this.state.reloadRemaining === 0;
    if (canFire && this.fireCooldown <= EPSILON) {
      this.shoot(input.aim, events);
      this.fireCooldown += WEAPONS[this.state.weapon].fireInterval;
      if (this.state.ammo[this.state.weapon] === 0) events.push(...this.reload());
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
    this.spawnDue();
    if (
      this.state.spawned === levelTotal(LEVELS[this.state.level - 1]) &&
      !this.state.zombies.some((zombie) => zombie.hp > 0)
    ) {
      const final = this.state.level === LEVELS.length;
      this.state.phase = final ? 'victory' : 'cleared';
      events.push({ type: 'clear', level: this.state.level, final });
    }
  }

  private spawnDue(): void {
    while (
      this.nextBatch < this.batches.length &&
      this.batches[this.nextBatch].at <= this.state.elapsed + EPSILON
    ) {
      const batch = this.batches[this.nextBatch++];
      const center = this.random() * 12 - 6;
      for (const kind of batch.kinds) {
        this.pending.push({
          kind,
          x: Math.max(-8, Math.min(8, center + this.random() * 4 - 2)),
          z: -17 - this.random() * 4,
        });
      }
    }
    let living = this.state.zombies.filter((zombie) => zombie.hp > 0).length;
    while (this.pending.length && living < RULES.maxZombies) {
      const spawn = this.pending.shift()!;
      this.state.zombies.push(this.createZombie(spawn.kind, spawn.x, spawn.z));
      this.state.spawned++;
      living++;
    }
  }

  private createZombie(kind: ZombieKind, x: number, z: number): Zombie {
    const definition = ZOMBIES[kind];
    return {
      id: this.nextId++,
      kind,
      x,
      z,
      hp: definition.hp,
      maxHp: definition.hp,
      radius: definition.radius,
      speed: definition.speed,
      attackCooldown: 0,
      hitTime: 0,
      deadTime: -1,
      variant: Math.floor(this.random() * 3),
    };
  }

  private intersection(zombie: Zombie, direction: Point): number | null {
    const dx = zombie.x - this.state.player.x;
    const dz = zombie.z - this.state.player.z;
    const along = dx * direction.x + dz * direction.z;
    const perpendicularSquared = dx * dx + dz * dz - along * along;
    if (perpendicularSquared > zombie.radius * zombie.radius) return null;
    const halfChord = Math.sqrt(Math.max(0, zombie.radius * zombie.radius - perpendicularSquared));
    return along + halfChord < 0 ? null : Math.max(0, along - halfChord);
  }

  private shoot(aim: Point, events: GameEvent[]): void {
    const { weapon } = this.state;
    const definition = WEAPONS[weapon];
    const from = { ...this.state.player };
    const length = Math.hypot(aim.x - from.x, aim.z - from.z);
    const direction = { x: (aim.x - from.x) / length, z: (aim.z - from.z) / length };
    let targets: Zombie[];
    let hitDistance: number = definition.range;
    if (weapon === 'shotgun') {
      targets = this.state.zombies.filter((zombie) => {
        if (zombie.hp <= 0) return false;
        const dx = zombie.x - from.x;
        const dz = zombie.z - from.z;
        const distance = Math.hypot(dx, dz);
        return (
          distance <= definition.range + EPSILON &&
          dx * direction.x + dz * direction.z >= distance * Math.cos(definition.halfAngle) - EPSILON
        );
      });
    } else {
      const intersections = this.state.zombies
        .filter((zombie) => zombie.hp > 0)
        .map((zombie) => ({ zombie, distance: this.intersection(zombie, direction) }))
        .filter(
          (hit): hit is { zombie: Zombie; distance: number } =>
            hit.distance !== null && hit.distance <= definition.range,
        )
        .sort((a, b) => a.distance - b.distance)
        .slice(0, definition.penetration);
      targets = intersections.map((hit) => hit.zombie);
      if (intersections.length === definition.penetration)
        hitDistance = intersections.at(-1)!.distance;
    }
    this.state.ammo[weapon]--;
    this.state.shots++;
    if (targets.length) this.state.hits++;
    events.push({
      type: 'shot',
      weapon,
      from,
      to: { x: from.x + direction.x * hitDistance, z: from.z + direction.z * hitDistance },
      hit: targets.length > 0,
    });
    for (const zombie of targets) {
      zombie.hp = Math.max(0, zombie.hp - definition.damage);
      zombie.hitTime = 0.16;
      const killed = zombie.hp === 0;
      if (killed) {
        zombie.deadTime = 0;
        this.state.kills++;
      }
      events.push({ type: 'hit', at: { x: zombie.x, z: zombie.z }, killed });
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
    for (const zombie of living)
      zombie.z = Math.min(zombie.z, this.state.player.z - zombie.radius * 2);
  }
}
