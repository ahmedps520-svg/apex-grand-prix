import { describe, expect, it } from 'vitest';
import { SKID_CAPACITY, SkidMarks, skidIntensity } from '../../src/render/SkidMarks';
import { SURFACE } from '../../src/sim/track/surface';

const wheel = (over: Partial<Parameters<typeof skidIntensity>[0]> = {}) => ({
  contact: true,
  surface: SURFACE.ASPHALT,
  slip: 0.1,
  slipRatio: 0,
  ...over,
});

describe('skid marks', () => {
  it('come from sliding, locked or spinning tyres on tarmac, never from grip or grass', () => {
    expect(skidIntensity(wheel())).toBe(0);
    expect(skidIntensity(wheel({ slip: 1.2 }))).toBeGreaterThan(0.5);
    expect(skidIntensity(wheel({ slipRatio: -0.8 }))).toBeGreaterThan(0.5);
    expect(skidIntensity(wheel({ slipRatio: 0.9 }))).toBeGreaterThan(0.3);
    expect(skidIntensity(wheel({ slip: 1.2, surface: SURFACE.GRASS }))).toBe(0);
    expect(skidIntensity(wheel({ slip: 1.2, contact: false }))).toBe(0);
    expect(skidIntensity(wheel({ slip: 99 }))).toBeLessThanOrEqual(0.85);
  });

  it('lay joined strips behind a sliding wheel, and start afresh after a gap', () => {
    const marks = new SkidMarks(64);
    marks.wheel(0, 0, 0, 0, 0.3, 0.8);
    expect(marks.count).toBe(0);
    marks.wheel(0, 0.1, 0, 0, 0.3, 0.8);
    expect(marks.count).toBe(0);
    marks.wheel(0, 1, 0, 0, 0.3, 0.8);
    marks.wheel(0, 2, 0, 0, 0.3, 0.8);
    expect(marks.count).toBe(2);
    const p = marks.mesh.geometry.getAttribute('position');
    // The second strip starts where the first ended, a tyre's width across.
    expect(p.getX(4)).toBeCloseTo(p.getX(2));
    expect(p.getZ(4)).toBeCloseTo(p.getZ(2));
    expect(Math.abs(p.getZ(2) - p.getZ(3))).toBeCloseTo(0.3);
    // The first strip fades in; the second runs at full strength.
    const a = marks.mesh.geometry.getAttribute('strength');
    expect(a.getX(0)).toBe(0);
    expect(a.getX(2)).toBeCloseTo(0.8);
    // Gripping again ends the mark; a jump of 10 m does not draw across it.
    marks.wheel(0, 3, 0, 0, 0.3, 0);
    marks.wheel(0, 13, 0, 0, 0.3, 0.8);
    marks.wheel(0, 23, 0, 0, 0.3, 0.8);
    expect(marks.count).toBe(2);
  });

  it('reuse the oldest strips once the ring is full, and clear for a new session', () => {
    const marks = new SkidMarks(8);
    for (let i = 0; i < 20; i++) marks.wheel(1, i, 0, 0, 0.3, 0.8);
    expect(marks.count).toBe(19);
    marks.flush();
    marks.clear();
    expect(marks.count).toBe(0);
    expect(SKID_CAPACITY).toBeGreaterThan(1000);
  });
});
