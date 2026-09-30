import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import {
  LEVELS,
  RULES,
  WEAPONS,
  WEAPON_IDS,
  ZOMBIES,
  levelTotal,
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
      }
      expect(counts).toEqual(definition.counts);
      expect(simulation.state.spawned).toBe(levelTotal(definition));
      expect(lastTankAt).toBeLessThanOrEqual(definition.duration - 20 + 0.11);
      expect(simulation.state.elapsed).toBeGreaterThanOrEqual(definition.duration);
      expect(simulation.state.phase).toBe(level === 5 ? 'victory' : 'cleared');
      expect(totalEvents).toBe(1);
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
