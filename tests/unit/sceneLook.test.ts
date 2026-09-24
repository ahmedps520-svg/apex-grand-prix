import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import { sceneLook } from '../../src/render/sceneLook';

const theme = TRACKS[0]!.theme;

describe('the scene look', () => {
  it("keeps the circuit's own sun by default and follows a chosen time", () => {
    const own = sceneLook(theme);
    expect(own.sunElevation).toBe(theme.sunElevation);
    expect(own.sunAzimuth).toBe(theme.sunAzimuth);
    expect(own.night).toBe(0);
    const night = sceneLook(theme, { time: 'night', weather: 'clear' });
    expect(night.sunElevation).toBe(-14);
    expect(night.night).toBe(1);
    expect(night.sunIntensity).toBeLessThan(own.sunIntensity * 0.2);
    const dusk = sceneLook(theme, { time: 'dusk', weather: 'clear' });
    expect(dusk.night).toBeGreaterThanOrEqual(0);
    expect(dusk.night).toBeLessThan(0.2);
  });

  it('puts the sun where the clock says, and changes smoothly as it moves', () => {
    const clear = { time: 'track' as const, weather: 'clear' as const };
    const a = sceneLook(theme, clear, { elevation: 20, azimuth: 100 });
    expect(a.sunElevation).toBe(20);
    expect(a.sunAzimuth).toBe(100);
    const b = sceneLook(theme, clear, { elevation: 20.5, azimuth: 101 });
    expect(Math.abs(a.sunIntensity - b.sunIntensity)).toBeLessThan(0.05);
    expect(a.fogColor.getHex()).not.toBe(sceneLook(theme, clear).fogColor.getHex());
    const under = sceneLook(theme, clear, { elevation: -10, azimuth: 300 });
    expect(under.night).toBeGreaterThan(0.9);
    // A closed cloud deck keeps its high, soft light whatever the sun.
    const overcast = sceneLook(
      theme,
      { ...clear, weather: 'overcast' },
      { elevation: 3, azimuth: 0 },
    );
    expect(overcast.lightElevation).toBeGreaterThan(50);
  });
});

describe('the shadow light', () => {
  it("shines from the sun by day and from the moon's side at night", () => {
    const day = sceneLook(theme, { time: 'midday', weather: 'clear' });
    expect(day.lightAzimuth).toBe(day.sunAzimuth);
    expect(day.lightElevation).toBe(60);
    const night = sceneLook(theme, { time: 'night', weather: 'clear' });
    expect(night.lightAzimuth).toBeCloseTo(night.sunAzimuth + 180, 9);
    expect(night.lightElevation).toBeCloseTo(25, 9);
    // Twilight swings it part of the way, never with a jump.
    let last = sceneLook(
      theme,
      { time: 'track', weather: 'clear' },
      { elevation: 4, azimuth: 200 },
    );
    for (let e = 3.5; e >= -8; e -= 0.5) {
      const look = sceneLook(
        theme,
        { time: 'track', weather: 'clear' },
        { elevation: e, azimuth: 200 },
      );
      expect(Math.abs(look.lightAzimuth - last.lightAzimuth)).toBeLessThan(25);
      expect(Math.abs(look.lightElevation - last.lightElevation)).toBeLessThan(4);
      last = look;
    }
    expect(last.lightAzimuth).toBeCloseTo(380, 6);
  });
});
