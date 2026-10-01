import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { createProgress, MAX_COINS } from './economy';
import {
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
  type GameInput,
  type Phase,
  type Zombie,
  type ZombieKind,
} from './types';

const idle: GameInput = { firing: false, aim: { x: 0, z: -10 } };
const firing: GameInput = { ...idle, firing: true };

function setup(level = 1): Simulation {
  const simulation = new Simulation(() => 0.5);
  simulation.start();
  while (simulation.state.level < level) {
    simulation.state.phase = 'cleared';
    simulation.nextLevel();
  }
  simulation.state.zombies = [];
  return simulation;
}

function target(id: number, x = 0, z = 0, kind: ZombieKind = 'normal'): Zombie {
  const definition = ZOMBIES[kind];
  return {
    id,
    kind,
    x,
    z,
    hp: definition.hp,
    maxHp: definition.hp,
    radius: definition.radius,
    speed: 0,
    attackCooldown: 0,
    hitTime: 0,
    deadTime: -1,
    variant: 0,
  };
}

describe('weapons and combat', () => {
  it('shows a static ready scene and counts the three normal opening enemies', () => {
    const simulation = new Simulation(() => 0.5);
    expect(simulation.state.phase).toBe('ready');
    expect(simulation.state.zombies).toHaveLength(6);
    const before = structuredClone(simulation.state);
    expect(simulation.step(10, firing)).toEqual([]);
    expect(simulation.state).toEqual(before);
    simulation.start();
    expect(simulation.state.zombies).toHaveLength(3);
    expect(simulation.state.spawned).toBe(3);
    expect(
      simulation.state.zombies.every(
        (zombie) => zombie.kind === 'normal' && zombie.deadTime === -1,
      ),
    ).toBe(true);
  });

  it('fires immediately at five shots a second and kills a normal enemy on the third hit', () => {
    const simulation = setup();
    const zombie = target(1);
    simulation.state.zombies.push(zombie);
    expect(simulation.step(0.2, firing).filter((event) => event.type === 'shot')).toHaveLength(1);
    expect(zombie.hp).toBe(50);
    simulation.step(0.2, firing);
    expect(zombie.hp).toBe(25);
    expect(simulation.step(0.2, firing)).toContainEqual({
      type: 'hit',
      at: { x: 0, z: 0 },
      killed: true,
    });
    expect(zombie.hp).toBe(0);
    simulation.step(0.4, firing);
    expect(simulation.state.shots).toBe(5);
    expect(simulation.state.hits).toBe(3);
    expect(simulation.state.kills).toBe(1);
    expect(simulation.state.ammo.rifle).toBe(25);
  });

  it('rifle hits the nearest living circle only, then shoots through its corpse', () => {
    const simulation = setup();
    const near = target(1, 0, 3);
    const far = target(2, 0, -3);
    near.hp = 25;
    simulation.state.zombies.push(far, near);
    const shot = simulation.step(0.2, firing).find((event) => event.type === 'shot');
    expect(near.hp).toBe(0);
    expect(far.hp).toBe(75);
    expect(shot?.type === 'shot' && shot.to.z).toBeCloseTo(3.48);
    simulation.step(0.2, firing);
    expect(far.hp).toBe(50);
    expect(simulation.state.kills).toBe(1);
  });

  it('sniper penetrates exactly three living targets in distance order and counts one accurate shot', () => {
    const simulation = setup();
    simulation.selectWeapon('sniper');
    const near = target(1, 0, 4, 'tank');
    const middle = target(2, 0, 2);
    const third = target(3, 0, 0);
    const fourth = target(4, 0, -2);
    const offAxis = target(5, 1.5, 1);
    simulation.state.zombies.push(fourth, third, offAxis, middle, near);
    const events = simulation.step(0.01, firing);
    expect([near.hp, middle.hp, third.hp, fourth.hp, offAxis.hp]).toEqual([20, 0, 0, 75, 75]);
    expect(events.filter((event) => event.type === 'hit')).toHaveLength(3);
    const shot = events.find((event) => event.type === 'shot');
    expect(shot?.type === 'shot' && shot.to.z).toBeCloseTo(0.48);
    expect(simulation.state.shots).toBe(1);
    expect(simulation.state.hits).toBe(1);
    expect(simulation.state.ammo.sniper).toBe(4);
    simulation.step(1.17, firing);
    expect(near.hp).toBe(0);
    expect(fourth.hp).toBe(0);
    expect(simulation.state.hits).toBe(2);
  });

  it('shotgun damages every target inside its finite cone once per shell', () => {
    const simulation = setup();
    simulation.selectWeapon('shotgun');
    const near = target(1, 0, 4);
    const inside = target(2, 1.2, 2);
    const edge = target(3, 0, -2);
    const outside = target(4, 2, 2);
    const tooFar = target(5, 0, -2.01);
    const behind = target(6, 0, 10);
    simulation.state.zombies.push(near, inside, edge, outside, tooFar, behind);
    const events = simulation.step(0.01, firing);
    expect([near.hp, inside.hp, edge.hp]).toEqual([0, 0, 0]);
    expect([outside.hp, tooFar.hp, behind.hp]).toEqual([75, 75, 75]);
    expect(events.filter((event) => event.type === 'hit')).toHaveLength(3);
    expect(simulation.state.kills).toBe(3);
    expect(simulation.state.hits).toBe(1);
    expect(simulation.state.shots).toBe(1);
    expect(simulation.state.ammo.shotgun).toBe(5);
  });

  it('uses the smaller hitbox, limits rifle range and rejects backward shooting', () => {
    const simulation = setup();
    const small = target(1, 0.35, 0, 'small');
    const normal = target(2, 0.35, -3);
    const outOfRange = target(3, 0, -34);
    simulation.state.zombies.push(small, normal, outOfRange);
    simulation.step(0.2, firing);
    expect(small.hp).toBe(50);
    expect(normal.hp).toBe(50);
    expect(outOfRange.hp).toBe(75);
    expect(simulation.step(0.2, { firing: true, aim: { x: 2, z: 8 } })).toEqual([]);
    expect(simulation.state.shots).toBe(1);
    simulation.state.zombies = [outOfRange];
    expect(simulation.step(0.2, firing)).toEqual([
      { type: 'shot', weapon: 'rifle', from: { x: 0, z: 7 }, to: { x: 0, z: -33 }, hit: false },
    ]);
  });

  it('kills before attacking in the same frame and removes expired corpses', () => {
    const simulation = setup();
    const zombie = target(1, 0, 6);
    zombie.hp = 25;
    simulation.state.zombies.push(zombie);
    expect(simulation.step(0.01, firing).some((event) => event.type === 'hurt')).toBe(false);
    expect(simulation.state.hp).toBe(100);
    expect(zombie.deadTime).toBeCloseTo(0.01);
    simulation.step(1.49, idle);
    expect(simulation.state.zombies).not.toContain(zombie);
    expect(simulation.state.hp).toBe(100);
  });

  it('approaches, stops, and attacks at fixed intervals', () => {
    const simulation = setup();
    const zombie = target(1, 0, 5);
    zombie.speed = 1;
    simulation.state.zombies.push(zombie);
    simulation.step(0.5, idle);
    expect(simulation.state.hp).toBe(100);
    simulation.step(0.1, idle);
    expect(zombie.z).toBeCloseTo(7 - RULES.attackDistance);
    expect(simulation.state.hp).toBe(90);
    simulation.step(0.9, idle);
    expect(simulation.state.hp).toBe(90);
    simulation.step(0.1, idle);
    expect(simulation.state.hp).toBe(80);
  });

  it('stops subsequent attacks and all clocks immediately when the player dies', () => {
    const simulation = setup();
    simulation.state.hp = 10;
    simulation.state.zombies.push(target(1, 0, 6), target(2, 0.2, 6));
    expect(simulation.step(5, idle)).toEqual([{ type: 'hurt', hp: 0 }, { type: 'over' }]);
    const before = structuredClone(simulation.state);
    simulation.resume();
    expect(simulation.step(10, firing)).toEqual([]);
    expect(simulation.state).toEqual(before);
  });

  it('separates overlapping enemies and keeps crowded targets in front of the player', () => {
    const simulation = setup();
    simulation.state.hp = 1e9;
    const a = target(1);
    const b = target(2);
    simulation.state.zombies.push(a, b);
    simulation.step(0.01, idle);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.6);
    simulation.state.zombies = Array.from({ length: 30 }, (_, index) =>
      target(index + 1, 0, 5.55 - index * 0.1),
    );
    simulation.step(2, idle);
    expect(simulation.state.zombies.every((zombie) => zombie.z < simulation.state.player.z)).toBe(
      true,
    );
  });
});

describe('magazines, switching and paused time', () => {
  it.each(WEAPON_IDS)(
    '%s automatically reloads an empty magazine and resumes held fire',
    (weapon) => {
      const simulation = setup();
      simulation.selectWeapon(weapon);
      simulation.state.ammo[weapon] = 1;
      const events = simulation.step(0.01, firing);
      expect(events).toContainEqual({ type: 'reload', weapon });
      expect(simulation.state.ammo[weapon]).toBe(0);
      expect(simulation.state.reloadRemaining).toBe(WEAPONS[weapon].reloadTime);
      simulation.step(WEAPONS[weapon].reloadTime - 0.01, firing);
      expect(simulation.state.shots).toBe(1);
      const loaded = simulation.step(0.02, firing);
      expect(loaded).toContainEqual({ type: 'loaded', weapon });
      expect(simulation.state.shots).toBe(2);
      expect(simulation.state.ammo[weapon]).toBe(WEAPONS[weapon].magazine - 1);
    },
  );

  it('manual reload preserves remaining ammunition until completion and cannot be restarted by key spam', () => {
    const simulation = setup();
    expect(simulation.reload()).toEqual([]);
    simulation.step(0.4, firing);
    expect(simulation.state.ammo.rifle).toBe(28);
    expect(simulation.reload()).toEqual([{ type: 'reload', weapon: 'rifle' }]);
    simulation.step(0.5, firing);
    expect(simulation.state.shots).toBe(2);
    const remaining = simulation.state.reloadRemaining;
    expect(simulation.reload()).toEqual([]);
    expect(simulation.state.reloadRemaining).toBe(remaining);
    simulation.step(1.3, idle);
    expect(simulation.state.ammo.rifle).toBe(30);
    expect(simulation.state.reloadRemaining).toBe(0);
  });

  it('switching cancels loading, preserves every magazine and cannot bypass the shared fire cooldown', () => {
    const simulation = setup();
    simulation.selectWeapon('sniper');
    simulation.step(0.1, firing);
    simulation.selectWeapon('rifle');
    simulation.step(1, firing);
    expect(simulation.state.shots).toBe(1);
    simulation.step(0.1, firing);
    expect(simulation.state.shots).toBe(2);
    expect(simulation.state.ammo.sniper).toBe(4);
    expect(simulation.state.ammo.rifle).toBe(29);
    simulation.reload();
    simulation.step(0.4, idle);
    simulation.selectWeapon('shotgun');
    expect(simulation.state.reloadRemaining).toBe(0);
    simulation.step(2, idle);
    simulation.selectWeapon('rifle');
    expect(simulation.state.ammo.rifle).toBe(29);
  });

  it('freezes reload, spawn and fire clocks while paused and safely ignores invalid deltas', () => {
    const simulation = setup();
    simulation.step(0.1, firing);
    simulation.reload();
    simulation.pause();
    const before = structuredClone(simulation.state);
    expect(simulation.step(20, firing)).toEqual([]);
    simulation.selectWeapon('shotgun');
    expect(simulation.reload()).toEqual([]);
    expect(simulation.state).toEqual(before);
    simulation.resume();
    for (const dt of [0, -1, NaN, Infinity]) expect(simulation.step(dt, firing)).toEqual([]);
    expect(simulation.state.elapsed).toBeCloseTo(0.1);
    simulation.step(0.1, firing);
    expect(simulation.state.reloadRemaining).toBeCloseTo(1.7);
    expect(simulation.state.shots).toBe(1);
  });

  it('does not let repeated clicks bypass the weapon cooldown', () => {
    const simulation = setup();
    for (let i = 0; i < 50; i++) {
      simulation.step(0.01, firing);
      simulation.step(0.01, idle);
    }
    expect(simulation.state.shots).toBe(5);
  });

  it.each<Phase>(['ready', 'over', 'cleared', 'victory'])('does not advance %s state', (phase) => {
    const simulation = setup();
    simulation.state.phase = phase;
    const before = structuredClone(simulation.state);
    expect(simulation.step(100, firing)).toEqual([]);
    simulation.resume();
    simulation.selectWeapon('sniper');
    expect(simulation.reload()).toEqual([]);
    expect(simulation.state).toEqual(before);
  });
});

describe('finite levels', () => {
  it.each(LEVELS.map((_, index) => index + 1))(
    'level %i spawns the exact composition in finite batches with no late tanks',
    (level) => {
      const simulation = setup(level);
      const definition = LEVELS[level - 1];
      const counts: Record<ZombieKind, number> = { normal: 3, runner: 0, tank: 0, small: 0 };
      let lastTankAt = 0;
      let totalEvents = 0;
      while (
        simulation.state.phase === 'playing' &&
        simulation.state.elapsed < definition.duration + 1
      ) {
        const events = simulation.step(0.1, idle);
        totalEvents += events.filter((event) => event.type === 'clear').length;
        expect(simulation.state.zombies.length).toBeLessThanOrEqual(definition.batchSize);
        for (const zombie of simulation.state.zombies) {
          counts[zombie.kind]++;
          expect(zombie.hp).toBe(ZOMBIES[zombie.kind].hp);
          expect(zombie.maxHp).toBe(zombie.hp);
          expect(zombie.radius).toBe(ZOMBIES[zombie.kind].radius);
          expect(zombie.speed).toBe(ZOMBIES[zombie.kind].speed);
          if (zombie.kind === 'tank') lastTankAt = simulation.state.elapsed;
        }
        simulation.state.zombies = [];
        if (simulation.state.boss) simulation.state.boss.hp = 0;
      }
      expect(counts).toEqual(definition.counts);
      expect(simulation.state.spawned).toBe(levelTotal(definition));
      expect(lastTankAt).toBeLessThanOrEqual(definition.duration - 20 + 0.11);
      expect(simulation.state.elapsed).toBeGreaterThanOrEqual(definition.duration);
      expect(simulation.state.phase).toBe(level === 5 ? 'victory' : 'cleared');
      expect(totalEvents).toBe(1);
      expect(simulation.state.progress.coins).toBe(LEVEL_REWARDS[level - 1]);
      expect(simulation.step(10, idle)).toEqual([]);
      expect(simulation.state.progress.coins).toBe(LEVEL_REWARDS[level - 1]);
    },
  );

  it('cannot clear early or skip a level while scheduled enemies remain', () => {
    const simulation = setup();
    simulation.nextLevel();
    simulation.step(5, idle);
    expect(simulation.state.phase).toBe('playing');
    expect(simulation.state.level).toBe(1);
    expect(simulation.state.spawned).toBe(3);
  });

  it('caps living enemies and keeps overdue quota queued instead of dropping it', () => {
    const simulation = setup(5);
    simulation.state.zombies = [target(1, -3, -4), target(2, 0, -1), target(3, 3.5, -6)];
    simulation.state.hp = 1e9;
    simulation.step(200, idle);
    expect(simulation.state.zombies).toHaveLength(30);
    expect(simulation.state.spawned).toBe(30);
    while (simulation.state.spawned < levelTotal(LEVELS[4])) {
      for (const zombie of simulation.state.zombies) {
        zombie.hp = 0;
        zombie.deadTime = 0;
      }
      simulation.step(0.01, idle);
      expect(simulation.state.zombies.filter((zombie) => zombie.hp > 0).length).toBeLessThanOrEqual(
        30,
      );
    }
    expect(simulation.state.spawned).toBe(120);
    expect(simulation.state.phase).toBe('playing');
    for (const zombie of simulation.state.zombies) {
      zombie.hp = 0;
      zombie.deadTime = 0;
    }
    simulation.state.boss!.hp = 0;
    expect(simulation.step(0.01, idle)).toContainEqual({ type: 'clear', level: 5, final: true });
    expect(simulation.state.phase).toBe('victory');
  });

  it('retry resets the same level and selected weapon, while next level starts with full health and magazines', () => {
    const simulation = setup(3);
    simulation.selectWeapon('shotgun');
    simulation.step(0.2, firing);
    simulation.state.hp = 30;
    simulation.pause();
    simulation.retry();
    expect(simulation.state.level).toBe(3);
    expect(simulation.state.weapon).toBe('shotgun');
    expect(simulation.state.hp).toBe(100);
    expect(simulation.state.elapsed).toBe(0);
    expect(simulation.state.shots).toBe(0);
    expect(simulation.state.hits).toBe(0);
    expect(simulation.state.kills).toBe(0);
    expect(simulation.state.reloadRemaining).toBe(0);
    expect(simulation.state.ammo).toEqual({ rifle: 30, sniper: 5, shotgun: 6 });
    expect(simulation.state.zombies.map((zombie) => zombie.id)).toEqual([1, 2, 3]);
    simulation.state.hp = 10;
    simulation.state.zombies = [target(99, 0, 6)];
    simulation.step(0.01, idle);
    expect(simulation.state.phase).toBe('over');
    simulation.retry();
    expect(simulation.state.level).toBe(3);
    expect(simulation.state.weapon).toBe('shotgun');
    expect(simulation.state.hp).toBe(100);
    simulation.state.phase = 'cleared';
    simulation.nextLevel();
    expect(simulation.state.level).toBe(4);
    expect(simulation.state.weapon).toBe('shotgun');
    expect(simulation.state.spawned).toBe(3);
    simulation.start();
    expect(simulation.state.level).toBe(1);
    expect(simulation.state.weapon).toBe('rifle');
    simulation.state.phase = 'victory';
    simulation.nextLevel();
    expect(simulation.state.level).toBe(1);
  });
});

function bossTarget(kind: BossKind): Boss {
  return {
    kind,
    x: 0,
    z: 0,
    hp: BOSSES[kind].hp,
    maxHp: BOSSES[kind].hp,
    parts: kind === 'brood' ? [0, 1, 2].map((id) => ({ id, hp: 240, maxHp: 240 })) : [],
    attackRemaining: 8,
    deadTime: -1,
    hitTime: 0,
  };
}

describe('Boss encounters', () => {
  it.each(['bulwark', 'brood'] as const)(
    '%s spawns once at its scheduled time and stops before beginning its attack clock',
    (kind) => {
      const definition = BOSSES[kind];
      const simulation = setup(definition.level);
      simulation.state.elapsed = definition.spawnAt - 0.03;
      simulation.step(0.01, idle);
      expect(simulation.state.boss).toBeNull();
      simulation.step(0.03, idle);
      const boss = simulation.state.boss!;
      expect(boss.kind).toBe(kind);
      expect(boss.hp).toBe(definition.hp);
      expect(boss.attackRemaining).toBe(8);
      simulation.state.zombies = [];
      simulation.step(18 / definition.speed, idle);
      expect(boss.z).toBe(definition.stopZ);
      expect(boss.attackRemaining).toBeGreaterThan(7.9);
      boss.hp = 0;
      simulation.step(2, idle);
      expect(simulation.state.boss).toBe(boss);
      expect(boss.deadTime).toBeGreaterThan(0);
    },
  );

  it.each(WEAPON_IDS)('bulwark applies the correct %s damage multiplier', (weapon) => {
    const simulation = setup();
    const boss = bossTarget('bulwark');
    simulation.state.boss = boss;
    simulation.selectWeapon(weapon);
    simulation.step(0.01, firing);
    expect(boss.hp).toBe(1600 - WEAPONS[weapon].damage * (weapon === 'sniper' ? 1.5 : 0.5));
  });

  it('includes Boss bodies in nearest-target and sniper penetration ordering', () => {
    const simulation = setup();
    const boss = bossTarget('bulwark');
    const behind = target(1, 0, -4);
    simulation.state.boss = boss;
    simulation.state.zombies = [behind];
    simulation.step(0.2, firing);
    expect(behind.hp).toBe(75);
    expect(boss.hp).toBe(1587.5);
    simulation.selectWeapon('sniper');
    simulation.step(0.01, firing);
    expect(behind.hp).toBe(0);
    expect(boss.hp).toBe(1317.5);
  });

  it('requires all three explicit geometric weakpoint hits before exposing the core', () => {
    const simulation = setup();
    const boss = bossTarget('brood');
    simulation.state.boss = boss;
    simulation.selectWeapon('sniper');
    simulation.step(1.15, firing);
    expect(boss.hp).toBe(900);
    expect(boss.parts.map((part) => part.hp)).toEqual([240, 240, 240]);
    simulation.step(1.15, { firing: true, aim: { x: 20, z: 0, bossPart: 0 } });
    expect(boss.parts[0].hp).toBe(240);
    const events = [];
    for (const part of boss.parts) {
      const aim = bossPartPosition(boss, part.id);
      while (part.hp > 0) events.push(...simulation.step(1.15, { firing: true, aim }));
    }
    expect(events.filter((event) => event.type === 'bossBreak')).toHaveLength(3);
    expect(boss.hp).toBe(900);
    expect(simulation.state.progress.coins).toBe(simulation.state.kills * 4);
    simulation.step(3, { firing: true, aim: bossPartPosition(boss, 1) });
    expect(boss.hp).toBe(900);
    const last = simulation.step(4, firing);
    expect(boss.hp).toBeLessThan(900);
    expect(last.filter((event) => event.type === 'bossBreak')).toHaveLength(0);
  });

  it('checks weakpoint geometry and finite shotgun range, damaging only the selected part once per shell', () => {
    const simulation = setup();
    const boss = bossTarget('brood');
    boss.z = -5;
    simulation.state.boss = boss;
    simulation.selectWeapon('shotgun');
    simulation.step(0.85, { firing: true, aim: bossPartPosition(boss, 0) });
    expect(boss.parts[0].hp).toBe(240);
    boss.z = 0;
    simulation.step(0.85, { firing: true, aim: bossPartPosition(boss, 0) });
    expect(boss.parts.map((part) => part.hp)).toEqual([150, 240, 240]);
    expect(boss.hp).toBe(900);
    simulation.step(0.85, { firing: true, aim: { x: 0, z: 0, bossPart: 100 } });
    expect(boss.hp).toBe(900);
    expect(boss.parts.map((part) => part.hp)).toEqual([150, 240, 240]);
  });

  it('telegraphs for two seconds, freezes on pause, then attacks on an eight-second cycle', () => {
    const simulation = setup();
    const boss = bossTarget('bulwark');
    simulation.state.boss = boss;
    expect(simulation.step(6, idle).filter((event) => event.type === 'bossWarning')).toHaveLength(
      1,
    );
    expect(simulation.state.hp).toBe(100);
    simulation.pause();
    const before = structuredClone(simulation.state);
    simulation.step(40, idle);
    expect(simulation.state).toEqual(before);
    simulation.resume();
    expect(simulation.step(2, idle).filter((event) => event.type === 'hurt')).toHaveLength(1);
    expect(simulation.state.hp).toBe(80);
    simulation.state.zombies = [];
    expect(simulation.step(8, idle).filter((event) => event.type === 'hurt')).toHaveLength(1);
    expect(simulation.state.hp).toBe(60);
    boss.hp = 0;
    simulation.step(8, idle);
    expect(simulation.state.hp).toBe(60);
  });

  it('requires Boss death as well as the complete ordinary quota before clearing', () => {
    const simulation = setup(3);
    while (simulation.state.elapsed < 111) {
      simulation.step(0.1, idle);
      simulation.state.zombies = [];
    }
    expect(simulation.state.spawned).toBe(levelTotal(LEVELS[2]));
    expect(simulation.state.phase).toBe('playing');
    simulation.state.boss!.hp = 1;
    simulation.selectWeapon('sniper');
    const events = simulation.step(0.1, firing);
    expect(simulation.state.phase).toBe('cleared');
    expect(events.filter((event) => event.type === 'coins').map((event) => event.amount)).toEqual([
      150, 120,
    ]);
    expect(simulation.state.earnedCoins).toBe(270);
    expect(simulation.state.kills).toBe(0);
    expect(simulation.step(10, firing)).toEqual([]);
    expect(simulation.state.progress.coins).toBe(270);
  });

  it.each(['bulwark', 'brood'] as const)(
    '%s pays its reward once and its corpse cannot block or attack',
    (kind) => {
      const simulation = setup();
      const boss = bossTarget(kind);
      boss.hp = 1;
      boss.attackRemaining = 0;
      for (const part of boss.parts) part.hp = 0;
      simulation.state.boss = boss;
      const behind = target(1, 0, -4);
      simulation.state.zombies = [behind];
      const events = simulation.step(0.2, firing);
      expect(boss.hp).toBe(0);
      expect(simulation.state.hp).toBe(100);
      expect(simulation.state.kills).toBe(0);
      expect(events.filter((event) => event.type === 'coins')).toEqual([
        { type: 'coins', amount: BOSSES[kind].reward, at: { x: 0, z: 0, y: 1.5 } },
      ]);
      simulation.step(0.2, firing);
      expect(behind.hp).toBe(50);
      expect(simulation.state.progress.coins).toBe(BOSSES[kind].reward);
    },
  );
});

describe('persistent rewards, upgrades and supplies', () => {
  it.each(Object.keys(ZOMBIES) as ZombieKind[])(
    '%s credits its reward once and corpses cannot earn more',
    (kind) => {
      const simulation = setup();
      const zombie = target(1, 0, 0, kind);
      zombie.hp = 1;
      simulation.state.zombies = [zombie];
      const events = simulation.step(1, firing);
      expect(events.filter((event) => event.type === 'coins')).toEqual([
        { type: 'coins', amount: KILL_REWARDS[kind], at: { x: 0, z: 0 } },
      ]);
      expect(simulation.state.progress.coins).toBe(KILL_REWARDS[kind]);
      expect(simulation.state.earnedCoins).toBe(KILL_REWARDS[kind]);
    },
  );

  it('caps both wallet credit and reported earnings at the persistence limit', () => {
    const simulation = setup();
    simulation.state.progress.coins = MAX_COINS - 2;
    simulation.state.zombies = [target(1)];
    const events = simulation.step(1, firing);
    expect(simulation.state.progress.coins).toBe(MAX_COINS);
    expect(simulation.state.earnedCoins).toBe(2);
    expect(events).toContainEqual({ type: 'coins', amount: 2, at: { x: 0, z: 0 } });
  });

  it('only purchases in shop phases and applies upgraded health, weapon damage and reload time', () => {
    const progress = createProgress();
    progress.coins = 1000;
    const simulation = new Simulation(() => 0.5, progress);
    expect(simulation.purchase('health')).toBe(true);
    expect(simulation.state.maxHp).toBe(125);
    expect(simulation.purchase('rifle')).toBe(true);
    expect(simulation.purchase('reload')).toBe(true);
    simulation.start();
    expect(simulation.state.hp).toBe(125);
    expect(simulation.purchase('rifle')).toBe(false);
    simulation.pause();
    expect(simulation.purchase('rifle')).toBe(false);
    simulation.resume();
    const zombie = target(1);
    simulation.state.zombies = [zombie];
    simulation.step(0.1, firing);
    expect(zombie.hp).toBe(45);
    simulation.reload();
    expect(simulation.state.reloadRemaining).toBeCloseTo(1.62);
    for (const phase of ['over', 'cleared', 'victory'] as const) {
      simulation.state.phase = phase;
      expect(simulation.purchase('medkit')).toBe(true);
    }
  });

  it('medkits heal only during active injured play without exceeding max health', () => {
    const simulation = setup();
    simulation.state.progress.medkits = 2;
    expect(simulation.useMedkit()).toEqual([]);
    expect(simulation.state.progress.medkits).toBe(2);
    simulation.state.hp = 20;
    simulation.pause();
    expect(simulation.useMedkit()).toEqual([]);
    simulation.resume();
    expect(simulation.useMedkit()).toEqual([{ type: 'heal' }]);
    expect(simulation.state.hp).toBe(70);
    simulation.useMedkit();
    expect(simulation.state.hp).toBe(100);
    expect(simulation.state.progress.medkits).toBe(0);
    simulation.state.hp = 20;
    expect(simulation.useMedkit()).toEqual([]);
  });

  it('absorbs damage with armor before health and preserves consumed armor on retry', () => {
    const simulation = setup();
    simulation.state.progress.armor = 15;
    simulation.state.zombies = [target(1, 0, 6)];
    simulation.step(0.1, idle);
    expect(simulation.state.hp).toBe(100);
    expect(simulation.state.progress.armor).toBe(5);
    simulation.step(1, idle);
    expect(simulation.state.hp).toBe(95);
    expect(simulation.state.progress.armor).toBe(0);
    simulation.pause();
    simulation.retry();
    expect(simulation.state.progress.armor).toBe(0);
    expect(simulation.state.hp).toBe(100);
  });

  it('revives once on lethal damage, blocks same-frame damage, and advances enemy cooldowns during protection', () => {
    const simulation = setup();
    simulation.state.hp = 10;
    simulation.state.progress.revive = true;
    const first = target(1, 0, 6);
    const second = target(2, 0.5, 6);
    first.radius = second.radius = 0;
    simulation.state.zombies = [first, second];
    const events = simulation.step(0.01, idle);
    expect(events.filter((event) => event.type === 'revive')).toHaveLength(1);
    expect(simulation.state.hp).toBe(100);
    expect(simulation.state.progress.revive).toBe(false);
    simulation.state.progress.armor = 20;
    first.attackCooldown = second.attackCooldown = 0.2;
    simulation.step(2.9, idle);
    expect(simulation.state.hp).toBe(100);
    expect(simulation.state.progress.armor).toBe(20);
    expect(first.attackCooldown).toBeGreaterThan(0.25);
    expect(simulation.state.invulnerable).toBeCloseTo(0.1);
    simulation.step(0.11, idle);
    expect(simulation.state.progress.armor).toBe(20);
    simulation.step(0.21, idle);
    expect(simulation.state.progress.armor).toBe(0);
    simulation.state.hp = 10;
    simulation.step(1, idle);
    expect(simulation.state.phase).toBe('over');
  });

  it('retains earned money and assets across failure, retry, next level and new campaign', () => {
    const simulation = setup();
    Object.assign(simulation.state.progress, {
      coins: 123,
      healthLevel: 1,
      armor: 17,
      medkits: 2,
      revive: true,
    });
    simulation.state.earnedCoins = 12;
    simulation.state.phase = 'over';
    simulation.retry();
    expect(simulation.state.hp).toBe(125);
    expect(simulation.state.earnedCoins).toBe(0);
    expect(simulation.state.progress.coins).toBe(123);
    const assets = structuredClone(simulation.state.progress);
    simulation.state.phase = 'cleared';
    simulation.nextLevel();
    simulation.start();
    expect(simulation.state.progress).toEqual(assets);
    expect(simulation.state.boss).toBeNull();
    expect(simulation.state.invulnerable).toBe(0);
    expect(simulation.state.hp).toBe(125);
  });
});
