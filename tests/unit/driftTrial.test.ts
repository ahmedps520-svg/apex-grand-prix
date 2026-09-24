import { describe, expect, it } from 'vitest';
import { driftMedal, driftTargets } from '../../src/content/driftTrial';
import { TRACKS } from '../../src/content/tracks';
import { defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

describe('drift trial targets', () => {
  it('scale with the lap and the laps, and hand out the medals', () => {
    const one = driftTargets(4000, 1);
    expect(one).toEqual({ gold: 5600, silver: 3200, bronze: 1600 });
    const two = driftTargets(4000, 2);
    expect(two.gold).toBe(one.gold * 2);
    // Nothing under bronze, and a tiny circuit still asks for something.
    expect(driftTargets(100, 1).bronze).toBeGreaterThan(0);
    expect(driftMedal(5600, one)).toBe('gold');
    expect(driftMedal(4000, one)).toBe('silver');
    expect(driftMedal(1600, one)).toBe('bronze');
    expect(driftMedal(1599, one)).toBeNull();
  });
});

describe('a drift trial session', () => {
  it('is a time trial with the laps on the clock and nobody else on the track', () => {
    const config: SessionConfig = {
      mode: 'timeTrial',
      trackId: TRACKS[0]!.id,
      carId: 'gt',
      location: 'loop',
      roamStart: 'downtown',
      opponents: 5,
      laps: 3,
      difficulty: 'medium',
      gridSlot: 0,
      aids: defaultAids(),
      seed: 4,
      conditions: { time: 'midday', weather: 'clear' },
      handling: 'arcade',
      drift: 2,
    };
    const world = World.forSession(config);
    expect(world.cars.length).toBe(1);
    const status = world.director!.status;
    expect(status.mode).toBe('timeTrial');
    expect(status.laps).toBe(2);
    expect(status.go).toBe(true);
    // A plain time trial has no distance.
    const plain = World.forSession({ ...config, drift: undefined });
    expect(plain.director!.status.laps).toBe(0);
  });
});
