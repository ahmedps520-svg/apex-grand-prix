import { SURFACE, type RayHit, type Surface, type SurfaceId } from './surface';

/**
 * A race track built from a closed loop of control points: a smooth centre line sampled every
 * metre or so, with the road, kerbs, run-off and barriers defined by distance from it. Shared by
 * the simulation (surfaces, walls, AI racing line) and the renderer (meshes, minimap). Flat for
 * now: the ground is at height 0 everywhere.
 */

export interface TrackDef {
  id: string;
  name: string;
  /** One line for the track select screen. */
  description: string;
  /** Country / setting, fictional. */
  location: string;
  /** Closed centre line in driving order, metres: [x, z] (x right, z towards the viewer). */
  points: ReadonlyArray<readonly [number, number]>;
  /** Road width, metres. */
  width: number;
  /** Run-off (grass / gravel) width beyond the kerbs before the barrier, metres. */
  runoff: number;
  /** Default race laps. */
  laps: number;
  /** Look of the scenery. */
  theme: TrackTheme;
}

export interface TrackTheme {
  /** Ground around the track. */
  grass: number;
  /** Run-off in corners: gravel or grass. */
  runoffSurface: 'gravel' | 'grass';
  /** Sky: sun elevation in degrees (low = golden hour). */
  sunElevation: number;
  sunAzimuth: number;
  /** Fog colour and haze. */
  fog: number;
  trees: number;
  /** Colour of the barriers. */
  barrier: number;
}

export interface TrackSample {
  x: number;
  z: number;
  /** Unit tangent (driving direction). */
  tx: number;
  tz: number;
  /** Distance from the start line along the centre line. */
  s: number;
  /** Signed curvature, 1/m (> 0 turns left). */
  curvature: number;
}

export interface Projection {
  /** Distance along the lap (0 … length). */
  s: number;
  /** Signed distance from the centre line (> 0 = right of the driving direction). */
  lateral: number;
  /** Index of the nearest sample. */
  index: number;
}

const SAMPLE_SPACING = 2;
const CELL = 20;
/** Kerbs sit on corners tighter than this radius. */
const KERB_RADIUS = 220;
export const KERB_WIDTH = 1.4;
/** How far from the barrier face a car's body is pushed back. */
const WALL_STIFFNESS = 400_000;

export class Track implements Surface {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly halfWidth: number;
  /** Distance from the centre line to the barrier face. */
  readonly wallOffset: number;
  /** Per sample: is there a kerb on the left (-1) / right (+1) edge. */
  readonly kerbs: Array<{ left: boolean; right: boolean }> = [];
  /** Wet weather: multiplier on every surface's grip. */
  gripScale = 1;
  /** DRS zones along the long straights: [start, end] distances along the lap. */
  readonly drsZones: Array<[number, number]> = [];
  private readonly grid = new Map<number, number[]>();

  constructor(readonly def: TrackDef) {
    this.halfWidth = def.width / 2;
    this.wallOffset = this.halfWidth + KERB_WIDTH + def.runoff;
    const dense = sampleClosedSpline(def.points, 0.25);
    // Resample evenly by arc length.
    const cumulative: number[] = [0];
    for (let i = 1; i < dense.length; i++) {
      const a = dense[i - 1]!;
      const b = dense[i]!;
      cumulative.push(cumulative[i - 1]! + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    const first = dense[0]!;
    const last = dense[dense.length - 1]!;
    const total =
      cumulative[cumulative.length - 1]! + Math.hypot(first[0] - last[0], first[1] - last[1]);
    const count = Math.max(Math.round(total / SAMPLE_SPACING), 16);
    this.length = total;
    let j = 0;
    for (let i = 0; i < count; i++) {
      const s = (i / count) * total;
      while (j < dense.length - 1 && cumulative[j + 1]! < s) j++;
      const a = dense[j]!;
      const b = dense[(j + 1) % dense.length]!;
      const segment = (cumulative[j + 1] ?? total) - cumulative[j]!;
      const t = segment > 0 ? (s - cumulative[j]!) / segment : 0;
      this.samples.push({
        x: a[0] + (b[0] - a[0]) * t,
        z: a[1] + (b[1] - a[1]) * t,
        tx: 0,
        tz: 0,
        s,
        curvature: 0,
      });
    }
    const n = this.samples.length;
    for (let i = 0; i < n; i++) {
      const p = this.samples[(i - 1 + n) % n]!;
      const c = this.samples[i]!;
      const q = this.samples[(i + 1) % n]!;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      c.tx = dx / len;
      c.tz = dz / len;
    }
    for (let i = 0; i < n; i++) {
      // Curvature from the turn of the tangent over a few samples (smoother than neighbours).
      const a = this.samples[(i - 3 + n) % n]!;
      const b = this.samples[(i + 3) % n]!;
      const cross = a.tx * b.tz - a.tz * b.tx;
      const dot = a.tx * b.tx + a.tz * b.tz;
      // With x right and z towards the viewer, a left turn rotates the tangent anticlockwise
      // seen from above, which is a negative cross product here.
      this.samples[i]!.curvature = -Math.atan2(cross, dot) / (6 * SAMPLE_SPACING);
    }
    for (let i = 0; i < n; i++) {
      // Kerbs on the inside and outside of real corners, a little before and after them.
      let k = 0;
      for (let d = -6; d <= 6; d++)
        k = Math.max(k, Math.abs(this.samples[(i + d + n) % n]!.curvature));
      const corner = k > 1 / KERB_RADIUS;
      this.kerbs.push({ left: corner, right: corner });
    }
    this.buildGrid();
    this.findDrsZones();
  }
  /**
   * DRS zones: every straight (curvature under 1/600 per metre) at least 400 m long, from 60 m
   * after it starts to 120 m before the braking zone at its end.
   */
  private findDrsZones(): void {
    const n = this.samples.length;
    const straight = this.samples.map((p) => Math.abs(p.curvature) < 1 / 600);
    // Start scanning at a bend, so a straight across the start line isn't split in two.
    const first = straight.indexOf(false);
    if (first < 0) return;
    let runStart = -1;
    for (let k = 1; k <= n; k++) {
      const i = (first + k) % n;
      if (straight[i] && runStart < 0) runStart = k;
      if ((!straight[i] || k === n) && runStart >= 0) {
        const from = this.samples[(first + runStart) % n]!.s;
        const length = (k - runStart) * SAMPLE_SPACING;
        if (length >= 400) {
          const start = (from + 60) % this.length;
          this.drsZones.push([start, (start + length - 180) % this.length]);
        }
        runStart = -1;
      }
    }
  }

  /** True when `s` (distance along the lap) is inside a DRS zone. */
  inDrsZone(s: number): boolean {
    for (const [a, b] of this.drsZones) {
      if (a <= b ? s >= a && s <= b : s >= a || s <= b) return true;
    }
    return false;
  }

  /** Point on the centre line at distance `s` (wraps around the lap). */
  at(s: number): TrackSample {
    const n = this.samples.length;
    const u = ((s % this.length) + this.length) % this.length;
    return this.samples[Math.floor((u / this.length) * n) % n]!;
  }

  /** Where a point is relative to the track: distance along the lap and sideways offset. */
  project(x: number, z: number, hint = -1): Projection {
    const n = this.samples.length;
    let best = -1;
    let bestD = Infinity;
    const consider = (i: number) => {
      const p = this.samples[i]!;
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    };
    if (hint >= 0) {
      // Cheap path while following a car: search around the previous answer.
      for (let d = -12; d <= 12; d++) consider((hint + d + n) % n);
      if (bestD > 60 * 60) best = -1;
    }
    if (best < 0) {
      const cx = Math.floor(x / CELL);
      const cz = Math.floor(z / CELL);
      for (let r = 0; r <= 6 && best < 0; r++) {
        for (let gx = cx - r; gx <= cx + r; gx++) {
          for (let gz = cz - r; gz <= cz + r; gz++) {
            if (Math.max(Math.abs(gx - cx), Math.abs(gz - cz)) !== r) continue;
            for (const i of this.grid.get(key(gx, gz)) ?? []) consider(i);
          }
        }
      }
      if (best < 0) for (let i = 0; i < n; i++) consider(i);
    }
    // Refine between the nearest sample and its neighbours.
    const p = this.samples[best]!;
    const along = (x - p.x) * p.tx + (z - p.z) * p.tz;
    // Right of the driving direction: tangent rotated a quarter turn clockwise seen from above.
    const lateral = (x - p.x) * -p.tz + (z - p.z) * p.tx;
    let s = p.s + along;
    if (s < 0) s += this.length;
    if (s >= this.length) s -= this.length;
    return { s, lateral, index: best };
  }

  // ---------------------------------------------------------------- Surface

  heightAt(): number {
    return 0;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    const pr = this.project(x, z);
    return this.surfaceFor(pr);
  }

  surfaceFor(pr: Projection): SurfaceId {
    const d = Math.abs(pr.lateral);
    if (d <= this.halfWidth) return SURFACE.ASPHALT;
    const kerb = this.kerbs[pr.index];
    if (d <= this.halfWidth + KERB_WIDTH) {
      const onKerb = pr.lateral < 0 ? kerb?.left : kerb?.right;
      return onKerb ? SURFACE.KERB : SURFACE.ASPHALT;
    }
    if (this.def.theme.runoffSurface === 'gravel' && kerb?.left) return SURFACE.GRAVEL;
    return SURFACE.GRASS;
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    hit: RayHit,
  ): boolean {
    let t: number;
    if (oy <= 0) t = 0;
    else {
      if (dy >= -1e-6) return false;
      t = oy / -dy;
      if (t > maxDist) return false;
    }
    hit.distance = t;
    hit.nx = 0;
    hit.ny = 1;
    hit.nz = 0;
    hit.surface = this.surfaceAt(ox + dx * t, oz + dz * t);
    return true;
  }

  /**
   * Barrier contact for a body point: how far it is through the wall and the direction to push
   * it back (horizontal, unit length). Returns 0 when clear.
   */
  wallContact(x: number, z: number, out: { nx: number; nz: number }): number {
    const pr = this.project(x, z);
    const depth = Math.abs(pr.lateral) - this.wallOffset;
    if (depth <= 0) return 0;
    const p = this.samples[pr.index]!;
    // Push towards the centre line: opposite to the side the point is on.
    const side = Math.sign(pr.lateral);
    out.nx = p.tz * side;
    out.nz = -p.tx * side;
    return depth;
  }

  get wallStiffness(): number {
    return WALL_STIFFNESS;
  }

  /** Start line position and heading (yaw, radians; 0 = facing -z) for grid slot `slot`. */
  gridSlot(slot: number): { x: number; z: number; yaw: number } {
    // Two columns, 8 m apart along the track, staggered 4 m; the grid starts 12 m behind the line.
    const back = 12 + slot * 8;
    const p = this.at(this.length - back);
    const side = slot % 2 === 0 ? -1 : 1;
    const offset = side * Math.min(this.halfWidth * 0.45, 3.2);
    return {
      x: p.x + -p.tz * offset,
      z: p.z + p.tx * offset,
      yaw: Math.atan2(-p.tx, -p.tz),
    };
  }

  private buildGrid(): void {
    this.samples.forEach((p, i) => {
      const reach = Math.ceil((this.wallOffset + 8) / CELL);
      const cx = Math.floor(p.x / CELL);
      const cz = Math.floor(p.z / CELL);
      for (let gx = cx - reach; gx <= cx + reach; gx++) {
        for (let gz = cz - reach; gz <= cz + reach; gz++) {
          const k = key(gx, gz);
          let list = this.grid.get(k);
          if (!list) this.grid.set(k, (list = []));
          list.push(i);
        }
      }
    });
  }
}

const key = (gx: number, gz: number): number => (gx + 5000) * 10007 + (gz + 5000);

/** Centripetal Catmull-Rom through closed control points, sampled every `step` of the parameter. */
export function sampleClosedSpline(
  points: ReadonlyArray<readonly [number, number]>,
  step: number,
): Array<[number, number]> {
  const n = points.length;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n]!;
    const p1 = points[i]!;
    const p2 = points[(i + 1) % n]!;
    const p3 = points[(i + 2) % n]!;
    const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(Math.ceil(dist * step), 2);
    for (let k = 0; k < steps; k++) out.push(catmullRom(p0, p1, p2, p3, k / steps));
  }
  return out;
}

function catmullRom(
  p0: readonly [number, number],
  p1: readonly [number, number],
  p2: readonly [number, number],
  p3: readonly [number, number],
  t: number,
): [number, number] {
  const alpha = 0.5;
  const t0 = 0;
  const t1 = t0 + Math.pow(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), alpha) || 1e-4;
  const t2 = t1 + Math.pow(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), alpha) || t1 + 1e-4;
  const t3 = t2 + Math.pow(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]), alpha) || t2 + 1e-4;
  const u = t1 + (t2 - t1) * t;
  const lerp = (
    a: readonly [number, number],
    b: readonly [number, number],
    ta: number,
    tb: number,
  ) => {
    const w = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w] as const;
  };
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  const c = lerp(b1, b2, t1, t2);
  return [c[0], c[1]];
}
