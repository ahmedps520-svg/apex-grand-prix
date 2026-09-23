import { describe, expect, it } from 'vitest';
import {
  LIVERY_COLOURS,
  LIVERY_PATTERNS,
  LIVERY_PRESETS,
  colourDifference,
  defaultLivery,
  inkOn,
  numberColours,
  randomLivery,
  sanitizeLivery,
} from '../../src/content/livery';
import { PAINTS } from '../../src/content/paints';
import { mulberry32 } from '../../src/shared/math';

describe('liveries', () => {
  it('sanitizeLivery falls back to the default for garbage', () => {
    expect(sanitizeLivery(undefined)).toEqual(defaultLivery());
    expect(sanitizeLivery('stripes')).toEqual(defaultLivery());
    expect(sanitizeLivery(null)).toEqual(defaultLivery());
  });

  it('sanitizeLivery keeps valid fields and repairs the rest', () => {
    const d = defaultLivery();
    const l = sanitizeLivery({
      primary: 0x14306b,
      secondary: -5,
      accent: 0x1000000,
      pattern: 'polka dots',
      number: 150,
      finish: 'metallic',
    });
    expect(l).toEqual({
      primary: 0x14306b,
      secondary: d.secondary,
      accent: d.accent,
      pattern: d.pattern,
      number: 99,
      finish: 'metallic',
    });
    expect(sanitizeLivery({ ...d, number: 0 }).number).toBe(1);
    expect(sanitizeLivery({ ...d, number: 7.6 }).number).toBe(8);
    expect(sanitizeLivery({ ...d, number: 'seven' }).number).toBe(d.number);
    expect(sanitizeLivery({ ...d, primary: 0.5 }).primary).toBe(d.primary);
  });

  it('valid liveries round-trip through JSON unchanged', () => {
    for (const { livery } of LIVERY_PRESETS) {
      expect(sanitizeLivery(JSON.parse(JSON.stringify(livery)))).toEqual(livery);
    }
  });

  it('randomLivery is deterministic, valid and readable', () => {
    expect(randomLivery(mulberry32(3))).toEqual(randomLivery(mulberry32(3)));
    const rand = mulberry32(1234);
    const palette = new Set(LIVERY_COLOURS.map((c) => c.hex));
    const patterns = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const l = randomLivery(rand);
      expect(sanitizeLivery(l)).toEqual(l);
      expect(palette.has(l.primary) && palette.has(l.secondary) && palette.has(l.accent)).toBe(
        true,
      );
      // The pattern always shows against the base colour.
      expect(colourDifference(l.primary, l.secondary)).toBeGreaterThan(0.2);
      expect(l.accent).not.toBe(l.primary);
      patterns.add(l.pattern);
    }
    expect(patterns.size).toBe(LIVERY_PATTERNS.length);
  });

  it('randomLivery can keep clear of another livery', () => {
    const player = defaultLivery();
    const rand = mulberry32(99);
    for (let i = 0; i < 200; i++) {
      const l = randomLivery(rand, player);
      expect(colourDifference(l.primary, player.primary)).toBeGreaterThan(0.15);
    }
  });

  it('the palette holds every player paint and the numbers stay readable', () => {
    const hexes = LIVERY_COLOURS.map((c) => c.hex);
    for (const p of PAINTS) expect(hexes).toContain(p.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
    for (const { livery } of [...LIVERY_PRESETS, { livery: defaultLivery() }]) {
      const { fill, ink } = numberColours(livery);
      expect(ink).toBe(inkOn(fill));
      expect(colourDifference(fill, ink)).toBeGreaterThan(0.4);
    }
  });
});
