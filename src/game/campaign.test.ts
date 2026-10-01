import { describe, expect, it } from 'vitest';
import { Simulation } from './simulation';
import { LEVELS, RULES, WEAPONS, levelTotal, bossPartPosition, type GameInput } from './types';

function seededRandom(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

describe('campaign balance with normal player health and input', () => {
  it.each(
    [1, 42, 90210, 2026, 123456].flatMap((seed) => [1 / 60, 0.25].map((dt) => ({ seed, dt }))),
  )(
    'a player using earned upgrades and Boss weakpoints can finish all five levels with seed $seed and input interval $dt',
    ({ seed, dt }) => {
      const simulation = new Simulation(seededRandom(seed));
      simulation.start();
      let previousDuration = 0;
      const results: { level: number; seconds: number; hp: number; kills: number }[] = [];
      for (const [index, definition] of LEVELS.entries()) {
        expect(simulation.state.level).toBe(index + 1);
        expect(simulation.state.hp).toBe(simulation.state.maxHp);
        while (simulation.state.phase === 'playing' && simulation.state.elapsed < 190) {
          const nearest = simulation.state.zombies
            .filter((zombie) => zombie.hp > 0)
            .sort(
              (a, b) => Math.hypot(a.x, a.z - RULES.playerZ) - Math.hypot(b.x, b.z - RULES.playerZ),
            )[0];
          const boss = simulation.state.boss;
          const distance = nearest ? Math.hypot(nearest.x, nearest.z - RULES.playerZ) : Infinity;
          const attackBoss = boss && boss.hp > 0 && distance > 9;
          const weapon = attackBoss ? 'sniper' : 'rifle';
          simulation.selectWeapon(weapon);
          let aim: GameInput['aim'] = nearest ? { x: nearest.x, z: nearest.z } : { x: 0, z: -10 };
          if (attackBoss) {
            const part = boss.parts.find((part) => part.hp > 0);
            aim = part ? bossPartPosition(boss, part.id) : { x: boss.x, z: boss.z };
          }
          if (!nearest && !attackBoss && simulation.state.ammo[weapon] < WEAPONS[weapon].magazine)
            simulation.reload();
          if (simulation.state.hp <= simulation.state.maxHp - 50) simulation.useMedkit();
          simulation.step(dt, { firing: Boolean(nearest || attackBoss), aim });
        }
        results.push({
          level: index + 1,
          seconds: simulation.state.elapsed,
          hp: simulation.state.hp,
          kills: simulation.state.kills,
        });
        expect(simulation.state.phase, JSON.stringify(results)).toBe(
          index === 4 ? 'victory' : 'cleared',
        );
        expect(simulation.state.kills).toBe(levelTotal(definition));
        if (index === 2 || index === 4) expect(simulation.state.boss?.hp).toBe(0);
        expect(simulation.state.spawned).toBe(levelTotal(definition));
        expect(simulation.state.elapsed).toBeGreaterThanOrEqual(definition.duration);
        expect(simulation.state.elapsed).toBeLessThanOrEqual(definition.duration + 20);
        expect(simulation.state.elapsed).toBeGreaterThan(previousDuration);
        expect(simulation.state.hp).toBeGreaterThan(0);
        expect(simulation.state.hits).toBeLessThanOrEqual(simulation.state.shots);
        previousDuration = simulation.state.elapsed;
        if (index < 4) {
          for (const item of [
            'rifle',
            'sniper',
            'reload',
            'health',
            'armor',
            'medkit',
            'medkit',
            'revive',
          ] as const)
            simulation.purchase(item);
          simulation.nextLevel();
        }
      }
      console.info(JSON.stringify({ seed, inputInterval: dt, campaign: results }));
    },
  );
});
