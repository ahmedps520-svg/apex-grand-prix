import { describe, expect, it } from 'vitest';
import { trafficModel, trafficPaint } from '../../src/content/city/fleet';
import { laneGraph } from '../../src/content/city/lanes';
import { cityMap } from '../../src/content/city/map';
import { SIM_DT, defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (
  traffic: number,
  roamStart: SessionConfig['roamStart'] = 'downtown',
): SessionConfig => ({
  mode: 'roam',
  trackId: '',
  carId: 'gt',
  location: 'loop',
  roamStart,
  traffic,
  opponents: 0,
  laps: 0,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 3,
  conditions: { time: 'night', weather: 'clear' },
});

const run = (world: World, seconds: number, each?: () => void) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    world.step(SIM_DT);
    if (each && i % 200 === 0) each();
  }
};

describe('continuing a drive', () => {
  it('puts the car exactly where the drive was left', () => {
    const world = World.forSession({ ...config(2), roamSpawn: { x: 120, z: -40, yaw: 1.2 } });
    const car = world.cars[0]!;
    expect(car.pos.x).toBeCloseTo(120, 0);
    expect(car.pos.z).toBeCloseTo(-40, 0);
  });
});

describe('after dark', () => {
  it('turns the headlights on by themselves at night, not by day', () => {
    expect(World.forSession(config(2)).cars[0]!.headlights).toBe(true);
    const day = {
      ...config(2),
      conditions: { time: 'midday' as const, weather: 'clear' as const },
    };
    expect(World.forSession(day).cars[0]!.headlights).toBe(false);
  });
});

describe('traffic', () => {
  it('fills its slots from the everyday fleet with plain paints', () => {
    for (let i = 0; i < 20; i++) {
      const m = trafficModel(i);
      expect(['Street', 'Touring', 'SUV']).toContain(m.className);
      expect(trafficPaint(i)).toBeGreaterThan(0);
    }
  });

  it('spawns around the player, drives the lanes within the limits and keeps its distance', () => {
    const world = World.forSession(config(12));
    const traffic = world.traffic!;
    expect(world.snapshotCount).toBe(13);
    let braked = 0;
    let indicated = 0;
    run(world, 40, () => {
      for (const car of traffic.vehicles) {
        if (!car.active) continue;
        if (car.brake > 0.2) braked++;
        if (car.indicator !== 0) indicated++;
      }
    });
    const active = traffic.vehicles.filter((v) => v.active);
    expect(active.length).toBeGreaterThan(6);
    for (const car of active) {
      expect(Number.isFinite(car.x) && Number.isFinite(car.z) && Number.isFinite(car.y)).toBe(true);
      const limit = ((car.link.speedLimit || 60) / 3.6) * 1.12;
      expect(car.v).toBeLessThanOrEqual(limit + 0.01);
      expect(car.hazards).toBe(0);
      const player = world.cars[0]!;
      expect(Math.hypot(car.x - player.pos.x, car.z - player.pos.z)).toBeLessThan(600);
    }
    // Nobody sits inside the car ahead.
    for (const a of active) {
      for (const b of active) {
        if (a === b || a.link !== b.link) continue;
        expect(Math.abs(a.s - b.s)).toBeGreaterThan(3);
      }
    }
    expect(braked).toBeGreaterThan(0);
    expect(indicated).toBeGreaterThan(0);
    // The snapshot carries every slot after the player.
    const out = new Float32Array(13 * 100 * 2);
    world.writeSnapshot(out);
    expect(out.some((v) => Number.isNaN(v))).toBe(false);
  });

  it('stops for the player and shoves it in a collision, with its hazards on', () => {
    const world = World.forSession(config(6));
    const traffic = world.traffic!;
    run(world, 3);
    const car = traffic.vehicles.find((v) => v.active && v.v > 3)!;
    expect(car).toBeDefined();
    // Park the player 12 m ahead of it in its lane.
    const graph = laneGraph(cityMap());
    const p = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
    graph.pointAt(car.link, Math.min(car.s + 12, car.link.length - 1), p);
    const player = world.cars[0]!;
    player.pos.x = p.x;
    player.pos.z = p.z;
    player.vel.x = 0;
    player.vel.z = 0;
    const before = car.v;
    run(world, 2.5);
    expect(car.v).toBeLessThan(before);
    expect(Math.hypot(car.x - player.pos.x, car.z - player.pos.z)).toBeGreaterThan(3);

    // Now drop the player right onto it: a collision.
    player.pos.x = car.x;
    player.pos.z = car.z;
    world.step(SIM_DT);
    expect(car.hazards).toBeGreaterThan(0);
    expect(Math.hypot(player.vel.x, player.vel.z)).toBeGreaterThan(0);
  });
});
