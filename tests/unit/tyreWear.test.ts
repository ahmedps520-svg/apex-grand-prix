import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import { defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { wearGrip } from '../../src/sim/vehicle/car';
import { World } from '../../src/sim/world';

const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
  mode: 'race',
  trackId: TRACKS[0]!.id,
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  opponents: 3,
  laps: 5,
  difficulty: 'medium',
  gridSlot: 3,
  aids: defaultAids(),
  seed: 9,
  conditions: { time: 'midday', weather: 'clear' },
  ...extra,
});

describe('tyre wear in a session', () => {
  it('follows the setting for every car, and a restart brings new tyres', () => {
    const none = World.forSession(config());
    expect(none.cars.every((c) => c.wearRate === 0)).toBe(true);
    const fast = World.forSession(config({ tyreWear: 2.5 }));
    expect(fast.cars.every((c) => c.wearRate === 2.5)).toBe(true);
    for (const w of fast.cars[0]!.wheels) w.wear = 0.7;
    expect(fast.cars[0]!.tyreWear).toBeCloseTo(0.7, 6);
    expect(fast.cars[0]!.gripFactor).toBeCloseTo(wearGrip(0.7), 6);
    fast.restartSession(0);
    expect(fast.cars[0]!.tyreWear).toBe(0);
  });

  it('loses grip with the tread, faster towards the end', () => {
    expect(wearGrip(0)).toBe(1);
    expect(wearGrip(0.5)).toBeGreaterThan(wearGrip(1));
    expect(wearGrip(1)).toBeCloseTo(0.82, 6);
    expect(1 - wearGrip(0.5)).toBeLessThan((1 - wearGrip(1)) / 2);
    expect(wearGrip(2)).toBe(wearGrip(1));
  });
});
