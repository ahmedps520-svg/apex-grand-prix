import { describe, expect, it } from 'vitest';
import { DragTimer, formatDragResult, type DragResult } from '../../src/app/dragTimer';
import { DRAG_STRIP } from '../../src/content/testGround';

/** Constant acceleration down the strip, sampled at `fps`. */
function runStrip(fps: number, accel = 8): DragResult[] {
  const timer = new DragTimer();
  const results: DragResult[] = [];
  const dt = 1 / fps;
  const x = DRAG_STRIP.x;
  let z = DRAG_STRIP.zStart + 5;
  let v = 0;
  // Standing on the line first.
  for (let i = 0; i < 10; i++) results.push(...timer.update(dt, x, z, 0));
  for (let t = 0; t < 40; t += dt) {
    v += accel * dt;
    z -= v * dt;
    results.push(...timer.update(dt, x, z, v));
  }
  return results;
}

describe('drag timer', () => {
  it('times 0–100, 0–200, 400 m and 1 km from a standing start', () => {
    const results = runStrip(60);
    const kinds = results.map((r) => (r.kind === 'speed' ? `${r.kmh}kmh` : `${r.metres}m`));
    expect(kinds).toEqual(['100kmh', '200kmh', '400m', '1000m']);
    // v = a·t → 100 km/h after 27.78 / 8 = 3.47 s (the run starts when the car moves).
    const t100 = results[0]!.time;
    expect(t100).toBeCloseTo(27.7778 / 8, 1);
  });

  it('gives the same times at 30 and 240 fps', () => {
    const slow = runStrip(30);
    const fast = runStrip(240);
    slow.forEach((r, i) => expect(Math.abs(r.time - fast[i]!.time)).toBeLessThan(0.05));
  });

  it('does not time rolling starts or cars elsewhere', () => {
    const timer = new DragTimer();
    // Already moving when reaching the line: never armed.
    let z = DRAG_STRIP.zStart + 30;
    const out: DragResult[] = [];
    for (let i = 0; i < 600; i++) {
      z -= 30 / 60;
      out.push(...timer.update(1 / 60, DRAG_STRIP.x, z, 30));
    }
    expect(out).toEqual([]);
  });

  it('formats results in the chosen units', () => {
    expect(formatDragResult({ kind: 'speed', kmh: 100, time: 3.214 }, 'metric')).toBe(
      '0–100 km/h in 3.21 s',
    );
    expect(
      formatDragResult({ kind: 'distance', metres: 400, time: 10.9, trapKmh: 230 }, 'imperial'),
    ).toBe('400 m in 10.90 s at 143 mph');
  });
});
