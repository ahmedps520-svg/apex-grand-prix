import { describe, expect, it } from 'vitest';
import { dailyChallenge, dailyKey } from '../../src/content/daily';
import { TRACKS } from '../../src/content/tracks';
import { CARS } from '../../src/sim/vehicle/cars';

describe('the daily challenge', () => {
  it('is the same all day for everyone, and drawn from everything on offer', () => {
    const day = new Date('2026-09-24T12:00:00Z');
    expect(dailyKey(day)).toBe('2026-09-24');
    const a = dailyChallenge(day);
    const b = dailyChallenge(new Date('2026-09-24T23:59:00Z'));
    expect(a).toEqual(b);
    expect(a.key).toBe('2026-09-24');
    expect(TRACKS.some((t) => t.id === a.trackId)).toBe(true);
    expect(CARS.some((c) => c.id === a.carId)).toBe(true);
    // Over a month the picks move around.
    const tracks = new Set<string>();
    const cars = new Set<string>();
    for (let d = 1; d <= 30; d++) {
      const c = dailyChallenge(new Date(`2026-10-${String(d).padStart(2, '0')}T08:00:00Z`));
      tracks.add(c.trackId);
      cars.add(c.carId);
    }
    expect(tracks.size).toBeGreaterThan(3);
    expect(cars.size).toBeGreaterThan(5);
  });
});
