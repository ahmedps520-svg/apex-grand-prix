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
  opponents: 2,
  laps: 3,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 3,
  conditions: { time: 'midday', weather: 'clear' },
  ...extra,
});

describe('race rules in a session', () => {
  it('are on when the config says so, and off otherwise', () => {
    expect(World.forSession(config({ rules: true })).director!.status.rules).toBe(true);
    expect(World.forSession(config()).director!.status.rules).toBe(false);
    const status = World.forSession(config({ rules: true })).director!.status;
    expect(status.yellow).toBe(-1);
    expect(status.cars.every((c) => c.flag === 'none' && c.warnings === 0 && c.penalty === 0)).toBe(
      true,
    );
  });
});
