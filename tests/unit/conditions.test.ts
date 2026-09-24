import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONDITIONS,
  SUN_ELEVATION,
  TIMES_OF_DAY,
  WEATHERS,
  darkness,
  gripFactor,
  isRaining,
  sanitizeConditions,
  sunElevation,
  wetness,
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
});
