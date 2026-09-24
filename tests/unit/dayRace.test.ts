import { describe, expect, it } from 'vitest';
import { afterDark, hourOf, sunElevationAt } from '../../src/content/conditions';
import { TRACKS } from '../../src/content/tracks';
import { SIM_DT, defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
  mode: 'race',
  trackId: TRACKS[0]!.id,
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  opponents: 2,
  laps: 1,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 11,
  conditions: { time: 'golden', weather: 'clear' },
  ...extra,
});

const run = (world: World, seconds: number) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) world.step(SIM_DT);
};

describe("the day's clock on a circuit", () => {
  it('runs through a race at the chosen rate and lights every car at dusk', () => {
    const world = World.forSession(config({ dayCycle: 24 }));
    const day = world.day!;
    expect(day).toBeTruthy();
    const theme = TRACKS[0]!.theme;
    expect(day.hour).toBeCloseTo(hourOf('golden', theme.sunElevation), 9);
    expect(afterDark(sunElevationAt(day.hour))).toBe(false);
    for (const car of world.cars) expect(car.headlights).toBe(false);
    run(world, 30);
    expect(day.hour).toBeCloseTo(hourOf('golden', theme.sunElevation) + 0.5, 2);
    expect(afterDark(sunElevationAt(day.hour))).toBe(true);
    for (const car of world.cars) expect(car.headlights).toBe(true);
  });

  it("stands still without a cycle, at the circuit's own sun by default", () => {
    const still = World.forSession(config());
    expect(still.day).toBeNull();
    for (const car of still.cars) expect(car.headlights).toBe(false);
    const own = World.forSession(config({ conditions: { time: 'track', weather: 'clear' } }));
    expect(own.day).toBeNull();
    // At night the cars run with their headlights on, cycle or not.
    const night = World.forSession(config({ conditions: { time: 'night', weather: 'clear' } }));
    expect(night.day).toBeNull();
    for (const car of night.cars) expect(car.headlights).toBe(true);
    run(night, 2);
    for (const car of night.cars) expect(car.headlights).toBe(true);
  });

  it('never runs on the proving ground', () => {
    const free = World.forSession(config({ mode: 'free', trackId: '', dayCycle: 24 }));
    expect(free.day).toBeNull();
  });
});
