import type { CarRenderState, WheelRenderState } from '../render/interpolate';
import { quat, slerpQ, vec3, type Vec3 } from '../shared/math';
import { WHEEL_COUNT } from '../shared/protocol';

/**
 * Race replays: `ReplayRecorder` keeps a compact copy of every car's render state at a fixed
 * rate (30 Hz by default) and `Replay` rebuilds a `CarRenderState` for any moment of it,
 * interpolated between samples, ready for `CarView.update`, the cameras and the engine sound.
 *
 * Storage is a list of fixed-size Float32Array chunks, one more whenever the last is full, so
 * recording never allocates per sample. A sample is its time (seconds after the first sample)
 * followed by one block of `CAR_FLOATS` per car. Poses, speed and rpm stay 32-bit floats; pedals,
 * wheel angles, suspension and slip are quantised to 12 bits and stored two to a float (an
 * integer below 2^24 is exact in a float); gear, flags, aid levels and wheel contacts are bit
 * fields. 21 floats per car: a 20-minute race of 12 cars at 30 Hz takes about 37 MB.
 */

/** Offsets inside one car's block of a sample. */
const F = {
  /** Position x, y, z. */
  POS: 0,
  /** Orientation quaternion x, y, z, w. */
  ROT: 3,
  SPEED: 7,
  RPM: 8,
  /** Throttle | brake. */
  PEDALS: 9,
  /** Steering (fraction of lock) | clutch engagement. */
  CONTROLS: 10,
  /** Gear, flags, gearbox mode and aid levels (bit fields, see packState). */
  STATE: 11,
  /** Contact bit and surface id of every wheel, 5 bits each. */
  CONTACTS: 12,
  /** Per wheel: suspension length | steer angle. */
  WHEEL_POSE: 13,
  /** Per wheel: spin angle | slip. */
  WHEEL_SPIN: 13 + WHEEL_COUNT,
} as const;
const CAR_FLOATS = F.WHEEL_SPIN + WHEEL_COUNT;

/** Samples per chunk (a power of two): about 34 s at 30 Hz, ~1 MB for 12 cars. */
const CHUNK_SHIFT = 10;
const CHUNK_SAMPLES = 1 << CHUNK_SHIFT;
const CHUNK_MASK = CHUNK_SAMPLES - 1;

/**
 * A call this much of an interval before the next slot still counts, so frames that jitter
 * around the slot don't halve the sample rate. The schedule stays anchored, so the average
 * rate is exactly `hz`.
 */
const EARLY = 0.25;

/** Quantisation ranges. Values outside are clamped. */
const LENGTH_MIN = -0.25;
const LENGTH_MAX = 1;
const WHEEL_STEER_MAX = 1;
const SLIP_MAX = 4;

/**
 * Wheel radius used to unwrap the spin angle between samples: at 30 Hz a wheel turns more than
 * half a revolution per sample above ~110 km/h, so the shortest way round is no longer the way
 * it turned. The car's speed tells how many whole turns to add; every car in the roster has
 * wheels within a few percent of this, far inside the half-turn tolerance.
 */
const NOMINAL_WHEEL_RADIUS = 0.34;

/**
 * Consecutive samples further apart than this speed (plus the slack) are a teleport (a car
 * reset): they are not blended, so the car doesn't streak across the circuit for a frame.
 */
const MAX_SPEED = 150;
const JUMP_SLACK = 2;

const TAU = Math.PI * 2;
const Q_MAX = 4095;
const PAIR = 4096;

/** `v` in [lo, hi] to an integer 0…4095 (NaN gives 0). */
function quantise(v: number, lo: number, hi: number): number {
  const q = ((v - lo) / (hi - lo)) * Q_MAX;
  return q > 0 ? (q < Q_MAX ? Math.round(q) : Q_MAX) : 0;
}

const dequantise = (q: number, lo: number, hi: number): number => lo + (q / Q_MAX) * (hi - lo);

/** An angle to 0…4095 around the full turn (4096 wraps to 0). */
function quantiseAngle(angle: number): number {
  const turns = angle / TAU;
  // NaN & 4095 is 0.
  return Math.round((turns - Math.floor(turns)) * PAIR) & Q_MAX;
}

const pair = (high: number, low: number): number => high * PAIR + low;
const highOf = (packed: number): number => Math.floor(packed / PAIR);
const lowOf = (packed: number): number => packed - Math.floor(packed / PAIR) * PAIR;

/** Rounds to an integer in [lo, hi] (NaN gives lo). */
function clampInt(v: number, lo: number, hi: number): number {
  const r = Math.round(v);
  return r > lo ? (r < hi ? r : hi) : lo;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

const finiteOr = (v: number, fallback: number): number => (Number.isFinite(v) ? v : fallback);

/** Gear (-1…30), flags (12 bits), manual gearbox and the TC / ABS levels in one integer. */
function packState(s: CarRenderState): number {
  const gear = clampInt(s.gear + 1, 0, 31);
  const flags = s.flags & 0xfff;
  const manual = s.manualGearbox ? 1 : 0;
  const tc = clampInt(s.tcLevel, 0, 3);
  const abs = clampInt(s.absLevel, 0, 3);
  return gear | (flags << 5) | (manual << 17) | (tc << 18) | (abs << 20);
}

/** Contact bit and surface id (0…15) of each wheel, 5 bits per wheel. */
function packContacts(wheels: readonly WheelRenderState[]): number {
  let bits = 0;
  for (let w = 0; w < WHEEL_COUNT; w++) {
    const wheel = wheels[w];
    if (!wheel) continue;
    const surface = clampInt(wheel.surface, 0, 15);
    bits |= ((wheel.contact ? 1 : 0) | (surface << 1)) << (w * 5);
  }
  return bits;
}

/**
 * Writes one car's block. `prev` / `prevOffset` is the same car's block in the previous sample
 * (or null): a broken pose (NaN from a physics blow-up) repeats the last good one.
 */
function writeCar(
  d: Float32Array,
  o: number,
  s: CarRenderState,
  prev: Float32Array | null,
  prevOffset: number,
): void {
  const p = s.pos;
  const r = s.rot;
  if (
    Number.isFinite(p.x + p.y + p.z) &&
    Number.isFinite(r.x + r.y + r.z + r.w) &&
    r.x * r.x + r.y * r.y + r.z * r.z + r.w * r.w > 1e-6
  ) {
    d[o + F.POS] = p.x;
    d[o + F.POS + 1] = p.y;
    d[o + F.POS + 2] = p.z;
    d[o + F.ROT] = r.x;
    d[o + F.ROT + 1] = r.y;
    d[o + F.ROT + 2] = r.z;
    d[o + F.ROT + 3] = r.w;
  } else if (prev) {
    for (let k = 0; k < 7; k++) d[o + k] = prev[prevOffset + k]!;
  } else {
    d.fill(0, o, o + 7);
    d[o + F.ROT + 3] = 1;
  }
  d[o + F.SPEED] = finiteOr(s.speed, 0);
  d[o + F.RPM] = finiteOr(s.rpm, 0);
  d[o + F.PEDALS] = pair(quantise(s.throttle, 0, 1), quantise(s.brake, 0, 1));
  d[o + F.CONTROLS] = pair(quantise(s.steer, -1, 1), quantise(s.clutch, 0, 1));
  d[o + F.STATE] = packState(s);
  d[o + F.CONTACTS] = packContacts(s.wheels);
  for (let w = 0; w < WHEEL_COUNT; w++) {
    const wheel = s.wheels[w];
    if (!wheel) {
      d[o + F.WHEEL_POSE + w] = pair(quantise(0, LENGTH_MIN, LENGTH_MAX), quantise(0, -1, 1));
      d[o + F.WHEEL_SPIN + w] = 0;
      continue;
    }
    d[o + F.WHEEL_POSE + w] = pair(
      quantise(wheel.length, LENGTH_MIN, LENGTH_MAX),
      quantise(wheel.steer, -WHEEL_STEER_MAX, WHEEL_STEER_MAX),
    );
    d[o + F.WHEEL_SPIN + w] = pair(quantiseAngle(wheel.spin), quantise(wheel.slip, 0, SLIP_MAX));
  }
}

/** A car that is missing from a `record` call repeats its previous block (or stands at the origin). */
function repeatCar(
  d: Float32Array,
  o: number,
  prev: Float32Array | null,
  prevOffset: number,
): void {
  if (prev) {
    for (let k = 0; k < CAR_FLOATS; k++) d[o + k] = prev[prevOffset + k]!;
    return;
  }
  d.fill(0, o, o + CAR_FLOATS);
  d[o + F.ROT + 3] = 1;
}

/** The recorded data a `Replay` plays back (from `ReplayRecorder.finish`). */
export interface ReplayData {
  carCount: number;
  /** Clock time of the first sample, on the clock passed to `record`. */
  startTime: number;
  sampleCount: number;
  /** Chunks of `2^10` samples; only the first `sampleCount` samples are read. */
  chunks: readonly Float32Array[];
}

/**
 * Records every car's render state for a replay. Call `record` once per frame with the
 * interpolated states; it keeps one sample every 1/hz seconds of the clock it is given (use the
 * simulation time so pauses don't count) and ignores the calls in between.
 */
export class ReplayRecorder {
  private readonly cars: number;
  private readonly interval: number;
  /** Floats per sample: the time plus one block per car. */
  private readonly stride: number;
  private chunks: Float32Array[] = [];
  private count = 0;
  private start = 0;
  private last = 0;
  private next = 0;

  constructor(carCount: number, hz = 30) {
    if (!Number.isInteger(carCount) || carCount < 1) {
      throw new RangeError(`ReplayRecorder needs at least one car, got ${carCount}`);
    }
    if (!(hz > 0 && hz < Infinity)) throw new RangeError(`Bad replay sample rate ${hz}`);
    this.cars = carCount;
    this.interval = 1 / hz;
    this.stride = 1 + carCount * CAR_FLOATS;
  }

  get carCount(): number {
    return this.cars;
  }

  /** Seconds between the first and the last sample. */
  get duration(): number {
    return this.count > 1 ? Math.fround(this.last - this.start) : 0;
  }

  get sampleCount(): number {
    return this.count;
  }

  /** Memory held by the recording, bytes. */
  get byteLength(): number {
    return this.chunks.length * CHUNK_SAMPLES * this.stride * Float32Array.BYTES_PER_ELEMENT;
  }

  /**
   * Stores a sample of `states` (the first `carCount`; missing cars repeat their last sample)
   * if `time` has reached the next 1/hz slot. The clock must only move forwards: calls at or
   * before the previous sample are ignored, so call `clear` when it restarts.
   */
  record(time: number, states: readonly CarRenderState[]): void {
    if (!Number.isFinite(time)) return;
    if (this.count === 0) {
      this.start = time;
      this.next = time;
    } else if (time <= this.last || time < this.next - this.interval * EARLY) {
      return;
    }
    this.next += this.interval;
    // After a gap (a stall, or a clock that jumped), start a new schedule rather than catching up.
    if (this.next <= time) this.next = time + this.interval;

    const index = this.count;
    let chunk = this.chunks[index >> CHUNK_SHIFT];
    if (!chunk) {
      chunk = new Float32Array(CHUNK_SAMPLES * this.stride);
      this.chunks.push(chunk);
    }
    const base = (index & CHUNK_MASK) * this.stride;
    const prev = index > 0 ? this.chunks[(index - 1) >> CHUNK_SHIFT]! : null;
    const prevBase = index > 0 ? ((index - 1) & CHUNK_MASK) * this.stride : 0;
    chunk[base] = time - this.start;
    for (let c = 0; c < this.cars; c++) {
      const o = base + 1 + c * CAR_FLOATS;
      const po = prevBase + 1 + c * CAR_FLOATS;
      const state = states[c];
      if (state) writeCar(chunk, o, state, prev, po);
      else repeatCar(chunk, o, prev, po);
    }
    this.last = time;
    this.count++;
  }

  /** Drops the recording. Replays already made from it keep their data. */
  clear(): void {
    this.chunks = [];
    this.count = 0;
    this.start = 0;
    this.last = 0;
    this.next = 0;
  }

  /**
   * A replay of everything recorded so far. It shares the recorder's storage (nothing is
   * copied); the recorder can carry on and later samples don't change the replay.
   */
  finish(): Replay {
    return new Replay({
      carCount: this.cars,
      startTime: this.start,
      sampleCount: this.count,
      chunks: this.chunks.slice(),
    });
  }
}

const rotA = quat();
const rotB = quat();
const velA = vec3();
const velB = vec3();

/**
 * A recorded race. `sample` rebuilds one car's `CarRenderState` at any time: positions and
 * continuous values are blended linearly, orientation by slerp, wheel spin along the way the
 * wheel actually turned, and discrete values (gear, flags, aids, wheel contact and surface) come
 * from the sample at or before `time`. Velocity isn't stored: it is the blended central
 * difference of the recorded positions. Not recorded, and set to 0: handbrake, g-forces, steering
 * authority and each wheel's load, slip ratio, slip angle and camber.
 */
export class Replay {
  readonly carCount: number;
  /** Clock time of the first sample (the clock passed to `ReplayRecorder.record`). */
  readonly startTime: number;
  /** Seconds from the first to the last sample. */
  readonly duration: number;
  readonly sampleCount: number;
  private readonly chunks: readonly Float32Array[];
  private readonly stride: number;
  /** Sample index found by the previous lookup: playback asks for nearby times in a row. */
  private cursor = 0;

  constructor(data: ReplayData) {
    this.carCount = data.carCount;
    this.startTime = data.startTime;
    this.sampleCount = Math.min(data.sampleCount, data.chunks.length * CHUNK_SAMPLES);
    this.chunks = data.chunks;
    this.stride = 1 + data.carCount * CAR_FLOATS;
    this.duration = this.sampleCount > 1 ? this.timeAt(this.sampleCount - 1) : 0;
  }

  /** Memory held by the samples, bytes. */
  get byteLength(): number {
    return this.chunks.length * CHUNK_SAMPLES * this.stride * Float32Array.BYTES_PER_ELEMENT;
  }

  /**
   * Writes car `car` as it was at `time` (on the recording clock: `startTime` …
   * `startTime + duration`, clamped to the first / last sample outside that) into `out`.
   * An empty replay leaves `out` as it is.
   */
  sample(time: number, car: number, out: CarRenderState): void {
    if (!Number.isInteger(car) || car < 0 || car >= this.carCount) {
      throw new RangeError(`No car ${car} in a replay of ${this.carCount}`);
    }
    const n = this.sampleCount;
    if (n === 0) return;
    const rel = time - this.startTime;
    let i = 0;
    let u = 0;
    if (n > 1 && rel > 0) {
      if (rel >= this.duration) i = n - 1;
      else {
        i = this.find(rel);
        const t0 = this.timeAt(i);
        const span = this.timeAt(i + 1) - t0;
        u = span > 0 ? Math.min(Math.max((rel - t0) / span, 0), 1) : 0;
      }
    }
    let j = u > 0 ? i + 1 : i;
    if (j > i && !this.continuous(i, car)) {
      // A teleport: hold the earlier sample until the later one.
      j = i;
      u = 0;
    }
    const span = this.timeAt(j) - this.timeAt(i);
    const a = this.chunks[i >> CHUNK_SHIFT]!;
    const ao = this.offset(i, car);
    const b = this.chunks[j >> CHUNK_SHIFT]!;
    const bo = this.offset(j, car);

    out.pos.x = lerp(a[ao + F.POS]!, b[bo + F.POS]!, u);
    out.pos.y = lerp(a[ao + F.POS + 1]!, b[bo + F.POS + 1]!, u);
    out.pos.z = lerp(a[ao + F.POS + 2]!, b[bo + F.POS + 2]!, u);
    rotA.x = a[ao + F.ROT]!;
    rotA.y = a[ao + F.ROT + 1]!;
    rotA.z = a[ao + F.ROT + 2]!;
    rotA.w = a[ao + F.ROT + 3]!;
    rotB.x = b[bo + F.ROT]!;
    rotB.y = b[bo + F.ROT + 1]!;
    rotB.z = b[bo + F.ROT + 2]!;
    rotB.w = b[bo + F.ROT + 3]!;
    slerpQ(out.rot, rotA, rotB, u);

    this.velocity(i, car, velA);
    if (j > i) {
      this.velocity(j, car, velB);
      out.vel.x = lerp(velA.x, velB.x, u);
      out.vel.y = lerp(velA.y, velB.y, u);
      out.vel.z = lerp(velA.z, velB.z, u);
    } else {
      out.vel.x = velA.x;
      out.vel.y = velA.y;
      out.vel.z = velA.z;
    }

    const speedA = a[ao + F.SPEED]!;
    const speedB = b[bo + F.SPEED]!;
    out.speed = lerp(speedA, speedB, u);
    out.rpm = lerp(a[ao + F.RPM]!, b[bo + F.RPM]!, u);
    const pedalsA = a[ao + F.PEDALS]!;
    const pedalsB = b[bo + F.PEDALS]!;
    out.throttle = dequantise(lerp(highOf(pedalsA), highOf(pedalsB), u), 0, 1);
    out.brake = dequantise(lerp(lowOf(pedalsA), lowOf(pedalsB), u), 0, 1);
    const controlsA = a[ao + F.CONTROLS]!;
    const controlsB = b[bo + F.CONTROLS]!;
    out.steer = dequantise(lerp(highOf(controlsA), highOf(controlsB), u), -1, 1);
    out.clutch = dequantise(lerp(lowOf(controlsA), lowOf(controlsB), u), 0, 1);

    const state = a[ao + F.STATE]! | 0;
    out.gear = (state & 31) - 1;
    out.flags = (state >> 5) & 0xfff;
    out.manualGearbox = ((state >> 17) & 1) === 1;
    out.tcLevel = (state >> 18) & 3;
    out.absLevel = (state >> 20) & 3;
    out.handbrake = 0;
    out.accelLong = 0;
    out.accelLat = 0;
    out.steerAuthority = 0;

    const contacts = a[ao + F.CONTACTS]! | 0;
    // How far the wheels rolled over this interval, radians, going by the car's speed.
    const rolled = ((speedA + speedB) * 0.5 * span) / NOMINAL_WHEEL_RADIUS;
    let frontSteer = 0;
    for (let w = 0; w < WHEEL_COUNT; w++) {
      const wheel = out.wheels[w];
      if (!wheel) continue;
      const poseA = a[ao + F.WHEEL_POSE + w]!;
      const poseB = b[bo + F.WHEEL_POSE + w]!;
      wheel.length = dequantise(lerp(highOf(poseA), highOf(poseB), u), LENGTH_MIN, LENGTH_MAX);
      wheel.steer = dequantise(
        lerp(lowOf(poseA), lowOf(poseB), u),
        -WHEEL_STEER_MAX,
        WHEEL_STEER_MAX,
      );
      if (w < 2) frontSteer += wheel.steer;
      const spinA = a[ao + F.WHEEL_SPIN + w]!;
      const spinB = b[bo + F.WHEEL_SPIN + w]!;
      const from = (highOf(spinA) / PAIR) * TAU;
      let turn = (highOf(spinB) / PAIR) * TAU - from;
      // The same end angle, plus the whole turns that best match how far the car rolled.
      turn += TAU * Math.round((rolled - turn) / TAU);
      const spin = from + turn * u;
      wheel.spin = spin - TAU * Math.floor(spin / TAU);
      wheel.slip = dequantise(lerp(lowOf(spinA), lowOf(spinB), u), 0, SLIP_MAX);
      const bits = (contacts >> (w * 5)) & 31;
      wheel.contact = (bits & 1) === 1;
      wheel.surface = bits >> 1;
      wheel.load = 0;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      wheel.camber = 0;
    }
    out.steerAngle = frontSteer / 2;
  }

  /** Seconds after the first sample at which sample `i` was taken. */
  private timeAt(i: number): number {
    return this.chunks[i >> CHUNK_SHIFT]![(i & CHUNK_MASK) * this.stride]!;
  }

  /** Offset of car `car`'s block of sample `i` inside its chunk. */
  private offset(i: number, car: number): number {
    return (i & CHUNK_MASK) * this.stride + 1 + car * CAR_FLOATS;
  }

  /** The sample at or before `rel` (0 < rel < duration). */
  private find(rel: number): number {
    const n = this.sampleCount;
    let i = Math.min(this.cursor, n - 2);
    if (this.timeAt(i) <= rel && rel < this.timeAt(i + 1)) return i;
    if (i + 2 < n && this.timeAt(i + 1) <= rel && rel < this.timeAt(i + 2)) {
      this.cursor = i + 1;
      return i + 1;
    }
    let lo = 0;
    let hi = n - 1;
    // Invariant: time(lo) <= rel < time(hi).
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.timeAt(mid) <= rel) lo = mid;
      else hi = mid;
    }
    i = lo;
    this.cursor = i;
    return i;
  }

  /** Did car `car` move from sample `i` to `i + 1` without being teleported? */
  private continuous(i: number, car: number): boolean {
    const a = this.chunks[i >> CHUNK_SHIFT]!;
    const ao = this.offset(i, car);
    const b = this.chunks[(i + 1) >> CHUNK_SHIFT]!;
    const bo = this.offset(i + 1, car);
    const dx = b[bo + F.POS]! - a[ao + F.POS]!;
    const dy = b[bo + F.POS + 1]! - a[ao + F.POS + 1]!;
    const dz = b[bo + F.POS + 2]! - a[ao + F.POS + 2]!;
    const reach = MAX_SPEED * (this.timeAt(i + 1) - this.timeAt(i)) + JUMP_SLACK;
    return dx * dx + dy * dy + dz * dz <= reach * reach;
  }

  /** Velocity at sample `i`: central difference of the neighbouring samples it is joined to. */
  private velocity(i: number, car: number, out: Vec3): void {
    const n = this.sampleCount;
    const lo = i > 0 && this.continuous(i - 1, car) ? i - 1 : i;
    const hi = i < n - 1 && this.continuous(i, car) ? i + 1 : i;
    const dt = this.timeAt(hi) - this.timeAt(lo);
    if (hi === lo || !(dt > 0)) {
      out.x = 0;
      out.y = 0;
      out.z = 0;
      return;
    }
    const a = this.chunks[lo >> CHUNK_SHIFT]!;
    const ao = this.offset(lo, car);
    const b = this.chunks[hi >> CHUNK_SHIFT]!;
    const bo = this.offset(hi, car);
    out.x = (b[bo + F.POS]! - a[ao + F.POS]!) / dt;
    out.y = (b[bo + F.POS + 1]! - a[ao + F.POS + 1]!) / dt;
    out.z = (b[bo + F.POS + 2]! - a[ao + F.POS + 2]!) / dt;
  }
}
