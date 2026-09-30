import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { RULES, type GameInput, type Zombie } from './types';

const idle: GameInput = { firing: false, aim: { x: 0, z: -10 } };
const firing: GameInput = { ...idle, firing: true };

function setup(): Simulation {
  const simulation = new Simulation(() => 0.5);
  simulation.start();
  simulation.state.zombies = [];
  return simulation;
}

function target(id: number, x = 0, z = 0): Zombie {
  return {
    id,
    x,
    z,
    hp: RULES.zombieHp,
    radius: 0.48,
    speed: 0,
    attackCooldown: 0,
    hitTime: 0,
    deadTime: -1,
    variant: 0,
  };
}

describe('Simulation', () => {
  it('shows a static ready scene and starts with a fresh first group', () => {
    const simulation = new Simulation(() => 0.5);
    expect(simulation.state.phase).toBe('ready');
    expect(simulation.state.zombies).toHaveLength(6);
    const before = structuredClone(simulation.state);
    expect(simulation.step(10, firing)).toEqual([]);
    expect(simulation.state).toEqual(before);
    simulation.start();
    expect(simulation.state.phase).toBe('playing');
    expect(simulation.state.zombies).toHaveLength(3);
    expect(simulation.state.zombies.every((zombie) => zombie.deadTime === -1)).toBe(true);
  });

  it('fires immediately at five shots a second and kills on the third hit', () => {
    const simulation = setup();
    const zombie = target(1);
    simulation.state.zombies.push(zombie);
    expect(simulation.step(0.2, firing).filter((event) => event.type === 'shot')).toHaveLength(1);
    expect(zombie.hp).toBe(50);
    simulation.step(0.2, firing);
    expect(zombie.hp).toBe(25);
    const death = simulation.step(0.2, firing);
    expect(zombie.hp).toBe(0);
    expect(death).toContainEqual({ type: 'hit', at: { x: 0, z: 0 }, killed: true });
    expect(simulation.state.kills).toBe(1);
    simulation.step(0.4, firing);
    expect(simulation.state.shots).toBe(5);
    expect(simulation.state.hits).toBe(3);
    expect(simulation.state.kills).toBe(1);
  });

  it('hits the nearest circle only and ignores its corpse on subsequent shots', () => {
    const simulation = setup();
    const near = target(1, 0, 3);
    const far = target(2, 0, -3);
    near.hp = 25;
    simulation.state.zombies.push(far, near);
    const events = simulation.step(0.2, firing);
    expect(near.hp).toBe(0);
    expect(far.hp).toBe(75);
    const shot = events.find((event) => event.type === 'shot');
    expect(shot?.type === 'shot' && shot.to.z).toBeCloseTo(3.48);
    simulation.step(0.2, firing);
    expect(far.hp).toBe(50);
    expect(simulation.state.kills).toBe(1);
  });

  it('uses circle intersections, limits range, and rejects backward shooting', () => {
    const simulation = setup();
    const missed = target(1, 0.6, 0);
    const outOfRange = target(2, 0, -34);
    simulation.state.zombies.push(missed, outOfRange);
    const events = simulation.step(0.2, firing);
    expect(events).toEqual([
      { type: 'shot', from: { x: 0, z: 7 }, to: { x: 0, z: -33 }, hit: false },
    ]);
    expect(missed.hp).toBe(75);
    expect(outOfRange.hp).toBe(75);
    expect(simulation.step(0.2, { firing: true, aim: { x: 2, z: 8 } })).toEqual([]);
    expect(simulation.state.shots).toBe(1);
  });

  it('kills before an attack in the same frame and removes expired corpses', () => {
    const simulation = setup();
    const zombie = target(1, 0, 6);
    zombie.hp = 25;
    simulation.state.zombies.push(zombie);
    const events = simulation.step(0.01, firing);
    expect(events.some((event) => event.type === 'hurt')).toBe(false);
    expect(simulation.state.hp).toBe(100);
    expect(zombie.deadTime).toBeCloseTo(0.01);
    simulation.step(1.49, idle);
    expect(simulation.state.zombies.some((item) => item === zombie)).toBe(false);
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

  it('stops all later attacks immediately when the player dies', () => {
    const simulation = setup();
    simulation.state.hp = 10;
    simulation.state.zombies.push(target(1, 0, 6), target(2, 0.2, 6));
    const events = simulation.step(5, idle);
    expect(events).toEqual([{ type: 'hurt', hp: 0 }, { type: 'over' }]);
    expect(simulation.state.phase).toBe('over');
    const before = structuredClone(simulation.state);
    simulation.resume();
    expect(simulation.step(10, firing)).toEqual([]);
    expect(simulation.state).toEqual(before);
  });

  it('freezes every clock while paused and safely ignores invalid deltas', () => {
    const simulation = setup();
    simulation.state.zombies.push(target(1));
    simulation.step(0.1, firing);
    simulation.pause();
    const before = structuredClone(simulation.state);
    expect(simulation.step(20, firing)).toEqual([]);
    expect(simulation.state).toEqual(before);
    simulation.resume();
    for (const dt of [0, -1, NaN, Infinity]) expect(simulation.step(dt, firing)).toEqual([]);
    expect(simulation.state.elapsed).toBeCloseTo(0.1);
    simulation.step(0.1, firing);
    expect(simulation.state.shots).toBe(1);
    simulation.step(0.01, firing);
    expect(simulation.state.shots).toBe(2);
  });

  it('does not let repeated clicks bypass the weapon cooldown', () => {
    const simulation = setup();
    for (let i = 0; i < 50; i++) {
      simulation.step(0.01, firing);
      simulation.step(0.01, idle);
    }
    expect(simulation.state.shots).toBe(5);
  });

  it('separates living enemies that occupy the same point', () => {
    const simulation = setup();
    const a = target(1);
    const b = target(2);
    simulation.state.zombies.push(a, b);
    simulation.step(0.01, idle);
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.6);
  });

  it('keeps crowded enemies in front of the player where they can still be shot', () => {
    const simulation = setup();
    simulation.state.hp = 1e9;
    for (let index = 0; index < 30; index++) {
      simulation.state.zombies.push(target(index + 1, 0, 5.55 - index * 0.1));
    }
    simulation.step(2, idle);
    expect(simulation.state.zombies.every((zombie) => zombie.z < simulation.state.player.z)).toBe(
      true,
    );
  });

  it('resets health, scores, corpses and all clocks on every restart', () => {
    const simulation = setup();
    for (let restart = 0; restart < 4; restart++) {
      simulation.state.hp = 10;
      simulation.state.kills = 20;
      simulation.step(0.7, firing);
      simulation.pause();
      simulation.start();
      expect(simulation.state.hp).toBe(100);
      expect(simulation.state.kills).toBe(0);
      expect(simulation.state.elapsed).toBe(0);
      expect(simulation.state.shots).toBe(0);
      expect(simulation.state.hits).toBe(0);
      expect(simulation.state.zombies).toHaveLength(3);
      simulation.step(0.84, firing);
      expect(simulation.state.zombies).toHaveLength(3);
      expect(simulation.state.shots).toBe(5);
      simulation.step(0.02, idle);
      expect(simulation.state.zombies).toHaveLength(4);
    }
  });

  it('caps living enemies and remains bounded through five simulated minutes', () => {
    const simulation = setup();
    simulation.state.hp = 1e9;
    let peak = 0;
    for (let second = 0; second < 300; second++) {
      simulation.step(1, second < 150 ? idle : firing);
      peak = Math.max(peak, simulation.state.zombies.length);
      expect(simulation.state.zombies.filter((zombie) => zombie.hp > 0).length).toBeLessThanOrEqual(
        RULES.maxZombies,
      );
      expect(simulation.state.zombies.length).toBeLessThanOrEqual(RULES.maxZombies + 3);
      expect(
        simulation.state.zombies.every(
          (zombie) => Number.isFinite(zombie.x) && Number.isFinite(zombie.z),
        ),
      ).toBe(true);
      expect(
        simulation.state.zombies.every(
          (zombie) => zombie.hp > 0 || zombie.deadTime < RULES.corpseLifetime,
        ),
      ).toBe(true);
    }
    expect(peak).toBeGreaterThanOrEqual(30);
    expect(simulation.state.elapsed).toBeCloseTo(300);
    expect(simulation.state.phase).toBe('playing');
    expect(simulation.state.kills).toBeGreaterThan(0);
  });
});
