import { describe, expect, it } from 'vitest';
import { TRACKS, trackById } from '../../src/content/tracks';
import { Track, type TrackDef } from '../../src/sim/track/Track';
import { SURFACE } from '../../src/sim/track/surface';

const files = import.meta.glob<Record<string, unknown>>('../../src/content/tracks/*.ts', {
  eager: true,
});

const isTrackDef = (value: unknown): value is TrackDef =>
  typeof value === 'object' && value !== null && 'id' in value && 'points' in value;

/** Calls `visit(i, j)` (i < j) for every pair of samples less than `cell` metres apart, and more. */
function forNearbyPairs(track: Track, cell: number, visit: (i: number, j: number) => void): void {
  const grid = new Map<string, number[]>();
  const cellOf = (i: number) => {
    const p = track.samples[i]!;
    return [Math.floor(p.x / cell), Math.floor(p.z / cell)] as const;
  };
  track.samples.forEach((_, i) => {
    const key = cellOf(i).join();
    const list = grid.get(key);
    if (list) list.push(i);
    else grid.set(key, [i]);
  });
  track.samples.forEach((_, i) => {
    const [cx, cz] = cellOf(i);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++)
        for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) if (j > i) visit(i, j);
  });
}

/** Do segments ab and cd properly cross? */
function crosses(
  a: { x: number; z: number },
  b: { x: number; z: number },
  c: { x: number; z: number },
  d: { x: number; z: number },
): boolean {
  const side = (p: typeof a, q: typeof a, r: typeof a) =>
    Math.sign((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x));
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

describe('track catalogue', () => {
  it('has one circuit per file, with an id matching the file name, all listed once', () => {
    const defs: TrackDef[] = [];
    for (const [path, module] of Object.entries(files)) {
      if (path.endsWith('/index.ts')) continue;
      const exported = Object.values(module).filter(isTrackDef);
      expect(exported, path).toHaveLength(1);
      const def = exported[0]!;
      expect(def.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(path.endsWith(`/${def.id}.ts`), path).toBe(true);
      defs.push(def);
    }
    expect(new Set(TRACKS.map((t) => t.id)).size).toBe(TRACKS.length);
    expect(new Set(TRACKS)).toEqual(new Set(defs));
    for (const def of TRACKS) expect(trackById(def.id)).toBe(def);
    expect(trackById('no-such-track')).toBeUndefined();
  });
});

describe.each(TRACKS.map((def) => [def.id, def] as const))('%s', (_id, def) => {
  const track = new Track(def);
  const { samples, length } = track;
  const n = samples.length;

  it('has sensible dimensions and race settings', () => {
    expect(def.width).toBeGreaterThanOrEqual(12);
    expect(def.width).toBeLessThanOrEqual(16);
    expect(def.runoff).toBeGreaterThanOrEqual(6);
    expect(def.runoff).toBeLessThanOrEqual(25);
    expect(def.laps).toBeGreaterThanOrEqual(3);
    expect(def.laps).toBeLessThanOrEqual(5);
    expect(length).toBeGreaterThan(2000);
    expect(length).toBeLessThan(6000);
  });

  it('is a closed loop that never crosses itself', () => {
    const first = samples[0]!;
    const last = samples[n - 1]!;
    expect(Math.hypot(first.x - last.x, first.z - last.z)).toBeLessThan(2.5);
    let crossings = 0;
    forNearbyPairs(track, 10, (i, j) => {
      if (j - i < 2 || (i === 0 && j === n - 1)) return;
      if (crosses(samples[i]!, samples[i + 1]!, samples[j]!, samples[(j + 1) % n]!)) crossings++;
    });
    expect(crossings).toBe(0);
  });

  it('keeps other parts of the lap clear of each barrier', () => {
    // Centre lines of distinct sections (far apart along the lap) are at least two barrier
    // offsets plus 6 m apart, so no barrier can overlap another section.
    const clearance = 2 * track.wallOffset + 6;
    const distinct = 2 * track.wallOffset + 60;
    let closest = Infinity;
    forNearbyPairs(track, clearance, (i, j) => {
      const p = samples[i]!;
      const q = samples[j]!;
      const gap = Math.abs(p.s - q.s);
      if (Math.min(gap, length - gap) <= distinct) return;
      closest = Math.min(closest, Math.hypot(p.x - q.x, p.z - q.z));
    });
    expect(closest).toBeGreaterThanOrEqual(clearance);
  });

  it('has no corner tighter than 16 m radius', () => {
    const tightest = Math.max(...samples.map((p) => Math.abs(p.curvature)));
    expect(tightest).toBeLessThanOrEqual(1 / 16);
  });

  it('starts on a straight with the whole grid on asphalt', () => {
    const startZone = samples.filter((p) => p.s >= length - 220 || p.s <= 120);
    expect(Math.max(...startZone.map((p) => Math.abs(p.curvature)))).toBeLessThan(1 / 500);
    for (let slot = 0; slot < 12; slot++) {
      const g = track.gridSlot(slot);
      expect(track.surfaceAt(g.x, g.z), `slot ${slot}`).toBe(SURFACE.ASPHALT);
    }
  });

  it('fits within 1.5 km of the origin, roughly centred', () => {
    const xs = samples.map((p) => p.x);
    const zs = samples.map((p) => p.z);
    const [minX, maxX, minZ, maxZ] = [
      Math.min(...xs),
      Math.max(...xs),
      Math.min(...zs),
      Math.max(...zs),
    ];
    expect(Math.max(-minX, maxX, -minZ, maxZ) + track.wallOffset).toBeLessThanOrEqual(1500);
    expect(Math.abs(minX + maxX) / 2).toBeLessThan(50);
    expect(Math.abs(minZ + maxZ) / 2).toBeLessThan(50);
  });
});
