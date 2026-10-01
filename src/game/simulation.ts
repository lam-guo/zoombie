import {
  BOSS_PART_RADIUS,
  BOSSES,
  KILL_REWARDS,
  LEVEL_REWARDS,
  LEVELS,
  RULES,
  WEAPONS,
  WEAPON_IDS,
  ZOMBIES,
  levelTotal,
  bossPartPosition,
  type Boss,
  type BossKind,
  type GameEvent,
  type GameInput,
  type GameState,
  type Point,
  type WeaponId,
  type Zombie,
  type ZombieKind,
} from './types';
import {
  createProgress,
  getDamageMultiplier,
  getMaxHp,
  getReloadMultiplier,
  MAX_COINS,
  purchase as buyItem,
  type Progress,
  type ShopItemId,
} from './economy';

const EPSILON = 1e-8;
const MAX_STEP = 1 / 60;
type Spawn = Point & { kind: ZombieKind };
type Batch = { at: number; kinds: ZombieKind[]; horde?: boolean };
type Target = {
  entity: Zombie | Boss;
  at: Point;
  radius: number;
  part?: Boss['parts'][number];
  blocked?: boolean;
};

export class Simulation {
  readonly state: GameState;
  private nextId = 1;
  private nextGrenadeId = 1;
  private fireCooldown = 0;
  private batches: Batch[] = [];
  private nextBatch = 0;
  private pending: Spawn[] = [];

  constructor(
    private readonly random: () => number = Math.random,
    progress: Progress = createProgress(),
  ) {
    this.state = {
      phase: 'ready',
      player: { x: RULES.playerX, z: RULES.playerZ },
      hp: getMaxHp(progress),
      maxHp: getMaxHp(progress),
      progress,
      earnedCoins: 0,
      invulnerable: 0,
      kills: 0,
      elapsed: 0,
      shots: 0,
      hits: 0,
      zombies: [],
      boss: null,
      level: 1,
      spawned: 0,
      weapon: 'rifle',
      ammo: this.fullMagazines(),
      reloadRemaining: 0,
      reserve: { ...LEVELS[0].reserve },
      autoFire: false,
      autoAim: null,
      grenades: [],
      hordeRemaining: 0,
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
      this.state.ammo[weapon] === WEAPONS[weapon].magazine ||
      this.state.reserve[weapon] <= 0
    )
      return [];
    this.state.reloadRemaining =
      WEAPONS[weapon].reloadTime * getReloadMultiplier(this.state.progress);
    return [{ type: 'reload', weapon }];
  }

  purchase(item: ShopItemId): boolean {
    if (!['ready', 'cleared', 'victory', 'over'].includes(this.state.phase)) return false;
    if (!buyItem(this.state.progress, item)) return false;
    this.state.maxHp = getMaxHp(this.state.progress);
    return true;
  }

  useMedkit(): GameEvent[] {
    if (
      this.state.phase !== 'playing' ||
      this.state.hp >= this.state.maxHp ||
      this.state.progress.medkits === 0
    )
      return [];
    this.state.progress.medkits--;
    this.state.hp = Math.min(this.state.maxHp, this.state.hp + 50);
    return [{ type: 'heal' }];
  }

  setAutoFire(enabled: boolean): void {
    this.state.autoFire = enabled;
    if (!enabled) this.state.autoAim = null;
  }

  throwGrenade(aim: GameInput['aim']): GameEvent[] {
    if (
      this.state.phase !== 'playing' ||
      this.state.progress.grenades <= 0 ||
      this.state.grenades.length ||
      !Number.isFinite(aim.x) ||
      !Number.isFinite(aim.z) ||
      (aim.y !== undefined && !Number.isFinite(aim.y)) ||
      aim.z >= this.state.player.z
    )
      return [];
    const from = { ...this.state.player };
    const dx = aim.x - from.x;
    const dz = aim.z - from.z;
    const scale = Math.min(1, RULES.grenadeRange / Math.hypot(dx, dz));
    const to = { x: from.x + dx * scale, z: from.z + dz * scale, bossPart: aim.bossPart };
    this.state.progress.grenades--;
    this.state.grenades.push({
      id: this.nextGrenadeId++,
      from,
      to,
      elapsed: 0,
      duration: RULES.grenadeDuration,
      radius: RULES.grenadeRadius,
    });
    return [
      {
        type: 'grenadeThrown',
        from,
        to,
        duration: RULES.grenadeDuration,
        radius: RULES.grenadeRadius,
      },
    ];
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
    this.nextGrenadeId = 1;
    this.fireCooldown = 0;
    this.nextBatch = 0;
    this.pending = [];
    Object.assign(this.state, {
      phase: 'playing',
      player: { x: RULES.playerX, z: RULES.playerZ },
      hp: getMaxHp(this.state.progress),
      maxHp: getMaxHp(this.state.progress),
      earnedCoins: 0,
      invulnerable: 0,
      kills: 0,
      elapsed: 0,
      shots: 0,
      hits: 0,
      zombies: [],
      boss: null,
      level,
      spawned: 3,
      weapon,
      ammo: this.fullMagazines(),
      reloadRemaining: 0,
      reserve: { ...LEVELS[level - 1].reserve },
      autoAim: null,
      grenades: [],
      hordeRemaining: 0,
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
    const batches: Batch[] = Array.from({ length: batchCount }, (_, index) => ({
      at: ((index + 1) / batchCount) * level.duration,
      kinds: kinds.slice(index * level.batchSize, (index + 1) * level.batchSize),
    }));
    const hordeIndex = Math.min(batchCount - 3, Math.floor(batchCount * 0.4));
    batches[hordeIndex].kinds.push(...batches[hordeIndex + 1].kinds);
    batches[hordeIndex].horde = true;
    batches.splice(hordeIndex + 1, 1);
    return batches;
  }

  private advance(dt: number, input: GameInput, events: GameEvent[]): void {
    this.state.elapsed += dt;
    this.state.invulnerable = Math.max(0, this.state.invulnerable - dt);
    this.state.hordeRemaining = Math.max(0, this.state.hordeRemaining - dt);
    this.spawnBoss();
    this.advanceGrenades(dt, events);
    const loadedRound = this.advanceReload(dt, events);
    if (
      this.state.autoFire &&
      this.state.ammo[this.state.weapon] + this.state.reserve[this.state.weapon] === 0
    )
      this.cycleWeapon();
    const activeInput = this.state.autoFire ? this.autoInput() : input;
    if (this.state.ammo[this.state.weapon] === 0 && this.state.reloadRemaining === 0)
      events.push(...this.reload());
    const wantsShot = activeInput.firing && activeInput.aim.z < this.state.player.z;
    if (
      wantsShot &&
      this.fireCooldown <= EPSILON &&
      this.state.ammo[this.state.weapon] > 0 &&
      WEAPONS[this.state.weapon].reloadType === 'round'
    )
      this.state.reloadRemaining = 0;
    const canFire =
      wantsShot && this.state.reloadRemaining === 0 && this.state.ammo[this.state.weapon] > 0;
    if (canFire && this.fireCooldown <= EPSILON) {
      this.shoot(activeInput.aim, events);
      this.fireCooldown += WEAPONS[this.state.weapon].fireInterval;
      if (this.state.ammo[this.state.weapon] === 0) events.push(...this.reload());
    }
    if (loadedRound && !canFire) events.push(...this.reload());
    this.fireCooldown -= dt;
    if (!canFire) this.fireCooldown = Math.max(0, this.fireCooldown);

    for (const zombie of this.state.zombies) {
      zombie.hitTime = Math.max(0, zombie.hitTime - dt);
      zombie.dodgeRemaining = Math.max(0, zombie.dodgeRemaining - dt);
      const staggered = zombie.staggerRemaining > EPSILON;
      zombie.staggerRemaining = Math.max(0, zombie.staggerRemaining - dt);
      if (zombie.hp <= 0) {
        zombie.deadTime += dt;
        continue;
      }
      zombie.attackCooldown = Math.max(0, zombie.attackCooldown - dt);
      if (staggered) continue;
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
        this.damagePlayer(RULES.attackDamage, events);
        if (this.state.phase === 'over') break;
      }
    }
    this.state.zombies = this.state.zombies.filter(
      (zombie) => zombie.hp > 0 || zombie.deadTime < RULES.corpseLifetime - EPSILON,
    );
    if (this.state.phase === 'over') return;
    this.advanceBoss(dt, events);
    if (this.state.hp === 0) return;
    this.separateZombies();
    this.spawnDue(events);
    if (
      this.state.spawned === levelTotal(LEVELS[this.state.level - 1]) &&
      !this.state.zombies.some((zombie) => zombie.hp > 0) &&
      (!this.bossKind() || this.state.boss?.hp === 0)
    ) {
      const final = this.state.level === LEVELS.length;
      this.state.phase = final ? 'victory' : 'cleared';
      this.state.grenades = [];
      this.state.autoAim = null;
      this.awardCoins(LEVEL_REWARDS[this.state.level - 1], events);
      events.push({ type: 'clear', level: this.state.level, final });
    }
  }

  private advanceReload(dt: number, events: GameEvent[]): boolean {
    if (this.state.reloadRemaining <= 0) return false;
    this.state.reloadRemaining = Math.max(0, this.state.reloadRemaining - dt);
    if (this.state.reloadRemaining > EPSILON) return false;
    this.state.reloadRemaining = 0;
    const weapon = this.state.weapon;
    const definition = WEAPONS[weapon];
    const amount = Math.min(
      this.state.reserve[weapon],
      definition.reloadType === 'round' ? 1 : definition.magazine - this.state.ammo[weapon],
    );
    this.state.ammo[weapon] += amount;
    this.state.reserve[weapon] -= amount;
    if (amount > 0) events.push({ type: 'loaded', weapon });
    return definition.reloadType === 'round';
  }

  private cycleWeapon(): void {
    const index = WEAPON_IDS.indexOf(this.state.weapon);
    for (let offset = 1; offset < WEAPON_IDS.length; offset++) {
      const weapon = WEAPON_IDS[(index + offset) % WEAPON_IDS.length];
      if (this.state.ammo[weapon] + this.state.reserve[weapon] > 0) {
        this.selectWeapon(weapon);
        return;
      }
    }
  }

  private autoInput(): GameInput {
    const points: { aim: GameInput['aim']; radius: number; distance: number }[] = this.state.zombies
      .filter((zombie) => zombie.hp > 0)
      .map((zombie) => ({
        aim: { x: zombie.x, z: zombie.z },
        radius: zombie.radius,
        distance: Math.hypot(zombie.x - this.state.player.x, zombie.z - this.state.player.z),
      }));
    const boss = this.state.boss;
    if (boss && boss.hp > 0) {
      const parts = boss.parts.filter((part) => part.hp > 0);
      const targets = parts.length
        ? parts.map((part) => ({ aim: bossPartPosition(boss, part.id), radius: BOSS_PART_RADIUS }))
        : [{ aim: { x: boss.x, y: 1.5, z: boss.z }, radius: BOSSES[boss.kind].radius }];
      for (const target of targets)
        points.push({
          ...target,
          distance: Math.hypot(
            target.aim.x - this.state.player.x,
            target.aim.z - this.state.player.z,
          ),
        });
    }
    points.sort((a, b) => a.distance - b.distance);
    const find = (weapon: WeaponId) =>
      this.state.ammo[weapon] + this.state.reserve[weapon] > 0
        ? points.find(
            (point) =>
              point.aim.z < this.state.player.z &&
              point.distance - point.radius <= WEAPONS[weapon].range,
          )
        : undefined;
    let target = find(this.state.weapon);
    if (!target && this.state.reloadRemaining === 0) {
      for (const weapon of WEAPON_IDS) {
        target = find(weapon);
        if (target) {
          this.selectWeapon(weapon);
          break;
        }
      }
    }
    this.state.autoAim = target?.aim ?? null;
    return { aim: target?.aim ?? { x: 0, z: -10 }, firing: Boolean(target) };
  }

  private advanceGrenades(dt: number, events: GameEvent[]): void {
    for (const grenade of this.state.grenades) {
      grenade.elapsed += dt;
      if (grenade.elapsed + EPSILON < grenade.duration) continue;
      events.push({ type: 'explosion', at: grenade.to, radius: grenade.radius });
      const within = (at: Point, radius: number) =>
        Math.hypot(at.x - grenade.to.x, at.z - grenade.to.z) <= grenade.radius + radius;
      for (const zombie of this.state.zombies) {
        if (zombie.hp > 0 && within(zombie, zombie.radius))
          this.damageTarget(
            { entity: zombie, at: { x: zombie.x, z: zombie.z }, radius: zombie.radius },
            RULES.grenadeDamage,
            events,
          );
      }
      const boss = this.state.boss;
      if (!boss || boss.hp <= 0) continue;
      const parts = boss.parts
        .filter((part) => part.hp > 0 && within(bossPartPosition(boss, part.id), BOSS_PART_RADIUS))
        .sort(
          (a, b) =>
            Number(b.id === grenade.to.bossPart) - Number(a.id === grenade.to.bossPart) ||
            Math.hypot(
              bossPartPosition(boss, a.id).x - grenade.to.x,
              bossPartPosition(boss, a.id).z - grenade.to.z,
            ) -
              Math.hypot(
                bossPartPosition(boss, b.id).x - grenade.to.x,
                bossPartPosition(boss, b.id).z - grenade.to.z,
              ),
        );
      const part = parts[0];
      if (part)
        this.damageTarget(
          { entity: boss, at: bossPartPosition(boss, part.id), radius: BOSS_PART_RADIUS, part },
          RULES.grenadePartDamage,
          events,
        );
      else if (within(boss, BOSSES[boss.kind].radius))
        this.damageTarget(
          {
            entity: boss,
            at: { x: boss.x, y: 1.5, z: boss.z },
            radius: BOSSES[boss.kind].radius,
            blocked: boss.parts.some((part) => part.hp > 0),
          },
          RULES.grenadeBossDamage,
          events,
        );
    }
    this.state.grenades = this.state.grenades.filter(
      (grenade) => grenade.elapsed + EPSILON < grenade.duration,
    );
  }

  private bossKind(): BossKind | undefined {
    return (Object.keys(BOSSES) as BossKind[]).find(
      (kind) => BOSSES[kind].level === this.state.level,
    );
  }

  private spawnBoss(): void {
    const kind = this.bossKind();
    if (!kind || this.state.boss || this.state.elapsed + EPSILON < BOSSES[kind].spawnAt) return;
    const definition = BOSSES[kind];
    this.state.boss = {
      kind,
      x: 0,
      z: -18,
      hp: definition.hp,
      maxHp: definition.hp,
      parts: kind === 'brood' ? [0, 1, 2].map((id) => ({ id, hp: 240, maxHp: 240 })) : [],
      attackRemaining: definition.attackInterval,
      deadTime: -1,
      hitTime: 0,
    };
  }

  private advanceBoss(dt: number, events: GameEvent[]): void {
    const boss = this.state.boss;
    if (!boss) return;
    boss.hitTime = Math.max(0, boss.hitTime - dt);
    if (boss.hp <= 0) {
      boss.deadTime += dt;
      return;
    }
    const definition = BOSSES[boss.kind];
    if (boss.z < definition.stopZ) {
      boss.z = Math.min(definition.stopZ, boss.z + definition.speed * dt);
      return;
    }
    const before = boss.attackRemaining;
    boss.attackRemaining -= dt;
    if (before > 2 + EPSILON && boss.attackRemaining <= 2 + EPSILON)
      events.push({ type: 'bossWarning' });
    if (boss.attackRemaining <= EPSILON) {
      boss.attackRemaining += definition.attackInterval;
      this.damagePlayer(definition.attackDamage, events);
    }
  }

  private damagePlayer(damage: number, events: GameEvent[]): void {
    if (this.state.invulnerable > EPSILON) return;
    const absorbed = Math.min(this.state.progress.armor, damage);
    this.state.progress.armor -= absorbed;
    this.state.hp = Math.max(0, this.state.hp - (damage - absorbed));
    events.push({ type: 'hurt', hp: this.state.hp });
    if (this.state.hp > 0) return;
    if (this.state.progress.revive) {
      this.state.progress.revive = false;
      this.state.hp = this.state.maxHp;
      this.state.invulnerable = 3;
      events.push({ type: 'revive' });
    } else {
      this.state.phase = 'over';
      events.push({ type: 'over' });
    }
  }

  private awardCoins(amount: number, events: GameEvent[], at?: Point): void {
    const credited = Math.min(amount, MAX_COINS - this.state.progress.coins);
    if (credited <= 0) return;
    this.state.progress.coins += credited;
    this.state.earnedCoins += credited;
    events.push({ type: 'coins', amount: credited, ...(at ? { at } : {}) });
  }

  private spawnDue(events: GameEvent[]): void {
    while (
      this.nextBatch < this.batches.length &&
      this.batches[this.nextBatch].at <= this.state.elapsed + EPSILON
    ) {
      const batch = this.batches[this.nextBatch++];
      if (batch.horde) {
        this.state.hordeRemaining = 8;
        events.push({ type: 'horde', duration: 8 });
      }
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
      staggerRemaining: 0,
      dodgeRemaining: 0,
      dodgeStreak: 0,
    };
  }

  private intersection(at: Point, radius: number, direction: Point): number | null {
    const dx = at.x - this.state.player.x;
    const dz = at.z - this.state.player.z;
    const along = dx * direction.x + dz * direction.z;
    const perpendicularSquared = dx * dx + dz * dz - along * along;
    if (perpendicularSquared > radius * radius) return null;
    const halfChord = Math.sqrt(Math.max(0, radius * radius - perpendicularSquared));
    return along + halfChord < 0 ? null : Math.max(0, along - halfChord);
  }

  private targetDistance(
    at: Point,
    radius: number,
    direction: Point,
    weapon = this.state.weapon,
  ): number | null {
    const definition = WEAPONS[weapon];
    if (weapon !== 'shotgun') {
      const distance = this.intersection(at, radius, direction);
      return distance !== null && distance <= definition.range ? distance : null;
    }
    const dx = at.x - this.state.player.x;
    const dz = at.z - this.state.player.z;
    const distance = Math.hypot(dx, dz);
    if (distance > definition.range + radius + EPSILON) return null;
    const along = dx * direction.x + dz * direction.z;
    const angle = Math.acos(Math.max(-1, Math.min(1, along / Math.max(EPSILON, distance))));
    return angle <=
      definition.halfAngle + Math.asin(Math.min(1, radius / Math.max(EPSILON, distance))) + EPSILON
      ? Math.max(0, distance - radius)
      : null;
  }

  private shoot(aim: GameInput['aim'], events: GameEvent[]): void {
    const { weapon, boss } = this.state;
    const definition = WEAPONS[weapon];
    const from = { ...this.state.player, ...(aim.y === undefined ? {} : { y: 1.5 }) };
    const length = Math.hypot(aim.x - from.x, aim.z - from.z);
    const direction = { x: (aim.x - from.x) / length, z: (aim.z - from.z) / length };
    const candidates: Target[] = this.state.zombies
      .filter((zombie) => zombie.hp > 0)
      .map((zombie) => ({
        entity: zombie,
        at: { x: zombie.x, z: zombie.z },
        radius: zombie.radius,
      }));
    if (boss && boss.hp > 0) {
      const part = boss.parts.find((part) => part.id === aim.bossPart && part.hp > 0);
      const partAt = part ? bossPartPosition(boss, part.id) : null;
      if (part && partAt && this.targetDistance(partAt, BOSS_PART_RADIUS, direction) !== null) {
        candidates.push({ entity: boss, at: partAt, radius: BOSS_PART_RADIUS, part });
      } else {
        candidates.push({
          entity: boss,
          at: { x: boss.x, z: boss.z, y: 1.5 },
          radius: BOSSES[boss.kind].radius,
          blocked:
            boss.kind === 'brood' &&
            (aim.bossPart !== undefined || boss.parts.some((part) => part.hp > 0)),
        });
      }
    }
    let intersections = candidates
      .map((target) => ({
        target,
        distance: this.targetDistance(target.at, target.radius, direction),
      }))
      .filter((hit): hit is { target: Target; distance: number } => hit.distance !== null)
      .sort((a, b) => a.distance - b.distance);
    if (weapon === 'rifle') intersections = intersections.slice(0, 1);
    const damage = definition.damage * getDamageMultiplier(this.state.progress, weapon);
    let budget = damage;
    let hitDistance: number = definition.range;
    const impacts: Point[] = [];
    const firstEvent = events.length;
    for (const { target, distance } of intersections) {
      const entity = target.entity;
      if (
        !('parts' in entity) &&
        entity.kind === 'small' &&
        entity.dodgeStreak < 2 &&
        this.random() < 0.15
      ) {
        entity.dodgeStreak++;
        entity.dodgeRemaining = 0.3;
        events.push({ type: 'dodge', at: target.at });
        if (weapon === 'rifle') hitDistance = distance;
        continue;
      }
      const result = this.damageTarget(
        target,
        weapon === 'sniper' ? budget : damage,
        events,
        weapon,
      );
      impacts.push(target.at);
      if (weapon === 'rifle') hitDistance = distance;
      if (weapon === 'sniper') {
        budget = Math.max(0, budget - result.used);
        if (target.blocked || !result.killed || budget <= EPSILON) {
          hitDistance = distance;
          break;
        }
      }
    }
    this.state.ammo[weapon]--;
    this.state.shots++;
    if (impacts.length) this.state.hits++;
    const to = {
      x: from.x + direction.x * hitDistance,
      z: from.z + direction.z * hitDistance,
      ...(aim.y === undefined ? {} : { y: 1.5 + ((aim.y - 1.5) * hitDistance) / length }),
    };
    const traces =
      weapon === 'shotgun'
        ? Array.from({ length: 9 }, (_, index) => {
            if (impacts[index]) return { to: impacts[index], hit: true };
            const angle =
              Math.atan2(direction.x, direction.z) -
              definition.halfAngle +
              (index / 8) * definition.halfAngle * 2;
            return {
              to: {
                x: from.x + Math.sin(angle) * definition.range,
                z: from.z + Math.cos(angle) * definition.range,
                y: to.y,
              },
              hit: false,
            };
          })
        : undefined;
    events.splice(firstEvent, 0, {
      type: 'shot',
      weapon,
      from,
      to,
      hit: impacts.length > 0,
      ...(traces ? { traces } : {}),
    });
  }

  private damageTarget(
    target: Target,
    damage: number,
    events: GameEvent[],
    weapon?: WeaponId,
  ): { used: number; killed: boolean } {
    const { entity, at, part, blocked } = target;
    entity.hitTime = 0.16;
    if (blocked) {
      events.push({ type: 'hit', at, killed: false });
      return { used: 0, killed: false };
    }
    const multiplier =
      'parts' in entity && entity.kind === 'bulwark' && weapon
        ? weapon === 'sniper'
          ? 1.5
          : 0.5
        : 1;
    const victim = part ?? entity;
    const before = victim.hp;
    victim.hp = Math.max(0, victim.hp - damage * multiplier);
    if (victim.hp < EPSILON) victim.hp = 0;
    if ('parts' in entity) {
      if (part) {
        if (part.hp === 0) events.push({ type: 'bossBreak', at, part: part.id });
      } else if (entity.hp === 0) {
        entity.deadTime = 0;
        this.awardCoins(BOSSES[entity.kind].reward, events, at);
      }
    } else {
      entity.staggerRemaining = ZOMBIES[entity.kind].stagger;
      entity.dodgeStreak = 0;
      if (entity.hp === 0) {
        entity.deadTime = 0;
        this.state.kills++;
        this.awardCoins(KILL_REWARDS[entity.kind], events, at);
      }
    }
    events.push({ type: 'hit', at: { ...at }, killed: entity.hp === 0 });
    return { used: (before - victim.hp) / multiplier, killed: victim.hp === 0 };
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
