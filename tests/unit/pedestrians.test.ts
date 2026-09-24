import { describe, expect, it } from 'vitest';
import { signalState } from '../../src/content/city/lanes';
import { SIDEWALK } from '../../src/content/city/map';
import {
  PED_CROSSING,
  PED_LEAPING,
  PED_STRIDE,
  PED_WALKING,
  SIM_DT,
  SOFT_FLOATS,
  CAR_STRIDE,
  defaultAids,
  neutralInput,
  snapshotFloats,
  type SessionConfig,
} from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (pedestrians = 30): SessionConfig => ({
  mode: 'roam',
  trackId: '',
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  traffic: 8,
  police: 2,
  pedestrians,
  opponents: 0,
  laps: 0,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 5,
  conditions: { time: 'midday', weather: 'clear' },
});

const run = (world: World, seconds: number, each?: () => void) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    if (each) each();
    world.step(SIM_DT);
  }
};

describe('pedestrians', () => {
  it('fill the pavements of the downtown grid around the player and walk along them', () => {
    const world = World.forSession(config());
    const peds = world.pedestrians!;
    expect(peds.count).toBe(30);
    expect(world.pedestrianCount).toBe(30);
    const map = world.traffic!.map;
    const player = world.cars[0]!;
    run(world, 2);
    const active = peds.list.filter((p) => p.active);
    expect(active.length).toBeGreaterThanOrEqual(20);
    const before = active.map((p) => ({ p, x: p.x, z: p.z }));
    for (const p of active) {
      expect(Math.hypot(p.x - player.pos.x, p.z - player.pos.z)).toBeLessThan(270);
      if (p.state !== PED_WALKING) continue;
      // On a pavement: beside a downtown road, past its edge and within the pavement's width.
      const proj = map.project(p.x, p.z, { maxDist: 30, kinds: ['street', 'avenue'] })!;
      expect(proj).not.toBeNull();
      const half = proj.piece.halfWidth;
      expect(proj.dist).toBeGreaterThan(half - 0.1);
      expect(proj.dist).toBeLessThan(half + SIDEWALK + 0.6);
    }
    // A walking pace.
    run(world, 5);
    let moved = 0;
    for (const { p, x, z } of before) {
      if (!p.active) continue;
      const d = Math.hypot(p.x - x, p.z - z);
      if (d > 2) moved++;
      expect(d).toBeLessThan(5 * 2.2 + 4);
    }
    expect(moved).toBeGreaterThan(before.length / 2);
    // The snapshot carries them after the cars and the soft body.
    const out = new Float32Array(snapshotFloats(world.snapshotCount, 30));
    world.writeSnapshot(out);
    const base = world.snapshotCount * CAR_STRIDE + SOFT_FLOATS;
    const first = peds.list.findIndex((p) => p.active);
    expect(out[base + first * PED_STRIDE]).toBeCloseTo(peds.list[first]!.x, 3);
    expect(out[base + first * PED_STRIDE + 4]).toBe(peds.list[first]!.state);
  });

  it('cross signalled junctions only while the traffic they cross has red', () => {
    const world = World.forSession(config(60));
    const peds = world.pedestrians!;
    let crossings = 0;
    let bad = 0;
    const wasCrossing = new Set<number>();
    run(world, 90, () => {
      peds.list.forEach((p, i) => {
        const crossing = p.active && p.state === PED_CROSSING;
        if (crossing && !wasCrossing.has(i)) {
          crossings++;
          const j = p.junction!;
          if (j.node.control === 'signal') {
            if (signalState(j.node, j.crossAxis, peds.time) !== 'red') bad++;
          }
        }
        if (crossing) wasCrossing.add(i);
        else wasCrossing.delete(i);
      });
    });
    expect(crossings).toBeGreaterThan(3);
    expect(bad).toBe(0);
  });

  it('leap clear of a car bearing down on them', () => {
    const world = World.forSession(config());
    const peds = world.pedestrians!;
    const player = world.cars[0]!;
    run(world, 1);
    const ped = peds.list.find((p) => p.active && p.state === PED_WALKING)!;
    expect(ped).toBeDefined();
    // The car 20 m from the pedestrian, aimed straight at it, at 54 km/h.
    const yaw = Math.random() * Math.PI * 2;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    player.teleport({ x: ped.x - fx * 20, z: ped.z - fz * 20, yaw, y: ped.y + 0.5 });
    let leapt = false;
    run(world, 0.8, () => {
      player.vel.x = fx * 15;
      player.vel.z = fz * 15;
      if (ped.state === PED_LEAPING) leapt = true;
    });
    expect(leapt).toBe(true);
    // Off the car's line by more than its half width.
    const lateral = Math.abs(-(ped.x - player.pos.x) * fz + (ped.z - player.pos.z) * fx);
    expect(lateral).toBeGreaterThan(1.8);
  });

  it('hurry across when a horn sounds close by', () => {
    const world = World.forSession(config());
    const peds = world.pedestrians!;
    const player = world.cars[0]!;
    run(world, 1);
    // Someone crossing 15 m from the car, which is on the horn.
    const ped = peds.list[0]!;
    ped.active = true;
    ped.state = PED_CROSSING;
    ped.crossTo = ped.s + 20;
    ped.x = player.pos.x + 15;
    ped.z = player.pos.z;
    ped.y = player.pos.y;
    expect(ped.hurry).toBe(0);
    player.setInput({ ...neutralInput(), horn: true });
    run(world, 0.3, () => {
      ped.state = PED_CROSSING;
      ped.x = player.pos.x + 15;
      ped.z = player.pos.z;
    });
    expect(ped.hurry).toBeGreaterThan(0);
  });

  it('stop the traffic while someone is crossing in front of it', () => {
    const world = World.forSession(config());
    const traffic = world.traffic!;
    const peds = world.pedestrians!;
    run(world, 2);
    // A traffic car on a lane with a clear run ahead of it.
    const car = traffic.vehicles.find(
      (v) => v.active && !v.police && !v.racer && v.mode === 'lane' && v.link.length - v.s > 60,
    )!;
    expect(car).toBeDefined();
    const point = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
    traffic.graph.pointAt(car.link, car.s + 30, point);
    // Someone planted in its lane 30 m ahead, crossing.
    const ped = peds.list[0]!;
    const plant = () => {
      ped.active = true;
      ped.state = PED_CROSSING;
      ped.x = point.x;
      ped.z = point.z;
      ped.y = point.y;
    };
    plant();
    run(world, 6, plant);
    expect(car.v).toBeLessThan(0.5);
    expect(car.link.length - car.s).toBeGreaterThan(0);
    const gap = Math.hypot(car.x - point.x, car.z - point.z);
    expect(gap).toBeGreaterThan(2);
  });
});
