import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONDITIONS,
  SUN_ELEVATION,
  DAY_LENGTHS,
  DAY_MINUTES,
  SUNRISE,
  SUNSET,
  TIMES_OF_DAY,
  WEATHERS,
  afterDark,
  clockText,
  darkness,
  darknessAt,
  dayRate,
  gripFactor,
  hourAtElevation,
  hourOf,
  isDayLength,
  isRaining,
  sanitizeConditions,
  sunElevation,
  sunElevationAt,
  sunPathAt,
  wetness,
  wrapHour,
} from '../../src/content/conditions';

describe('conditions', () => {
  it('lists every option once', () => {
    const times = TIMES_OF_DAY.map((o) => o.value);
    expect(new Set(times).size).toBe(times.length);
    expect(times).toEqual(['track', ...Object.keys(SUN_ELEVATION)]);
    const weathers = WEATHERS.map((o) => o.value);
    expect(new Set(weathers).size).toBe(weathers.length);
    for (const o of [...TIMES_OF_DAY, ...WEATHERS]) expect(o.text.length).toBeGreaterThan(0);
  });

  it('gets wetter and less grippy as the rain gets heavier', () => {
    expect(WEATHERS.map((o) => wetness(o.value))).toEqual([0, 0, 0, 0.55, 1]);
    expect(WEATHERS.map((o) => gripFactor(o.value))).toEqual([1, 1, 1, 0.85, 0.72]);
    expect(WEATHERS.filter((o) => isRaining(o.value)).map((o) => o.value)).toEqual([
      'lightRain',
      'heavyRain',
    ]);
  });

  it('keeps the circuit sun for "track" and sets it otherwise', () => {
    expect(sunElevation('track', 42)).toBe(42);
    expect(sunElevation('midday', 42)).toBe(60);
    expect(sunElevation('dusk', 42)).toBe(2);
  });

  it('sanitizes stored conditions', () => {
    expect(sanitizeConditions({ time: 'golden', weather: 'heavyRain' })).toEqual({
      time: 'golden',
      weather: 'heavyRain',
    });
    expect(sanitizeConditions({ time: 'midnight', weather: 'snow' })).toEqual(DEFAULT_CONDITIONS);
    expect(sanitizeConditions(null)).toEqual(DEFAULT_CONDITIONS);
  });
});

describe('darkness', () => {
  it('runs from day to night', () => {
    expect(darkness('track')).toBe(0);
    expect(darkness('midday')).toBe(0);
    expect(darkness('golden')).toBeGreaterThan(0);
    expect(darkness('dusk')).toBeGreaterThan(darkness('golden'));
    expect(darkness('night')).toBe(1);
  });

  it('follows the sun down, never getting lighter as it sinks', () => {
    expect(darknessAt(60)).toBe(0);
    expect(darknessAt(12)).toBe(0);
    expect(darknessAt(7)).toBeCloseTo(darkness('golden'), 9);
    expect(darknessAt(2)).toBeCloseTo(darkness('dusk'), 9);
    expect(darknessAt(-6)).toBe(1);
    expect(darknessAt(-14)).toBe(1);
    expect(darknessAt(Number.NaN)).toBe(1);
    let last = 0;
    for (let e = 70; e >= -20; e -= 0.5) {
      const d = darknessAt(e);
      expect(d).toBeGreaterThanOrEqual(last);
      expect(d).toBeLessThanOrEqual(1);
      last = d;
    }
  });

  it('brings the headlights on at dusk and at night, not in golden hour', () => {
    expect(afterDark(SUN_ELEVATION.golden)).toBe(false);
    expect(afterDark(SUN_ELEVATION.dusk)).toBe(true);
    expect(afterDark(SUN_ELEVATION.night)).toBe(true);
    expect(afterDark(45)).toBe(false);
  });
});

describe("the day's clock", () => {
  it('lifts the sun from sunrise to 60° at noon and sinks it to 14° under by midnight', () => {
    expect(sunElevationAt(SUNRISE)).toBeCloseTo(0, 9);
    expect(sunElevationAt(12)).toBeCloseTo(60, 9);
    expect(sunElevationAt(SUNSET)).toBeCloseTo(0, 9);
    expect(sunElevationAt(0)).toBeCloseTo(-14, 9);
    expect(sunElevationAt(24)).toBeCloseTo(-14, 9);
    expect(sunElevationAt(9)).toBeCloseTo(sunElevationAt(15), 9);
    expect(sunElevationAt(21)).toBeCloseTo(sunElevationAt(3), 9);
    // Continuous over sunrise, sunset and midnight, and wrapping.
    expect(sunElevationAt(5.999)).toBeCloseTo(sunElevationAt(6.001), 1);
    expect(sunElevationAt(17.999)).toBeCloseTo(sunElevationAt(18.001), 1);
    expect(sunElevationAt(23.999)).toBeCloseTo(sunElevationAt(0.001), 2);
    expect(sunElevationAt(30)).toBeCloseTo(sunElevationAt(6), 9);
    expect(sunElevationAt(-3)).toBeCloseTo(sunElevationAt(21), 9);
  });

  it('finds the hour for a sun, either side of noon, and each time of day on it', () => {
    expect(hourAtElevation(60)).toBeCloseTo(12, 9);
    expect(hourAtElevation(0, 'morning')).toBeCloseTo(SUNRISE, 9);
    expect(hourAtElevation(0, 'afternoon')).toBeCloseTo(SUNSET, 9);
    expect(hourAtElevation(-14)).toBeCloseTo(0, 9);
    for (const e of [3, 15, 35, 55, -2, -9]) {
      expect(sunElevationAt(hourAtElevation(e, 'morning'))).toBeCloseTo(e, 9);
      expect(sunElevationAt(hourAtElevation(e, 'afternoon'))).toBeCloseTo(e, 9);
    }
    expect(hourAtElevation(90)).toBeCloseTo(12, 9);
    for (const [time, e] of Object.entries(SUN_ELEVATION)) {
      const hour = hourOf(time as keyof typeof SUN_ELEVATION, 30);
      expect(sunElevationAt(hour)).toBeCloseTo(e, 9);
    }
    expect(hourOf('morning', 30)).toBeLessThan(12);
    expect(hourOf('afternoon', 30)).toBeGreaterThan(12);
    expect(hourOf('night', 30)).toBe(0);
    // The circuit's own sun stands in the afternoon.
    expect(sunElevationAt(hourOf('track', 30))).toBeCloseTo(30, 9);
    expect(hourOf('track', 30)).toBeGreaterThan(12);
  });

  it("takes the sun across the sky through a circuit's own sun at its hour", () => {
    const own = sunPathAt(hourAtElevation(30, 'afternoon'), 30, 200);
    expect(own.elevation).toBeCloseTo(30, 9);
    expect(own.azimuth).toBeCloseTo(200, 9);
    expect(sunPathAt(9, 30, 200).azimuth - sunPathAt(6, 30, 200).azimuth).toBeCloseTo(45, 9);
    expect(sunPathAt(18, 30, 200).azimuth).toBeGreaterThan(sunPathAt(6, 30, 200).azimuth);
    const wrap = (a: number) => ((a % 360) + 360) % 360;
    expect(wrap(sunPathAt(23.999, 30, 200).azimuth)).toBeCloseTo(
      wrap(sunPathAt(0.001, 30, 200).azimuth),
      1,
    );
    expect(sunPathAt(30, 30, 200)).toEqual(sunPathAt(6, 30, 200));
  });

  it('wraps at midnight, reads as a clock and runs at the chosen rate', () => {
    expect(wrapHour(25.5)).toBeCloseTo(1.5, 9);
    expect(wrapHour(-1)).toBeCloseTo(23, 9);
    expect(wrapHour(24)).toBe(0);
    expect(clockText(18.7)).toBe('18:42');
    expect(clockText(0)).toBe('00:00');
    expect(clockText(23.999)).toBe('23:59');
    expect(clockText(24.25)).toBe('00:15');
    expect(clockText(Number.NaN)).toBe('00:00');
    expect(dayRate(24) * 24 * 60).toBeCloseTo(24, 9);
    expect(dayRate(60) * 3600).toBeCloseTo(24, 9);
    expect(dayRate(0)).toBe(0);
    expect(dayRate(Number.NaN)).toBe(0);
    expect(DAY_LENGTHS.map((o) => DAY_MINUTES[o.value])).toEqual([0, 24, 60]);
    expect(isDayLength('short')).toBe(true);
    expect(isDayLength('forever')).toBe(false);
  });
});
