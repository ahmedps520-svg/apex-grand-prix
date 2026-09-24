import { describe, expect, it } from 'vitest';
import {
  CITY_SUN_AZIMUTH,
  CITY_SUN_ELEVATION,
  CITY_SUN_HOUR,
  cityHourOf,
  citySunAt,
  citySunAzimuthAt,
} from '../../src/content/city/day';
import { SUN_ELEVATION, sunElevationAt } from '../../src/content/conditions';

describe("the city's day", () => {
  it("passes through the city's own sun at its hour, in the afternoon", () => {
    expect(CITY_SUN_HOUR).toBeGreaterThan(12);
    expect(CITY_SUN_HOUR).toBeLessThan(18);
    const sun = citySunAt(CITY_SUN_HOUR);
    expect(sun.elevation).toBeCloseTo(CITY_SUN_ELEVATION, 6);
    expect(sun.azimuth).toBeCloseTo(CITY_SUN_AZIMUTH, 6);
    expect(cityHourOf('track')).toBe(CITY_SUN_HOUR);
  });

  it('puts each time of day at an hour with its sun', () => {
    for (const [time, elevation] of Object.entries(SUN_ELEVATION)) {
      const hour = cityHourOf(time as keyof typeof SUN_ELEVATION);
      expect(sunElevationAt(hour)).toBeCloseTo(elevation, 6);
    }
    expect(cityHourOf('morning')).toBeLessThan(12);
    expect(cityHourOf('afternoon')).toBeGreaterThan(12);
    expect(cityHourOf('golden')).toBeGreaterThan(cityHourOf('afternoon'));
    expect(cityHourOf('dusk')).toBeGreaterThan(cityHourOf('golden'));
    expect(cityHourOf('night')).toBe(0);
  });

  it('moves the sun from east to west, 15° an hour, continuous round midnight', () => {
    expect(citySunAzimuthAt(9) - citySunAzimuthAt(6)).toBeCloseTo(45, 6);
    expect(citySunAzimuthAt(18)).toBeGreaterThan(citySunAzimuthAt(6));
    const wrap = (a: number) => ((a % 360) + 360) % 360;
    expect(wrap(citySunAzimuthAt(23.999))).toBeCloseTo(wrap(citySunAzimuthAt(0.001)), 1);
    expect(citySunAzimuthAt(30)).toBeCloseTo(citySunAzimuthAt(6), 6);
  });
});
