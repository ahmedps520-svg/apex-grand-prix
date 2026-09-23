import { clamp, mulberry32 } from '../../shared/math';
import { neutralInput, type DriverInput } from '../../shared/protocol';
import { KERB_WIDTH, type Track } from '../track/Track';
import type { Car } from '../vehicle/car';
import {
  accelLimit,
  brakeLimit,
  brakingPass,
  gripLeft,
  lateralLimit,
  type RacingLine,
} from './racingLine';
import { projectNear, trackPos, wrapDelta } from './trackPos';

/** How a driver races. */
export interface AiOptions {
  /** Pace: fraction of the racing line's corner speeds, 0.85 … 1.0. */
  skill: number;
  /** Racecraft, 0 … 1: how closely it follows and how readily it goes for a gap (default 0.5). */
  aggression?: number;
  /** Seed for this driver's small imperfections. */
  seed?: number;
}

const G = 9.81;
/** Pure pursuit: look this far ahead along the line, metres (+ per m/s of speed). */
const LOOKAHEAD = 6;
const LOOKAHEAD_PER_SPEED = 0.45;
/** Speed targets are read this far ahead in time, so braking starts before it's late. */
const ANTICIPATION = 0.15;
/** Extra steering per g of cornering (the tyres' slip angles). */
const UNDERSTEER = 0.012;
/** Steering per rad/s of yaw rate beyond what the path needs: damps weaves, catches slides. */
const YAW_DAMPING = 0.05;
/** Steering per metre off the chosen line. */
const LATERAL_GAIN = 0.004;
/** Deceleration at full brake pedal, for the braking feedforward, m/s². */
const FULL_BRAKE = 20;
/** Closest the car's centre may come to the road edge when moving off the line, metres. */
const EDGE = 1.25;
/** Side-by-side spacing between car centres the AI keeps, metres. */
const SIDE_GAP = 3;
/** Traffic: cars further than this (straight line) are ignored, metres. */
const TRAFFIC_RANGE = 45;
/** How fast the chosen line may move sideways, m/s. */
const OFFSET_RATE = 3;
/** Recovery: stuck / facing the wrong way / off the track for this long starts it. */
const STUCK_TIME = 1.5;
const SPUN_TIME = 0.6;
const OFF_TIME = 2;
/** Recovery that hasn't worked after this long asks for a reset. */
const RESET_AFTER = 6;
const RECOVERY_SPEED = 9;

const enum Mode {
  Race,
  Forward,
  Reverse,
}

/**
 * An AI driver: follows the racing line with pure-pursuit steering, drives to a speed plan
 * scaled by its skill, races other cars (follows, pulls out to pass, keeps clear alongside)
 * and recovers from spins and trips off the track. It drives through the same controls as a
 * player: wheel-mode steering and pedals, automatic gearbox.
 */
export class AiDriver {
  private readonly out: DriverInput = neutralInput();
  private readonly n: number;
  private readonly spacing: number;
  /** This driver's line (the racing line with a little personal variation). */
  private readonly lane: Float32Array;
  /** This driver's speed plan: corner speeds × skill, braking at its own pace. */
  private readonly plan: Float32Array;
  private readonly aggression: number;
  private readonly edge: number;
  private readonly pos = trackPos();
  private readonly other = trackPos();
  private lastX = 0;
  private lastZ = 0;
  /** Sideways shift from the line for traffic, metres (> 0 = right). */
  private offset = 0;
  private offsetTarget = 0;
  private offsetHold = 0;
  private mode = Mode.Race;
  private stuckTime = 0;
  private spunTime = 0;
  private offTime = 0;
  private recoveryTime = 0;
  private phaseTime = 0;
  private resetWanted = false;

  constructor(
    private readonly track: Track,
    private readonly line: RacingLine,
    options: AiOptions,
  ) {
    const n = track.samples.length;
    this.n = n;
    this.spacing = track.length / n;
    this.aggression = Math.min(Math.max(options.aggression ?? 0.5, 0), 1);
    this.edge = Math.max(track.halfWidth - EDGE, 0);
    const rand = mulberry32(options.seed ?? 1);
    // Smooth, lap-periodic noise: a few low harmonics with random phases.
    const wave = (): ((i: number) => number) => {
      const h1 = 2 + Math.floor(rand() * 4);
      const h2 = 5 + Math.floor(rand() * 5);
      const p1 = rand() * Math.PI * 2;
      const p2 = rand() * Math.PI * 2;
      return (i) =>
        (Math.sin((2 * Math.PI * h1 * i) / n + p1) +
          0.5 * Math.sin((2 * Math.PI * h2 * i) / n + p2)) /
        1.5;
    };
    const lineNoise = wave();
    const paceNoise = wave();
    const skill = Math.min(Math.max(options.skill, 0.5), 1.05);
    this.lane = new Float32Array(n);
    this.plan = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.lane[i] = clamp(line.lateral[i]! + 0.3 * lineNoise(i), -this.edge, this.edge);
      // Mostly a touch slower than the skill level, differently in each corner.
      const pace = skill * (0.985 + 0.015 * paceNoise(i));
      this.plan[i] = Math.min(line.cornerSpeed[i]! * pace, line.params.topSpeed);
    }
    // Brakes a little earlier and softer the lower the skill.
    const brakeShare = 0.82 + 0.15 * clamp((skill - 0.85) / 0.15, 0, 1);
    const params = line.params;
    const plan = this.plan;
    brakingPass(plan, line.curvature, line.step, (v) => brakeLimit(v, params) * brakeShare, params);
    // Out of corners, only as much acceleration as the grip left over from cornering allows.
    for (let k = 0; k < 2 * n; k++) {
      const i = k % n;
      const j = (i + 1) % n;
      const v = plan[i]!;
      const a = accelLimit(v, params) * gripLeft(v, line.curvature[i]!, params);
      const reach = Math.sqrt(v * v + 2 * a * line.step[i]!);
      if (reach < plan[j]!) plan[j] = reach;
    }
  }

  /** Car's index along the track samples (kept up to date by drive()). */
  get progressIndex(): number {
    return this.pos.index;
  }

  /**
   * Set when recovery has failed for a while: put the car back on the track (facing the right
   * way) and clear the flag.
   */
  get needsReset(): boolean {
    return this.resetWanted;
  }

  set needsReset(value: boolean) {
    this.resetWanted = value;
    if (!value) this.clearRecovery();
  }

  /** Forgets everything about the car's past (after a teleport or restart). */
  reset(): void {
    this.pos.index = -1;
    this.offset = 0;
    this.offsetTarget = 0;
    this.offsetHold = 0;
    this.resetWanted = false;
    this.clearRecovery();
  }

  /** Controls for this step. `others` = all other cars (for avoiding contact / overtaking). */
  drive(car: Car, others: readonly Car[], dt: number): DriverInput {
    const out = this.out;
    const track = this.track;
    const x = car.pos.x;
    const z = car.pos.z;
    if (Math.hypot(x - this.lastX, z - this.lastZ) > 20) this.reset();
    this.lastX = x;
    this.lastZ = z;
    const pos = projectNear(track, x, z, this.pos.index, this.pos);
    const sample = track.samples[pos.index]!;

    const q = car.rot;
    // Nose and right-hand directions in the ground plane.
    let fx = -2 * (q.x * q.z + q.w * q.y);
    let fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    const rx = -fz;
    const rz = fx;
    const v = car.forwardSpeed();
    // Track direction relative to the nose: > 0 = the track heads off to the right.
    const trackAngle = Math.atan2(sample.tx * rx + sample.tz * rz, sample.tx * fx + sample.tz * fz);

    out.steerMode = 'wheel';
    out.handbrake = 0;
    out.clutch = 0;
    out.shiftUp = 0;
    out.shiftDown = 0;

    // Held on the grid: nothing to learn from standing still.
    const held = car.handbrake > 0.5 || car.holdForStart;
    if (held) {
      this.stuckTime = 0;
      this.spunTime = 0;
      this.offTime = 0;
    } else this.watch(car, trackAngle, dt);

    if (this.mode !== Mode.Race) {
      this.recover(car, v, trackAngle, fx, fz, rx, rz);
      return out;
    }

    this.traffic(car, others, v, dt);
    this.steer(car, v, fx, fz, rx, rz, this.offset, 0);
    this.pedals(car, v, held);
    return out;
  }

  /** Watches for trouble while racing: stopped, spun round, or off the track too long. */
  private watch(car: Car, trackAngle: number, dt: number): void {
    const speed = Math.hypot(car.vel.x, car.vel.z);
    this.stuckTime = speed < 1.5 ? this.stuckTime + dt : 0;
    this.spunTime = Math.abs(trackAngle) > (100 * Math.PI) / 180 ? this.spunTime + dt : 0;
    const off = Math.abs(this.pos.lateral) > this.track.halfWidth + KERB_WIDTH + 0.5;
    this.offTime = off ? this.offTime + dt : 0;
    if (this.mode !== Mode.Race) {
      this.recoveryTime += dt;
      this.phaseTime += dt;
      if (this.recoveryTime > RESET_AFTER) this.resetWanted = true;
      return;
    }
    if (this.stuckTime > STUCK_TIME || this.spunTime > SPUN_TIME || this.offTime > OFF_TIME) {
      this.mode = Math.abs(trackAngle) > Math.PI / 2 ? Mode.Reverse : Mode.Forward;
      this.recoveryTime = 0;
      this.phaseTime = 0;
    }
  }

  private clearRecovery(): void {
    this.mode = Mode.Race;
    this.stuckTime = 0;
    this.spunTime = 0;
    this.offTime = 0;
    this.recoveryTime = 0;
    this.phaseTime = 0;
  }

  /**
   * Getting going again: back up while turning to face down the track if pointing the wrong way
   * or blocked, then drive slowly back onto the line.
   */
  private recover(
    car: Car,
    v: number,
    trackAngle: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
  ): void {
    const out = this.out;
    const lock = car.spec.front.maxSteer;
    const reversing = car.gear < 0;
    if (this.mode === Mode.Reverse) {
      out.throttle = 0;
      // Automatic gearbox: holding the brake at a standstill selects reverse, then the brake
      // pedal drives backwards.
      out.brake = reversing ? 0.55 : 1;
      // Backing up turns the nose the opposite way to the wheels.
      out.wheelAngle = -Math.sign(trackAngle) * lock * car.spec.steeringRatio;
      if (reversing && (Math.abs(trackAngle) < Math.PI / 3 || this.phaseTime > 3)) {
        this.mode = Mode.Forward;
        this.phaseTime = 0;
      }
      return;
    }
    // Forward: throttle also brakes a reversing car to a stop and selects first gear.
    this.steer(car, v, fx, fz, rx, rz, 0, 12);
    const err = RECOVERY_SPEED - v;
    out.throttle = reversing ? 0.8 : clamp(0.3 + 0.3 * err, 0, 0.8);
    out.brake = !reversing && err < -2 ? 0.3 : 0;
    const onTrack = Math.abs(this.pos.lateral) < this.track.halfWidth;
    if (onTrack && Math.abs(trackAngle) < 0.6 && v > 6) {
      this.clearRecovery();
      return;
    }
    // Not getting anywhere (nose against a barrier?): back up and try again.
    if (this.phaseTime > 2 && Math.abs(v) < 0.5) {
      this.mode = Mode.Reverse;
      this.phaseTime = 0;
    }
  }

  /**
   * Pure pursuit towards a point on this driver's line (shifted by `offset`) ahead of the rear
   * axle, plus corrections for cornering slip, yaw rate and distance off the line. `minLook`
   * sets a minimum lookahead (recovery). Writes the steering and returns the road-wheel angle.
   */
  private steer(
    car: Car,
    v: number,
    fx: number,
    fz: number,
    rx: number,
    rz: number,
    offset: number,
    minLook: number,
  ): number {
    const spec = car.spec;
    const wheelbase = spec.front.offset - spec.rear.offset;
    const ax = car.pos.x + fx * spec.rear.offset;
    const az = car.pos.z + fz * spec.rear.offset;
    const look = Math.max(LOOKAHEAD + LOOKAHEAD_PER_SPEED * Math.max(v, 0), minLook);
    const target = this.pos.s + spec.rear.offset + look;
    const tx = this.pointX(target, offset);
    const tz = this.pointZ(target, offset);
    const dx = tx - ax;
    const dz = tz - az;
    const dist = Math.hypot(dx, dz) || 1;
    const alpha = Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
    // Path curvature to the target (> 0 = right) and the steering it takes.
    const kappa = (2 * Math.sin(alpha)) / dist;
    this.pathCurvature = kappa;
    let road = Math.atan(wheelbase * kappa);
    const speed = Math.max(v, 0);
    road += (UNDERSTEER * speed * speed * kappa) / G;
    // Yaw rate: > 0 turns left; the path wants -v·κ.
    road += YAW_DAMPING * (car.angVel.y + speed * kappa);
    const error = this.pos.lateral - (this.laneAt(this.pos.s) + offset);
    road -= LATERAL_GAIN * clamp(error, -3, 3);
    const lock = spec.front.maxSteer;
    road = clamp(road, -lock, lock);
    this.out.wheelAngle = road * spec.steeringRatio;
    return road;
  }

  /** Throttle and brake towards the speed plan, with anticipation and a braking feedforward. */
  private pedals(car: Car, v: number, held: boolean): void {
    const out = this.out;
    const s = this.pos.s + Math.max(v, 0) * ANTICIPATION;
    let target = this.planAt(s);
    // Off the line on the inside of a corner the radius is tighter: slow down to suit.
    const k = this.line.curvature[this.indexAt(s + Math.max(v, 0) * 0.5)]!;
    const tighter = 1 + k * this.offset;
    if (tighter < 1) target *= Math.sqrt(Math.max(tighter, 0.5));
    target = Math.min(target, this.speedCap);
    const ahead = this.planAt(s + 6);
    const need = ahead < target ? ((target - ahead) / 6) * target : 0;
    const err = v - target;
    if (!held && err > -0.5 && (need > 1 || err > 0.25)) {
      out.throttle = 0;
      out.brake = clamp(need / FULL_BRAKE + 0.4 * err, 0, 1);
    } else {
      out.brake = 0;
      let throttle = clamp(0.35 - 0.8 * err, 0, 1);
      // Cornering near the limit: only the grip left over goes into accelerating.
      const speed = Math.max(v, 0);
      const used =
        (speed * speed * Math.abs(this.pathCurvature)) / lateralLimit(speed, this.line.params);
      if (used > 0.6) throttle = Math.min(throttle, Math.sqrt(Math.max(1 - used * used, 0)) + 0.15);
      // Rear stepping out (the car slides sideways): ease off.
      const slide = car.vel.x * car.vel.x + car.vel.z * car.vel.z > 25 ? this.slipAngle(car) : 0;
      if (slide > 0.06) throttle *= clamp(1 - (slide - 0.06) * 8, 0.2, 1);
      out.throttle = clamp(throttle, 0, 1);
    }
  }

  private speedCap = Infinity;
  /** Curvature of the path the steering is following (> 0 = right), 1/m. */
  private pathCurvature = 0;

  /**
   * Looks at nearby cars: follows a slower car ahead or pulls out to pass it on the side with
   * more room, and keeps a car's width from anyone alongside.
   */
  private traffic(car: Car, others: readonly Car[], v: number, dt: number): void {
    const track = this.track;
    const pos = this.pos;
    const sample = track.samples[pos.index]!;
    const myVel = car.vel.x * sample.tx + car.vel.z * sample.tz;
    const aggression = this.aggression;
    let cap = Infinity;
    let want = Number.NaN;
    let nearest = Infinity;
    for (const o of others) {
      if (o === car) continue;
      const dx = o.pos.x - car.pos.x;
      const dz = o.pos.z - car.pos.z;
      if (dx * dx + dz * dz > TRAFFIC_RANGE * TRAFFIC_RANGE) continue;
      const along = dx * sample.tx + dz * sample.tz;
      const hint = (pos.index + Math.round(along / this.spacing) + this.n) % this.n;
      const op = projectNear(track, o.pos.x, o.pos.z, hint, this.other);
      const gap = wrapDelta(op.s - pos.s, track.length);
      const lat = op.lateral;
      const oVel = o.vel.x * sample.tx + o.vel.z * sample.tz;
      const closing = myVel - oVel;
      const length = car.spec.body.front + car.spec.body.rear;
      if (Math.abs(gap) < length) {
        // Alongside: keep a car's width apart.
        const sep = pos.lateral - lat;
        if (Math.abs(sep) < SIDE_GAP) {
          const side = sep >= 0 ? 1 : -1;
          const wantLat = clamp(lat + side * SIDE_GAP, -this.edge, this.edge);
          if (Math.abs(gap) < nearest) {
            nearest = Math.abs(gap);
            want = wantLat - this.laneAt(pos.s);
          }
          // Squeezed against the edge: let them have it.
          if (Math.abs(wantLat - (lat + side * SIDE_GAP)) > 0.5 && gap > 0)
            cap = Math.min(cap, oVel - 1);
        }
        continue;
      }
      if (gap <= 0 || gap > 25 + Math.max(closing, 0) * 1.5) continue;
      const planned = this.laneAt(op.s) + this.offset;
      if (Math.abs(lat - planned) > 4) continue;
      const clear = Math.abs(lat - planned) > SIDE_GAP;
      const room = gap - length;
      // Follow at a gap that grows with speed (closer the more aggressive).
      const desired = 4 + (0.22 - 0.1 * aggression) * Math.max(v, 0);
      if (!clear && closing > 1.2 - aggression) {
        // Pass on the side with more room, if there is room.
        const left = lat - SIDE_GAP - -this.edge;
        const right = this.edge - (lat + SIDE_GAP);
        if (Math.max(left, right) > 0 && room > 3) {
          const wantLat = right > left ? lat + SIDE_GAP : lat - SIDE_GAP;
          if (gap < nearest) {
            nearest = gap;
            want = wantLat - this.laneAt(op.s);
          }
        }
      }
      if (!clear) cap = Math.min(cap, oVel + (room - desired) * 0.8);
      if (room < 2 && Math.abs(lat - pos.lateral) < SIDE_GAP) cap = Math.min(cap, oVel - 2);
    }
    this.speedCap = Math.max(cap, 0);
    if (!Number.isNaN(want)) {
      this.offsetTarget = want;
      this.offsetHold = 1;
    } else {
      this.offsetHold -= dt;
      if (this.offsetHold <= 0) this.offsetTarget = 0;
    }
    const step = OFFSET_RATE * dt;
    this.offset += clamp(this.offsetTarget - this.offset, -step, step);
  }

  /** Sideways slide of the car's body, radians (0 = rolling straight). */
  private slipAngle(car: Car): number {
    const q = car.rot;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const along = car.vel.x * fx + car.vel.z * fz;
    const side = car.vel.x * -fz + car.vel.z * fx;
    return Math.abs(Math.atan2(side, Math.abs(along)));
  }

  private indexAt(s: number): number {
    const n = this.n;
    const i = Math.floor(s / this.spacing) % n;
    return i < 0 ? i + n : i;
  }

  /** Interpolated per-sample value at distance `s`. */
  private sampleAt(values: Float32Array, s: number): number {
    const n = this.n;
    const f = s / this.spacing;
    const base = Math.floor(f);
    const w = f - base;
    let i = base % n;
    if (i < 0) i += n;
    const j = i + 1 === n ? 0 : i + 1;
    return values[i]! + (values[j]! - values[i]!) * w;
  }

  private laneAt(s: number): number {
    return this.sampleAt(this.lane, s);
  }

  private planAt(s: number): number {
    return this.sampleAt(this.plan, s);
  }

  /** World position of this driver's line (shifted by `offset`, kept on the road) at `s`. */
  private pointX(s: number, offset: number): number {
    const p = this.track.at(s);
    const lateral = clamp(this.laneAt(s) + offset, -this.edge, this.edge);
    return this.centreX(s) + -p.tz * lateral;
  }

  private pointZ(s: number, offset: number): number {
    const p = this.track.at(s);
    const lateral = clamp(this.laneAt(s) + offset, -this.edge, this.edge);
    return this.centreZ(s) + p.tx * lateral;
  }

  private centreX(s: number): number {
    const samples = this.track.samples;
    const n = this.n;
    const f = s / this.spacing;
    const base = Math.floor(f);
    let i = base % n;
    if (i < 0) i += n;
    const j = i + 1 === n ? 0 : i + 1;
    return samples[i]!.x + (samples[j]!.x - samples[i]!.x) * (f - base);
  }

  private centreZ(s: number): number {
    const samples = this.track.samples;
    const n = this.n;
    const f = s / this.spacing;
    const base = Math.floor(f);
    let i = base % n;
    if (i < 0) i += n;
    const j = i + 1 === n ? 0 : i + 1;
    return samples[i]!.z + (samples[j]!.z - samples[i]!.z) * (f - base);
  }
}
