import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import {
  CAR_STRIDE,
  FLAG_RETIRED,
  SIM_DT,
  defaultAids,
  snapshotFloats,
  type SessionConfig,
} from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
  mode: 'race',
  trackId: TRACKS[0]!.id,
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  opponents: 3,
  laps: 10,
  difficulty: 'medium',
  gridSlot: 3,
  aids: defaultAids(),
  seed: 21,
  conditions: { time: 'midday', weather: 'clear' },
  elimination: 6,
  ...extra,
});

const run = (world: World, seconds: number) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) world.step(SIM_DT);
};

/** Runs until the lights go out. */
const start = (world: World) => {
  for (let i = 0; i < 400 * 12 && world.director!.status.phase !== 'racing'; i++)
    world.step(SIM_DT);
  expect(world.director!.status.phase).toBe('racing');
};

describe('elimination races', () => {
  it('puts the last car out every so often, until the last one running has won', () => {
    const world = World.forSession(config());
    const status = world.director!.status;
    expect(status.elimination).toEqual({ every: 6, next: 6, out: 0 });
    start(world);
    // The clock runs from lights out.
    run(world, 3);
    expect(status.elimination!.next).toBeCloseTo(3, 1);
    expect(status.cars.filter((c) => c.finished).length).toBe(0);
    run(world, 3.1);
    expect(status.elimination!.out).toBe(1);
    const out1 = status.cars.findIndex((c) => c.eliminated);
    expect(out1).toBeGreaterThanOrEqual(0);
    expect(status.cars[out1]!.position).toBe(4);
    // Out means off the track: still, unseen, and left alone by the others.
    const car = world.cars[out1]!;
    expect(car.retired).toBe(true);
    const x = car.pos.x;
    const z = car.pos.z;
    run(world, 6.1);
    expect(car.pos.x).toBe(x);
    expect(car.pos.z).toBe(z);
    expect(status.elimination!.out).toBe(2);
    const outs = status.cars.filter((c) => c.eliminated);
    expect(outs.length).toBe(2);
    // The second out ranks above the first.
    const second = status.cars.find((c) => c.eliminated && c !== status.cars[out1])!;
    expect(second.position).toBe(3);
    expect(status.cars[out1]!.position).toBe(4);
    // The third elimination leaves one car: it has won, and the race is over.
    run(world, 6.1);
    expect(status.elimination!.out).toBe(3);
    const winner = status.cars.find((c) => c.finished && !c.eliminated)!;
    expect(winner).toBeDefined();
    expect(winner.position).toBe(1);
    expect(status.cars.every((c) => c.finished)).toBe(true);
    expect(status.phase).toBe('finished');
  });

  it('marks a retired car in the snapshot flags and brings it back on a restart', () => {
    const world = World.forSession(config({ elimination: 4 }));
    start(world);
    run(world, 4.2);
    const outIndex = world.director!.status.cars.findIndex((c) => c.eliminated);
    expect(outIndex).toBeGreaterThanOrEqual(0);
    expect(world.cars[outIndex]!.retired).toBe(true);
    const snapshot = new Float32Array(snapshotFloats(world.snapshotCount));
    world.writeSnapshot(snapshot);
    expect(snapshot[outIndex * CAR_STRIDE + 24]! & FLAG_RETIRED).toBe(FLAG_RETIRED);
    const running = world.director!.status.cars.findIndex((c) => !c.finished);
    expect(snapshot[running * CAR_STRIDE + 24]! & FLAG_RETIRED).toBe(0);
    world.restartSession(0);
    expect(world.cars.every((c) => !c.retired)).toBe(true);
    const status = world.director!.status;
    expect(status.elimination).toEqual({ every: 4, next: 4, out: 0 });
    expect(status.cars.every((c) => !c.eliminated && !c.finished)).toBe(true);
  });

  it('leaves a standard race alone', () => {
    const world = World.forSession(config({ elimination: undefined }));
    expect(world.director!.status.elimination).toBeNull();
    start(world);
    run(world, 15);
    expect(world.director!.status.cars.some((c) => c.eliminated)).toBe(false);
    expect(world.cars.every((c) => !c.retired)).toBe(true);
  });
});
