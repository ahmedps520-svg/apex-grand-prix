import type { Track } from '../track/Track';

const G = 9.81;
/** Air drag as deceleration per (m/s)² for the GT car (½ ρ CdA / m). */
const DRAG = 0.00047;

/** Car performance the speed plan assumes. The defaults suit the GT test car. */
export interface RacingLineOptions {
  /** Cornering grip without downforce, g. */
  gripG?: number;
  /** Closest the car's centre comes to the edge of the road, metres. */
  margin?: number;
  /** Downforce: extra grip per (m/s)², as a fraction of the car's weight. */
  downforce?: number;
  /** Braking deceleration at low speed, m/s² (downforce and drag add to it at speed). */
  brake?: number;
  /** Acceleration at low speed, m/s² (falls to about a fifth of it near 80 m/s). */
  accel?: number;
  /** Top speed, m/s. */
  topSpeed?: number;
}

export type LineParams = Required<RacingLineOptions>;

export const DEFAULT_LINE_OPTIONS: Readonly<LineParams> = {
  gripG: 1.38,
  margin: 1.4,
  downforce: 0.00016,
  brake: 12,
  accel: 7,
  topSpeed: 85,
};

/**
 * The fastest way round a track: per centre-line sample, where on the road to be and how fast
 * to go. Worked out once when the track loads.
 */
export interface RacingLine {
  /** Offset from the centre line, metres (> 0 = right of the driving direction). */
  lateral: Float32Array;
  /** Target speed with braking and acceleration taken into account, m/s. */
  speed: Float32Array;
  /** World position of the line, metres. */
  x: Float32Array;
  z: Float32Array;
  /** Signed curvature of the line itself, 1/m (> 0 turns left). */
  curvature: Float32Array;
  /** Fastest speed the grip allows through each point, ignoring braking and acceleration. */
  cornerSpeed: Float32Array;
  /** Distance to the next point along the line, metres. */
  step: Float32Array;
  /** Lap time the speed plan gives, seconds. */
  lapTime: number;
  /** Performance the plan was worked out for. */
  params: Readonly<LineParams>;
}

/** Cornering acceleration available at speed `v`, m/s². */
export function lateralLimit(v: number, p: Readonly<LineParams>): number {
  return p.gripG * G * (1 + p.downforce * v * v);
}

/** Straight-line braking deceleration available at speed `v`, m/s². */
export function brakeLimit(v: number, p: Readonly<LineParams>): number {
  return p.brake * (1 + p.downforce * v * v) + DRAG * v * v;
}

/** Straight-line acceleration available at speed `v`, m/s². */
export function accelLimit(v: number, p: Readonly<LineParams>): number {
  return Math.max(p.accel * (1 - 0.79 * Math.min(v / 80, 1)), 0.3);
}

/** Fastest steady speed round a curve of curvature `k` (1/m), capped at the top speed. */
export function cornerLimit(k: number, p: Readonly<LineParams>): number {
  // v² = μg(1 + c v²) / |k|  ⇒  v² = μg / (|k| - μgc); unlimited once downforce outgrows the curve.
  const a = Math.abs(k) - p.gripG * G * p.downforce;
  if (a <= 0) return p.topSpeed;
  return Math.min(Math.sqrt((p.gripG * G) / a), p.topSpeed);
}

/**
 * Share of the tyres' grip left for braking or accelerating while `v²|k|` of it is used for
 * cornering (friction ellipse); never quite zero so the plan stays connected.
 */
export function gripLeft(v: number, k: number, p: Readonly<LineParams>): number {
  const used = (v * v * Math.abs(k)) / lateralLimit(v, p);
  return Math.sqrt(Math.max(1 - used * used, 0.04));
}

/** Coarse-to-fine smoothing: [neighbour stride in samples, sweeps]. */
const SCHEDULE: ReadonlyArray<readonly [number, number]> = [
  [48, 60],
  [24, 80],
  [12, 80],
  [6, 80],
  [3, 80],
  [2, 60],
  [1, 120],
];
/** Shorter schedule for the reweighted rounds, which start from a nearly converged line. */
const REFINE: ReadonlyArray<readonly [number, number]> = [
  [12, 30],
  [6, 30],
  [3, 30],
  [2, 30],
  [1, 40],
];
/** Reweighted rounds: weight = (|k| / max|k| + floor)^power, blended in by `blend` per round. */
const ROUNDS = 12;
const WEIGHT_POWER = 6;
const WEIGHT_FLOOR = 0.2;
const ROUND_BLEND = 0.3;

/**
 * Racing line and speed plan for a track.
 *
 * The line is relaxed from the centre line: each point slides sideways (within the road) to
 * where it makes the line straightest with its neighbours, i.e. it minimises Σκ², first over
 * long strides, then shorter ones. That naturally gives outside-inside-outside through corners,
 * but leaves the apex almost as tight as the corner itself; a few reweighted rounds then
 * penalise the tightest parts more, which widens each corner towards a constant radius. Every
 * round is timed with the speed plan and the fastest line is kept.
 *
 * Speeds come from the line's own curvature (grip plus downforce), then a backward pass for
 * braking and a forward pass for acceleration, both sharing the grip with cornering.
 */
export function computeRacingLine(track: Track, opts: RacingLineOptions = {}): RacingLine {
  const params: LineParams = { ...DEFAULT_LINE_OPTIONS, ...opts };
  const samples = track.samples;
  const n = samples.length;
  const limit = Math.max(track.halfWidth - params.margin, 0);
  const geo: Geometry = {
    cx: new Float64Array(n),
    cz: new Float64Array(n),
    nx: new Float64Array(n),
    nz: new Float64Array(n),
  };
  for (let i = 0; i < n; i++) {
    const p = samples[i]!;
    geo.cx[i] = p.x;
    geo.cz[i] = p.z;
    // Unit normal pointing right of the driving direction.
    geo.nx[i] = -p.tz;
    geo.nz[i] = p.tx;
  }
  const line: RacingLine = {
    lateral: new Float32Array(n),
    speed: new Float32Array(n),
    x: new Float32Array(n),
    z: new Float32Array(n),
    curvature: new Float32Array(n),
    cornerSpeed: new Float32Array(n),
    step: new Float32Array(n),
    lapTime: 0,
    params,
  };

  const lat = new Float64Array(n);
  relax(geo, lat, limit, null, SCHEDULE);
  let bestTime = plan(geo, lat, params, line);
  const best = Float64Array.from(lat);
  const weights = new Float64Array(n);
  const previous = new Float64Array(n);
  for (let round = 0; round < ROUNDS; round++) {
    // Weights from the current line's curvature (the largest within ±2 samples).
    let max = 1e-9;
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (let d = -2; d <= 2; d++) k = Math.max(k, Math.abs(line.curvature[(i + d + n) % n]!));
      weights[i] = k;
      max = Math.max(max, k);
    }
    for (let i = 0; i < n; i++) weights[i] = (weights[i]! / max + WEIGHT_FLOOR) ** WEIGHT_POWER;
    previous.set(lat);
    relax(geo, lat, limit, weights, REFINE);
    for (let i = 0; i < n; i++) lat[i] = previous[i]! + (lat[i]! - previous[i]!) * ROUND_BLEND;
    const time = plan(geo, lat, params, line);
    if (time < bestTime) {
      bestTime = time;
      best.set(lat);
    }
  }
  plan(geo, best, params, line);
  return line;
}

interface Geometry {
  cx: Float64Array;
  cz: Float64Array;
  nx: Float64Array;
  nz: Float64Array;
}

/**
 * Fills `line` for the lateral offsets `lat`: positions, curvature, corner speeds and the speed
 * plan. Returns the lap time.
 */
function plan(geo: Geometry, lat: Float64Array, params: LineParams, line: RacingLine): number {
  const n = lat.length;
  const { x, z, curvature, step, speed } = line;
  for (let i = 0; i < n; i++) {
    line.lateral[i] = lat[i]!;
    x[i] = geo.cx[i]! + geo.nx[i]! * lat[i]!;
    z[i] = geo.cz[i]! + geo.nz[i]! * lat[i]!;
  }
  // Curvature of the line from its own points (circle through i-2, i, i+2), lightly smoothed.
  const raw = speed; // scratch until the speeds are worked out
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const c = (i + 2) % n;
    const abx = x[i]! - x[a]!;
    const abz = z[i]! - z[a]!;
    const bcx = x[c]! - x[i]!;
    const bcz = z[c]! - z[i]!;
    const cross = abx * bcz - abz * bcx;
    const lengths =
      Math.hypot(abx, abz) * Math.hypot(bcx, bcz) * Math.hypot(x[c]! - x[a]!, z[c]! - z[a]!);
    // A right turn is a positive cross product in x-right, z-towards-viewer coordinates.
    raw[i] = lengths > 1e-9 ? (-2 * cross) / lengths : 0;
  }
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let weight = 0;
    for (let d = -3; d <= 3; d++) {
      const w = 4 - Math.abs(d);
      sum += raw[(i + d + n) % n]! * w;
      weight += w;
    }
    curvature[i] = sum / weight;
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    step[i] = Math.hypot(x[j]! - x[i]!, z[j]! - z[i]!);
    speed[i] = cornerLimit(curvature[i]!, params);
    line.cornerSpeed[i] = speed[i]!;
  }
  brakingPass(speed, curvature, step, (v) => brakeLimit(v, params), params);
  // Acceleration: forwards round the lap twice so the start of the lap sees the end of it.
  for (let k = 0; k < 2 * n; k++) {
    const i = k % n;
    const j = (i + 1) % n;
    const v = speed[i]!;
    const a = accelLimit(v, params) * gripLeft(v, curvature[i]!, params);
    const reach = Math.sqrt(v * v + 2 * a * step[i]!);
    if (reach < speed[j]!) speed[j] = reach;
  }
  let time = 0;
  for (let i = 0; i < n; i++) {
    time += step[i]! / Math.max((speed[i]! + speed[(i + 1) % n]!) / 2, 0.1);
  }
  line.lapTime = time;
  return time;
}

/**
 * Lowers speeds so every slower point ahead can be reached by braking at `decel(v)` (less while
 * cornering): backwards round the lap twice so the end of the lap sees the start of it.
 */
export function brakingPass(
  speed: Float32Array | Float64Array,
  curvature: Float32Array,
  step: Float32Array,
  decel: (v: number) => number,
  params: Readonly<LineParams>,
): void {
  const n = speed.length;
  for (let k = 2 * n - 1; k >= 0; k--) {
    const i = k % n;
    const j = (i + 1) % n;
    const v = speed[j]!;
    const a = decel(v) * gripLeft(v, curvature[j]!, params);
    const reach = Math.sqrt(v * v + 2 * a * step[i]!);
    if (reach < speed[i]!) speed[i] = reach;
  }
}

/**
 * Projected Gauss-Seidel on the (weighted) discrete curvature energy
 * Σ w(j)·|P(j-k) - 2P(j) + P(j+k)|², each point moving only along its normal within ±limit.
 * Each update is the exact minimiser for that point, so the energy never increases.
 */
function relax(
  geo: Geometry,
  lat: Float64Array,
  limit: number,
  weights: Float64Array | null,
  schedule: ReadonlyArray<readonly [number, number]>,
): void {
  const { cx, cz, nx, nz } = geo;
  const n = lat.length;
  for (const [stride, sweeps] of schedule) {
    if (stride * 8 > n) continue;
    for (let it = 0; it < sweeps; it++) {
      // Alternate the sweep direction so the line doesn't drift one way.
      const backwards = (it & 1) === 1;
      for (let k = 0; k < n; k++) {
        const i = backwards ? n - 1 - k : k;
        const a = (i - 2 * stride + 2 * n) % n;
        const b = (i - stride + n) % n;
        const c = (i + stride) % n;
        const d = (i + 2 * stride) % n;
        const ix = cx[i]!;
        const iz = cz[i]!;
        const bx = cx[b]! + nx[b]! * lat[b]!;
        const bz = cz[b]! + nz[b]! * lat[b]!;
        const qx = cx[c]! + nx[c]! * lat[c]!;
        const qz = cz[c]! + nz[c]! * lat[c]!;
        // Second differences centred on b, i and c with this point on the centre line; the
        // energy is then quadratic in its offset along the normal.
        const ex = cx[a]! + nx[a]! * lat[a]! - 2 * bx + ix;
        const ez = cz[a]! + nz[a]! * lat[a]! - 2 * bz + iz;
        const fx = bx - 2 * ix + qx;
        const fz = bz - 2 * iz + qz;
        const gx = ix - 2 * qx + cx[d]! + nx[d]! * lat[d]!;
        const gz = iz - 2 * qz + cz[d]! + nz[d]! * lat[d]!;
        const wb = weights ? weights[b]! : 1;
        const wi = weights ? weights[i]! : 1;
        const wc = weights ? weights[c]! : 1;
        const ni = nx[i]!;
        const nj = nz[i]!;
        const l =
          -(wb * (ex * ni + ez * nj) - 2 * wi * (fx * ni + fz * nj) + wc * (gx * ni + gz * nj)) /
          (wb + 4 * wi + wc);
        lat[i] = l < -limit ? -limit : l > limit ? limit : l;
      }
    }
  }
}
