import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { getDamageMultiplier } from './economy';
import {
  LEVELS,
  RULES,
  WEAPONS,
  WEAPON_IDS,
  ZOMBIES,
  levelTotal,
  bossPartPosition,
  type GameInput,
  type GameState,
  type WeaponId,
} from './types';

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

function manualInput(state: GameState): { weapon: WeaponId; input: GameInput } {
  const alive = state.zombies
    .filter((zombie) => zombie.hp > 0)
    .sort(
      (a, b) =>
        Math.hypot(a.x - state.player.x, a.z - state.player.z) -
        Math.hypot(b.x - state.player.x, b.z - state.player.z),
    );
  const nearest = alive[0];
  const distance = nearest
    ? Math.hypot(nearest.x - state.player.x, nearest.z - state.player.z)
    : Infinity;
  const available = (weapon: WeaponId) => state.ammo[weapon] + state.reserve[weapon] > 0;
  let weapon: WeaponId = 'rifle';
  if (distance <= WEAPONS.shotgun.range && available('shotgun')) weapon = 'shotgun';
  else if (state.boss && state.boss.hp > 0 && distance > 9 && available('sniper')) {
    const part = state.boss.parts.find((part) => part.hp > 0);
    return {
      weapon: 'sniper',
      input: {
        firing: true,
        aim: part ? bossPartPosition(state.boss, part.id) : { x: state.boss.x, z: state.boss.z },
      },
    };
  } else if (nearest?.kind === 'tank' && distance > WEAPONS.shotgun.range && available('sniper'))
    weapon = 'sniper';
  else weapon = WEAPON_IDS.find(available) ?? state.weapon;

  let aim: GameInput['aim'] = nearest ? { x: nearest.x, z: nearest.z } : { x: 0, z: -10 };
  let firing = Boolean(nearest) && distance <= WEAPONS[weapon].range && available(weapon);
  if (!nearest && state.boss && state.boss.hp > 0) {
    const part = state.boss.parts.find((part) => part.hp > 0);
    aim = part ? bossPartPosition(state.boss, part.id) : { x: state.boss.x, z: state.boss.z };
    firing =
      Math.hypot(aim.x - state.player.x, aim.z - state.player.z) <= WEAPONS[weapon].range &&
      available(weapon);
  }
  return { weapon, input: { firing, aim } };
}

const seeds = [1, 42, 90210, 2026, 123456];
type Mode = 'manual' | 'manual-misses' | 'auto';
const cases = seeds.flatMap((seed) => [
  ...[1 / 60, 0.25].flatMap((dt) =>
    (['manual', 'auto'] as Mode[]).map((mode) => ({ seed, dt, mode })),
  ),
  { seed, dt: 0.25, mode: 'manual-misses' as const },
]);

describe('campaign balance with finite supplies and normal earned progress', () => {
  it.each(['rifle', 'sniper'] as const)(
    'the unupgraded %s alone has insufficient ammunition for level one',
    (weapon) => {
      const level = LEVELS[0];
      const enemyHealth = Object.entries(level.counts).reduce(
        (sum, [kind, count]) => sum + ZOMBIES[kind as keyof typeof ZOMBIES].hp * count,
        0,
      );
      const maximumDamage =
        (WEAPONS[weapon].magazine + level.reserve[weapon]) * WEAPONS[weapon].damage;
      expect(maximumDamage).toBeLessThan(enemyHealth);
    },
  );
  it.each(cases)(
    '$mode finishes all five levels with seed $seed at $dt second input intervals',
    ({ seed, dt, mode }) => {
      const simulation = new Simulation(seededRandom(seed));
      simulation.setAutoFire(mode === 'auto');
      simulation.start();
      const totalShots = { rifle: 0, sniper: 0, shotgun: 0 };
      const results: object[] = [];
      let deliberateMisses = 0;
      let grenadesThrown = 0;
      for (const [index, definition] of LEVELS.entries()) {
        expect(simulation.state.level).toBe(index + 1);
        expect(simulation.state.hp).toBe(simulation.state.maxHp);
        expect(simulation.state.reserve).toEqual(definition.reserve);
        const spent = { rifle: 0, sniper: 0, shotgun: 0 };
        const grenadesAtStart = simulation.state.progress.grenades;
        while (
          simulation.state.phase === 'playing' &&
          simulation.state.elapsed < definition.duration + 60
        ) {
          const state = simulation.state;
          const decision = manualInput(state);
          if (mode !== 'auto') simulation.selectWeapon(decision.weapon);
          if (!decision.input.firing && state.ammo[state.weapon] < WEAPONS[state.weapon].magazine)
            simulation.reload();
          if (state.hp <= state.maxHp - 50) simulation.useMedkit();
          if (mode !== 'auto' && state.progress.grenades > 0 && state.grenades.length === 0) {
            const target = state.zombies.find(
              (zombie) =>
                zombie.hp > 0 &&
                Math.hypot(zombie.x - state.player.x, zombie.z - state.player.z) <
                  RULES.grenadeRange &&
                state.zombies.filter(
                  (other) =>
                    other.hp > 0 &&
                    Math.hypot(other.x - zombie.x, other.z - zombie.z) <= RULES.grenadeRadius,
                ).length >= 2,
            );
            if (target && simulation.throwGrenade({ x: target.x, z: target.z }).length)
              grenadesThrown++;
          }
          // Miss every tenth planned shot in a fixed direction, independent of spawn RNG.
          const miss = mode === 'manual-misses' && (state.shots + 1) % 10 === 0;
          const input =
            mode === 'auto'
              ? { firing: false, aim: { x: 0, z: -10 } }
              : miss
                ? { ...decision.input, aim: { x: 40, z: state.player.z - 1 } }
                : decision.input;
          for (const event of simulation.step(dt, input)) {
            if (event.type === 'shot') {
              spent[event.weapon]++;
              totalShots[event.weapon]++;
              if (miss) deliberateMisses++;
            }
          }
        }
        const state = simulation.state;
        results.push({
          level: index + 1,
          seconds: state.elapsed,
          hp: state.hp,
          kills: state.kills,
          spent,
          ammo: state.ammo,
          reserve: state.reserve,
          // Per-target ordinary damage; shotgun area coverage and Boss armor alter actual value.
          remainingSingleTargetDamage: Object.fromEntries(
            WEAPON_IDS.map((weapon) => [
              weapon,
              (state.ammo[weapon] + state.reserve[weapon]) *
                WEAPONS[weapon].damage *
                getDamageMultiplier(state.progress, weapon),
            ]),
          ),
          grenades: state.progress.grenades,
        });
        const evidence = JSON.stringify({ mode, seed, dt, results });
        expect(state.phase, evidence).toBe(index === LEVELS.length - 1 ? 'victory' : 'cleared');
        expect(state.kills).toBe(levelTotal(definition));
        expect(state.spawned).toBe(levelTotal(definition));
        if (index === 2 || index === 4) expect(state.boss?.hp).toBe(0);
        expect(state.elapsed).toBeGreaterThanOrEqual(definition.duration);
        expect(state.elapsed).toBeLessThanOrEqual(definition.duration + 60);
        expect(state.hp).toBeGreaterThan(0);
        expect(state.hits).toBeLessThanOrEqual(state.shots);
        for (const weapon of WEAPON_IDS) {
          expect(state.ammo[weapon] + state.reserve[weapon] + spent[weapon], evidence).toBe(
            WEAPONS[weapon].magazine + definition.reserve[weapon],
          );
        }
        if (mode === 'auto') expect(state.progress.grenades).toBe(grenadesAtStart);
        if (index < LEVELS.length - 1) {
          for (const item of [
            'rifle',
            'shotgun',
            'sniper',
            'reload',
            'health',
            'grenade',
            'medkit',
            'armor',
            'revive',
          ] as const)
            simulation.purchase(item);
          const assets = structuredClone(state.progress);
          simulation.nextLevel();
          expect(simulation.state.progress).toEqual(assets);
        }
      }
      expect(totalShots.rifle).toBeGreaterThan(0);
      expect(totalShots.sniper).toBeGreaterThan(0);
      if (mode !== 'auto') expect(totalShots.shotgun).toBeGreaterThan(0);
      if (mode === 'manual-misses') expect(deliberateMisses).toBeGreaterThan(0);
      if (mode !== 'auto') expect(grenadesThrown).toBeGreaterThan(0);
    },
  );
});
