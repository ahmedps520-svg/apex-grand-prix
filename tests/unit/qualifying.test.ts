import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import { defaultAids, type SessionConfig } from '../../src/shared/protocol';
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
  seed: 21,
  conditions: { time: 'midday', weather: 'clear' },
  ...extra,
});

describe('a qualifying session', () => {
  it('runs its own laps with nobody put out, and the grid it sets is kept for the race', () => {
    const quali = World.forSession(config({ qualifying: 2, elimination: 6 }));
    const s = quali.director!.status;
    expect(s.qualifying).toBe(true);
    expect(s.laps).toBe(2);
    expect(s.elimination).toBeNull();
    // The player starts from the slot chosen, the last.
    expect(s.order).toEqual([1, 2, 3, 0]);

    const race = World.forSession(config({ gridOrder: [2, 0, 3, 1], gridSlot: 1 }));
    const r = race.director!.status;
    expect(r.qualifying).toBe(false);
    expect(r.laps).toBe(5);
    expect(r.order).toEqual([2, 0, 3, 1]);
    race.restartSession(0);
    expect(race.director!.status.order).toEqual([2, 0, 3, 1]);
  });
});
