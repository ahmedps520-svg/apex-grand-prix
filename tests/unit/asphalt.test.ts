import { describe, expect, it } from 'vitest';
import { RUBBER_ACROSS, bakeAsphalt, bakeRubber } from '../../src/render/asphalt';

const mean = (bytes: Uint8Array, channel = 0): number => {
  let sum = 0;
  for (let i = channel; i < bytes.length; i += 4) sum += bytes[i]!;
  return sum / (bytes.length / 4);
};

describe('asphalt', () => {
  const a = bakeAsphalt(128, 7);

  it('is baked the same every time', () => {
    const b = bakeAsphalt(128, 7);
    expect(b.albedo).toEqual(a.albedo);
    expect(b.normal).toEqual(a.normal);
    expect(bakeAsphalt(128, 8).albedo).not.toEqual(a.albedo);
  });

  it('is a weathered grey with the aggregate showing, dull binder and polished stones', () => {
    const grey = mean(a.albedo);
    expect(grey).toBeGreaterThan(55);
    expect(grey).toBeLessThan(100);
    // The brightest pixels (stones) are smoother than the darkest (binder).
    let brightRough = 0;
    let bright = 0;
    let darkRough = 0;
    let dark = 0;
    for (let i = 0; i < a.albedo.length; i += 4) {
      if (a.albedo[i]! > grey + 30) {
        brightRough += a.rough[i + 1]!;
        bright++;
      } else if (a.albedo[i]! < grey - 10) {
        darkRough += a.rough[i + 1]!;
        dark++;
      }
    }
    expect(bright).toBeGreaterThan(50);
    expect(brightRough / bright).toBeLessThan(darkRough / dark - 20);
  });

  it('has bumps that mostly face up, and tiles without a seam', () => {
    expect(mean(a.normal, 2)).toBeGreaterThan(220);
    // Across the wrap neighbouring columns differ no more than any two inside the texture.
    const size = a.size;
    const at = (x: number, y: number) => a.albedo[(y * size + x) * 4]!;
    const step = (x0: number, x1: number) => {
      let sum = 0;
      for (let y = 0; y < size; y++) sum += Math.abs(at(x1, y) - at(x0, y));
      return sum;
    };
    let worst = 0;
    for (let x = 0; x < size - 1; x++) worst = Math.max(worst, step(x, x + 1));
    expect(step(size - 1, 0)).toBeLessThanOrEqual(worst);
  });
});

describe('the rubbered-in racing line', () => {
  // A 1 km lap: a straight to a braking zone and back, the line swinging from side to side.
  const samples = 500;
  const lateral = Float32Array.from(
    { length: samples },
    (_, i) => Math.sin((i / samples) * Math.PI * 2) * 4,
  );
  const speed = Float32Array.from({ length: samples }, (_, i) =>
    i >= 200 && i < 230 ? 60 - (i - 200) * 1.5 : i >= 230 && i < 300 ? 15 + (i - 230) * 0.6 : 60,
  );
  const rubber = bakeRubber({
    length: 1000,
    apron: 8,
    lateral,
    speed,
    grid: [{ s: 900, lateral: 2 }],
  });
  const at = (s: number, lat: number) => {
    const a = Math.floor((s / 1000) * rubber.along);
    const j = Math.floor(((lat + 8) / 16) * rubber.across);
    return rubber.amount[(j * rubber.along + a) * 4]!;
  };

  it('lies on the line, darkest in the wheel tracks, and not off it', () => {
    expect(rubber.across).toBe(RUBBER_ACROSS);
    expect(rubber.along).toBe(samples);
    // At s = 100 m the line is 4·sin(0.2π) ≈ 2.35 m right.
    const line = 4 * Math.sin(0.2 * Math.PI);
    expect(at(100, line + 0.8)).toBeGreaterThan(at(100, line - 5));
    expect(at(100, line + 0.8)).toBeGreaterThan(60);
    expect(at(100, -7.5)).toBeLessThan(15);
  });

  it('is heavier where the cars brake hard than on the straight', () => {
    const braking = Math.max(...[-1, -0.5, 0, 0.5, 1].map((d) => at(430, lateral[215]! + 0.8 + d)));
    const straight = Math.max(
      ...[-1, -0.5, 0, 0.5, 1].map((d) => at(700, lateral[350]! + 0.8 + d)),
    );
    expect(braking).toBeGreaterThan(straight);
  });

  it('marks the grid where the cars launch', () => {
    expect(at(903, 2.8)).toBeGreaterThan(at(903, -6));
    expect(at(903, 2.8)).toBeGreaterThan(80);
  });
});
