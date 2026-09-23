import * as THREE from 'three/webgpu';
import { mulberry32 } from '../shared/math';
import type { Track } from '../sim/track/Track';

/**
 * TV coverage for replays. Trackside cameras stand just beyond the barriers every ~180 m,
 * alternating sides, some low and some high. The director shows the car from the camera it is
 * approaching (or has just passed) and cuts hard to the next one once that one is nearer,
 * never more than once every 2.5 s. Now and then, and wherever no trackside camera can see the
 * car, it switches to a helicopter following high above and looking down at about 35°. The aim
 * is a critically damped spring that leads the car slightly; the zoom keeps the car a roughly
 * constant size on screen.
 */

/** A trackside camera. */
export interface TvSpot {
  x: number;
  y: number;
  z: number;
  /** Distance along the lap it stands beside (0 … length). */
  s: number;
  /** +1 = right of the driving direction, -1 = left. */
  side: number;
  /** How far before and after `s` along the lap the car is in view and in reach, metres. */
  approach: number;
  pass: number;
}

export type TvShotKind = 'trackside' | 'helicopter';

/** A circle on the ground (a grandstand, a building): no camera inside, no view through it. */
export interface TvObstacle {
  x: number;
  z: number;
  r: number;
}

export interface TvDirectorOptions {
  obstacles?: readonly TvObstacle[];
  /** Seed for camera placement and shot variety (default: from the track id). */
  seed?: number;
}

const DEG = Math.PI / 180;
/** Shortest time between two cuts, seconds (`cut()` and a jumping target override it). */
const MIN_SHOT = 2.5;

// Trackside cameras.
/** Spacing along the lap (the lap is split evenly), ± a random shift: about 160–200 m. */
const SPACING = 180;
const SPACING_JITTER = 20;
/** Distance beyond the barrier face; low cameras stand closer than high ones. */
const BEYOND_MIN = 4;
const BEYOND_MAX = 12;
const LOW_MIN = 2.5;
const LOW_MAX = 4;
const HIGH_MIN = 5;
const HIGH_MAX = 8;
/** A camera stays at least this far beyond the barrier face of every part of the circuit. */
const MIN_CLEARANCE = 3.5;
/** Shifts along the lap tried when a camera doesn't fit where it was meant to go, metres. */
const SHIFTS = [0, 12, -12, 25, -25, 40, -40];
/** Straight-line reach of a camera, and how far before / after it along the lap it covers. */
const REACH = 180;
const APPROACH = 180;
const PASS = 90;
/**
 * The view is taken as clear while the sightline stays within this distance beyond the
 * barriers: TrackScene keeps its trees at least 15 m out. Checked every few metres.
 */
const SIGHT_CORRIDOR = 12;
const SIGHT_STEP = 6;
const VIEW_STEP = 8;
/** Height of the point aimed at on a car. */
const CAR_HEIGHT = 0.6;
/**
 * Shot choice: the nearest camera wins, but one the car is driving away from counts as this
 * much further, so the director follows a car past a camera for a while and then cuts to the
 * next one about when that one is nearer (~40 % of the way to it, not as soon as it is in
 * reach, when the car would be a speck).
 */
const AWAY_PENALTY = 1.6;
/** Nearer than this, distance no longer matters. */
const NEAR = 10;
/** A camera must be this much better (relative) than the current one to cut to it. */
const HYSTERESIS = 0.15;

// Helicopter.
const HELI_ALTITUDE_MIN = 28;
const HELI_ALTITUDE_MAX = 42;
const HELI_PITCH = 35 * DEG;
const HELI_PITCH_JITTER = 3 * DEG;
/** Bearing from behind the car: from three-quarters behind to just ahead of abeam. */
const HELI_AZIMUTH_MIN = 55 * DEG;
const HELI_AZIMUTH_MAX = 100 * DEG;
const HELI_DURATION_MIN = 5;
const HELI_DURATION_MAX = 8;
/** Seconds from one helicopter shot to the next; past `+ HELI_OVERDUE` it cuts in anyway. */
const HELI_INTERVAL_MIN = 28;
const HELI_INTERVAL_MAX = 45;
const HELI_OVERDUE = 12;
/** Side choice: the ground point is checked every step over the shot; beyond this, any is fine. */
const HELI_SCAN_STEP = 30;
const HELI_PLENTY = 25;
/** Half the stretch of centre line whose direction the helicopter holds station to. */
const HELI_TANGENT_SPAN = 20;

// Framing and motion.
/** Metres visible across the short side of the screen at the car's distance. */
const TRACKSIDE_FRAME = 8;
const HELI_FRAME = 26;
const FOV_MIN = 8;
const FOV_MAX = 60;
/** The aim leads the car by this long, at most this far and this fraction of the distance. */
const LEAD_TIME = 0.12;
const LEAD_MAX = 6;
const LEAD_FRACTION = 0.12;
/** Spring rates, 1/s. */
const AIM_RATE = 7;
const HELI_AIM_RATE = 4;
const HELI_MOVE_RATE = 2.5;
const FOV_RATE = 5;
/** A target moving further than this in one update (plus its travel) was seeked: cut. */
const JUMP = 40;
const MAX_SPEED = 150;
const MAX_STEP = 0.1;
/** Below this height the camera is kept outside the barriers. */
const SAFE_ALTITUDE = 12;
const MIN_HEIGHT = 1;

/** Point on the centre line and its unit tangent. */
interface Frame {
  x: number;
  z: number;
  tx: number;
  tz: number;
}

const frame = (): Frame => ({ x: 0, z: 0, tx: 0, tz: -1 });

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const between = (rand: () => number, lo: number, hi: number): number => lo + (hi - lo) * rand();

const isFinite3 = (v: THREE.Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

/** FNV-1a, for a per-track seed. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Centre-line point and tangent at `s` (wrapping), blended between samples. */
function frameAt(track: Track, s: number, out: Frame): Frame {
  const samples = track.samples;
  const n = samples.length;
  const u = ((((s % track.length) + track.length) % track.length) / track.length) * n;
  const i = Math.floor(u);
  const f = u - i;
  const a = samples[i % n]!;
  const b = samples[(i + 1) % n]!;
  out.x = a.x + (b.x - a.x) * f;
  out.z = a.z + (b.z - a.z) * f;
  const tx = a.tx + (b.tx - a.tx) * f;
  const tz = a.tz + (b.tz - a.tz) * f;
  const len = Math.hypot(tx, tz) || 1;
  out.tx = tx / len;
  out.tz = tz / len;
  return out;
}

const spanA = frame();
const spanB = frame();

/** Direction of the centre line over the stretch ±HELI_TANGENT_SPAN around `s`. */
function smoothTangent(track: Track, s: number, out: Frame): Frame {
  frameAt(track, s - HELI_TANGENT_SPAN, spanA);
  frameAt(track, s + HELI_TANGENT_SPAN, spanB);
  frameAt(track, s, out);
  const dx = spanB.x - spanA.x;
  const dz = spanB.z - spanA.z;
  const len = Math.hypot(dx, dz);
  if (len > 1e-6) {
    out.tx = dx / len;
    out.tz = dz / len;
  }
  return out;
}

/** Exact distance from a ground point to the centre line. */
function distanceToCentreLine(track: Track, x: number, z: number): number {
  const samples = track.samples;
  const n = samples.length;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = samples[i]!;
    const b = samples[(i + 1) % n]!;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 > 0 ? clamp(((x - a.x) * abx + (z - a.z) * abz) / len2, 0, 1) : 0;
    const dx = a.x + abx * t - x;
    const dz = a.z + abz * t - z;
    best = Math.min(best, dx * dx + dz * dz);
  }
  return Math.sqrt(best);
}

const inside = (obstacles: readonly TvObstacle[], x: number, z: number): boolean =>
  obstacles.some((o) => (o.x - x) ** 2 + (o.z - z) ** 2 < o.r * o.r);

/**
 * A camera near `s` on `side`, `beyond` metres past the barrier: moved along the lap, closer to
 * the barrier or to the other side if it would stand too near another part of the circuit or
 * in an obstacle. Null if nothing fits.
 */
function fitSpot(
  track: Track,
  s: number,
  side: number,
  beyond: number,
  height: number,
  obstacles: readonly TvObstacle[],
): TvSpot | null {
  const f = frame();
  for (const sd of [side, -side]) {
    for (const shift of SHIFTS) {
      for (const out of beyond > BEYOND_MIN ? [beyond, BEYOND_MIN] : [BEYOND_MIN]) {
        frameAt(track, s + shift, f);
        const d = track.wallOffset + out;
        // Right of the driving direction is the tangent turned a quarter clockwise: (-tz, tx).
        const x = f.x - f.tz * d * sd;
        const z = f.z + f.tx * d * sd;
        if (distanceToCentreLine(track, x, z) < track.wallOffset + MIN_CLEARANCE) continue;
        if (inside(obstacles, x, z)) continue;
        const at = (((s + shift) % track.length) + track.length) % track.length;
        return { x, y: height, z, s: at, side: sd, approach: 0, pass: 0 };
      }
    }
  }
  return null;
}

/** Can `spot` see a car at (x, z)? The sightline must stay near the track and miss obstacles. */
function clearView(
  track: Track,
  spot: TvSpot,
  x: number,
  z: number,
  corridor: number,
  obstacles: readonly TvObstacle[],
): boolean {
  const dx = x - spot.x;
  const dz = z - spot.z;
  const steps = Math.floor(Math.hypot(dx, dz) / VIEW_STEP);
  for (let k = 1; k < steps; k++) {
    const px = spot.x + (dx * k) / steps;
    const pz = spot.z + (dz * k) / steps;
    const lateral = Math.abs(track.project(px, pz).lateral);
    if (lateral > corridor) return false;
    if (lateral > track.wallOffset + 1 && inside(obstacles, px, pz)) return false;
  }
  return true;
}

/** How far along the lap from the camera (`direction` -1 = before it) the car stays in view. */
function visibleRun(
  track: Track,
  spot: TvSpot,
  direction: number,
  limit: number,
  corridor: number,
  obstacles: readonly TvObstacle[],
): number {
  const f = frame();
  let run = 0;
  for (let d = SIGHT_STEP; d <= limit; d += SIGHT_STEP) {
    frameAt(track, spot.s + direction * d, f);
    const reach2 = (f.x - spot.x) ** 2 + (spot.y - CAR_HEIGHT) ** 2 + (f.z - spot.z) ** 2;
    if (reach2 > REACH * REACH || !clearView(track, spot, f.x, f.z, corridor, obstacles)) break;
    run = d;
  }
  return run;
}

/**
 * Cameras around the lap: evenly split into ~SPACING m stretches with a random shift, sides
 * alternating, heights mixed (most odd-numbered cameras high and further back, most even ones
 * low and close to the barrier).
 */
function placeSpots(track: Track, rand: () => number, obstacles: readonly TvObstacle[]): TvSpot[] {
  const count = Math.max(2, Math.round(track.length / SPACING));
  const spacing = track.length / count;
  const jitter = Math.min(SPACING_JITTER, spacing * 0.12);
  const start = rand() * spacing;
  let side = rand() < 0.5 ? 1 : -1;
  const spots: TvSpot[] = [];
  for (let k = 0; k < count; k++) {
    const s = start + k * spacing + (rand() * 2 - 1) * jitter;
    const high = rand() < (k % 2 === 1 ? 0.75 : 0.25);
    const beyond = high ? between(rand, 7, BEYOND_MAX) : between(rand, BEYOND_MIN, 8);
    const height = high ? between(rand, HIGH_MIN, HIGH_MAX) : between(rand, LOW_MIN, LOW_MAX);
    const spot = fitSpot(track, s, side, beyond, height, obstacles);
    side = -side;
    if (!spot) continue;
    const own = distanceToCentreLine(track, spot.x, spot.z);
    const corridor = Math.max(track.wallOffset + SIGHT_CORRIDOR, own + 0.5);
    spot.approach = visibleRun(track, spot, -1, APPROACH, corridor, obstacles);
    spot.pass = visibleRun(track, spot, 1, PASS, corridor, obstacles);
    spots.push(spot);
  }
  return spots;
}

/**
 * One step of a critically damped spring pulling `pos` towards a goal moving at `goalVel`
 * (velocity feed-forward: a goal at constant velocity is followed without lag; only its changes
 * are smoothed). Solved exactly over the step, so it stays stable however long a frame is.
 */
function follow(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  goal: THREE.Vector3,
  goalVel: THREE.Vector3,
  rate: number,
  dt: number,
): void {
  const decay = Math.exp(-rate * dt);
  // Error relative to where the goal was at the start of the step.
  const ex = pos.x - goal.x + goalVel.x * dt;
  const ey = pos.y - goal.y + goalVel.y * dt;
  const ez = pos.z - goal.z + goalVel.z * dt;
  const vx = vel.x - goalVel.x;
  const vy = vel.y - goalVel.y;
  const vz = vel.z - goalVel.z;
  const bx = vx + rate * ex;
  const by = vy + rate * ey;
  const bz = vz + rate * ez;
  pos.set(
    goal.x + (ex + bx * dt) * decay,
    goal.y + (ey + by * dt) * decay,
    goal.z + (ez + bz * dt) * decay,
  );
  vel.set(
    goalVel.x + (vx - rate * bx * dt) * decay,
    goalVel.y + (vy - rate * by * dt) * decay,
    goalVel.z + (vz - rate * bz * dt) * decay,
  );
}

/**
 * Directs a TV-style camera onto one car. Call `update` every frame with the car's position and
 * velocity (from a `Replay` or live); it moves, aims and zooms the camera. Call `cut()` after a
 * seek or when switching to another car.
 */
export class TvDirector {
  /** Trackside cameras, in driving order around the lap. */
  readonly spots: readonly TvSpot[];
  private readonly track: Track;
  private readonly rand: () => number;
  private readonly frame = frame();

  private kind: TvShotKind = 'trackside';
  private spot = -1;
  private cutPending = true;
  /** Seconds since the last cut, and since the last helicopter shot started. */
  private shotTime = 0;
  private sinceHeli = 0;
  private heliInterval: number;
  private heliDuration = 0;
  private heliSide = 1;
  /** Bearing of the helicopter from behind the car, radians. */
  private heliAzimuth = 0;
  private heliAltitude = HELI_ALTITUDE_MIN;
  /** Horizontal distance from the car. */
  private heliDistance = 0;

  /** Last valid target and its velocity. */
  private hasTarget = false;
  private readonly target = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private hint = -1;
  /** +1 while the car goes the way the lap runs, -1 while it goes backwards. */
  private travel = 1;

  private readonly position = new THREE.Vector3();
  private readonly positionVelocity = new THREE.Vector3();
  private readonly goal = new THREE.Vector3();
  private readonly lastGoal = new THREE.Vector3();
  private readonly goalVelocity = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  private readonly aimVelocity = new THREE.Vector3();
  private readonly aimGoal = new THREE.Vector3();
  private fov = 30;

  constructor(track: Track, options: TvDirectorOptions = {}) {
    this.track = track;
    const seed = options.seed ?? hashString(track.def.id);
    this.spots = placeSpots(track, mulberry32(seed), options.obstacles ?? []);
    this.rand = mulberry32(seed ^ 0x9e3779b9);
    this.heliInterval = between(this.rand, HELI_INTERVAL_MIN, HELI_INTERVAL_MAX);
  }

  /** What is on screen: a trackside camera or the helicopter. */
  get shotKind(): TvShotKind {
    return this.kind;
  }

  /** Index in `spots` of the trackside camera on screen, or -1 for the helicopter. */
  get currentSpot(): number {
    return this.kind === 'trackside' ? this.spot : -1;
  }

  /** Picks a new shot on the next update, without waiting (after a seek or a change of car). */
  cut(): void {
    this.cutPending = true;
    this.hint = -1;
  }

  /**
   * Places, aims and zooms `camera` (position, orientation, up, fov) for a car at `target`
   * moving at `targetVelocity`. Non-finite input is ignored (the last good target is kept).
   */
  update(
    dt: number,
    target: THREE.Vector3,
    targetVelocity: THREE.Vector3,
    camera: THREE.PerspectiveCamera,
  ): void {
    const step = dt > 0 ? Math.min(dt, MAX_STEP) : 0;
    this.readTarget(target, targetVelocity, step);
    const pr = this.track.project(this.target.x, this.target.z, this.hint);
    this.hint = pr.index;
    const sample = this.track.samples[pr.index]!;
    const along = this.velocity.x * sample.tx + this.velocity.z * sample.tz;
    if (Math.abs(along) > 1) this.travel = along < 0 ? -1 : 1;
    this.shotTime += step;
    this.sinceHeli += step;

    const cut = this.direct(pr.s);
    if (this.kind === 'helicopter') this.fly(step, pr.s, cut);
    else {
      const spot = this.spots[this.spot]!;
      this.position.set(spot.x, spot.y, spot.z);
      this.positionVelocity.set(0, 0, 0);
    }
    this.keepSafe();
    this.aimAt(step, cut);
    this.zoom(step, cut, camera.aspect);

    camera.up.set(0, 1, 0);
    camera.position.copy(this.position);
    camera.lookAt(this.aim);
    if (camera.fov !== this.fov) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
  }

  private readTarget(target: THREE.Vector3, velocity: THREE.Vector3, dt: number): void {
    if (!isFinite3(target)) {
      this.velocity.set(0, 0, 0);
      if (!this.hasTarget) {
        // Nothing to look at yet: the start line.
        const start = this.track.samples[0]!;
        this.target.set(start.x, CAR_HEIGHT, start.z);
        this.hasTarget = true;
        this.cutPending = true;
      }
      return;
    }
    if (this.hasTarget) {
      const allowed = JUMP + this.velocity.length() * dt * 2;
      if (this.target.distanceToSquared(target) > allowed * allowed) this.cut();
    } else this.cutPending = true;
    this.target.copy(target);
    this.hasTarget = true;
    if (isFinite3(velocity)) {
      this.velocity.copy(velocity);
      if (this.velocity.lengthSq() > MAX_SPEED * MAX_SPEED) this.velocity.setLength(MAX_SPEED);
    } else this.velocity.set(0, 0, 0);
  }

  /** Chooses the shot; true when it cut to a new one. */
  private direct(s: number): boolean {
    let bestScore = 0;
    let best = -1;
    const current = this.kind === 'trackside' && !this.cutPending ? this.spot : -1;
    for (let k = 0; k < this.spots.length; k++) {
      // A new shot should last: a camera the car will leave within MIN_SHOT counts for less.
      const score = this.score(k, s) * (k === current ? 1 : this.lasting(k, s));
      if (score > bestScore) {
        bestScore = score;
        best = k;
      }
    }
    if (this.cutPending) {
      this.cutPending = false;
      if (best >= 0) this.showSpot(best);
      else this.startHeli(s);
      return true;
    }
    if (this.shotTime < MIN_SHOT) return false;
    if (this.kind === 'helicopter') {
      if (this.shotTime < this.heliDuration || best < 0) return false;
      this.showSpot(best);
      return true;
    }
    const now = this.score(this.spot, s);
    const heliDue = this.sinceHeli >= this.heliInterval;
    if (now <= 0 || (best !== this.spot && bestScore > now * (1 + HYSTERESIS))) {
      // Now and then the helicopter instead of the next trackside camera.
      if (heliDue || best < 0) this.startHeli(s);
      else this.showSpot(best);
      return true;
    }
    if (this.sinceHeli >= this.heliInterval + HELI_OVERDUE) {
      this.startHeli(s);
      return true;
    }
    return false;
  }

  /**
   * How well trackside camera `k` shows a car at `s`: 1 / distance, with a car driving away
   * counted AWAY_PENALTY times further; 0 when out of view or reach.
   */
  private score(k: number, s: number): number {
    const spot = this.spots[k]!;
    const ds = spot.s - s - this.track.length * Math.round((spot.s - s) / this.track.length);
    if (ds > spot.approach || ds < -spot.pass) return 0;
    const reach2 =
      (spot.x - this.target.x) ** 2 + (spot.y - this.target.y) ** 2 + (spot.z - this.target.z) ** 2;
    if (reach2 > REACH * REACH) return 0;
    const distance = Math.max(Math.sqrt(reach2), NEAR);
    // Coming towards the camera: it is ahead in the direction the car is going.
    return ds * this.travel >= 0 ? 1 / distance : 1 / (distance * AWAY_PENALTY);
  }

  /** 1 if camera `k` keeps the car in its window for MIN_SHOT or more, down to 0.1 if not. */
  private lasting(k: number, s: number): number {
    const spot = this.spots[k]!;
    const ds = spot.s - s - this.track.length * Math.round((spot.s - s) / this.track.length);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 1) return 1;
    const left = this.travel > 0 ? ds + spot.pass : spot.approach - ds;
    return clamp(left / (speed * MIN_SHOT), 0.1, 1);
  }

  private showSpot(k: number): void {
    this.kind = 'trackside';
    this.spot = k;
    this.shotTime = 0;
  }

  private startHeli(s: number): void {
    const rand = this.rand;
    this.kind = 'helicopter';
    this.spot = -1;
    this.shotTime = 0;
    this.sinceHeli = 0;
    this.heliInterval = between(rand, HELI_INTERVAL_MIN, HELI_INTERVAL_MAX);
    this.heliDuration = between(rand, HELI_DURATION_MIN, HELI_DURATION_MAX);
    this.heliAltitude = between(rand, HELI_ALTITUDE_MIN, HELI_ALTITUDE_MAX);
    const pitch = HELI_PITCH + (rand() * 2 - 1) * HELI_PITCH_JITTER;
    this.heliDistance = Math.max(this.heliAltitude - this.target.y, 10) / Math.tan(pitch);
    this.heliAzimuth = between(rand, HELI_AZIMUTH_MIN, HELI_AZIMUTH_MAX);
    // The side whose ground track keeps clearest of the circuit over the shot.
    smoothTangent(this.track, s, this.frame);
    const along = this.velocity.x * this.frame.tx + this.velocity.z * this.frame.tz;
    const ahead = clamp(Math.abs(along) * this.heliDuration, 60, 600) * (along < 0 ? -1 : 1);
    const right = this.heliClearance(s, 1, ahead);
    const left = this.heliClearance(s, -1, ahead);
    if (Math.abs(right - left) < 2) this.heliSide = rand() < 0.5 ? 1 : -1;
    else this.heliSide = right > left ? 1 : -1;
  }

  /** Least distance from the centre line of the helicopter's ground point over the next `ahead` m. */
  private heliClearance(s: number, side: number, ahead: number): number {
    const f = this.frame;
    const back = Math.cos(this.heliAzimuth) * this.heliDistance;
    const across = Math.sin(this.heliAzimuth) * this.heliDistance * side;
    const steps = Math.max(1, Math.ceil(Math.abs(ahead) / HELI_SCAN_STEP));
    let clear = Infinity;
    for (let k = 0; k <= steps; k++) {
      smoothTangent(this.track, s + (ahead * k) / steps, f);
      const x = f.x - f.tx * back - f.tz * across;
      const z = f.z - f.tz * back + f.tx * across;
      clear = Math.min(clear, distanceToCentreLine(this.track, x, z));
    }
    return Math.min(clear, this.track.wallOffset + HELI_PLENTY);
  }

  /** Helicopter: holds station beside and behind the car, relative to the track's direction. */
  private fly(dt: number, s: number, cut: boolean): void {
    const f = smoothTangent(this.track, s, this.frame);
    const back = Math.cos(this.heliAzimuth) * this.heliDistance;
    const across = Math.sin(this.heliAzimuth) * this.heliDistance * this.heliSide;
    this.goal.set(
      this.target.x - f.tx * back - f.tz * across,
      this.heliAltitude,
      this.target.z - f.tz * back + f.tx * across,
    );
    if (cut) {
      this.position.copy(this.goal);
      this.positionVelocity.set(this.velocity.x, 0, this.velocity.z);
    } else if (dt > 0) {
      this.goalVelocity.subVectors(this.goal, this.lastGoal).divideScalar(dt);
      if (this.goalVelocity.lengthSq() > MAX_SPEED * MAX_SPEED) {
        this.goalVelocity.setLength(MAX_SPEED);
      }
      follow(
        this.position,
        this.positionVelocity,
        this.goal,
        this.goalVelocity,
        HELI_MOVE_RATE,
        dt,
      );
    }
    this.lastGoal.copy(this.goal);
  }

  /** Never NaN, never under the ground, never low inside the barriers. */
  private keepSafe(): void {
    const p = this.position;
    if (!isFinite3(p)) {
      p.set(this.target.x, this.target.y + HELI_ALTITUDE_MAX, this.target.z);
      this.positionVelocity.set(0, 0, 0);
    }
    if (p.y < SAFE_ALTITUDE) {
      const track = this.track;
      const pr = track.project(p.x, p.z);
      const need = track.wallOffset + 1;
      if (Math.abs(pr.lateral) < need) {
        const sample = track.samples[pr.index]!;
        const along = (p.x - sample.x) * sample.tx + (p.z - sample.z) * sample.tz;
        const side = pr.lateral < 0 ? -1 : 1;
        p.x = sample.x + sample.tx * along - sample.tz * need * side;
        p.z = sample.z + sample.tz * along + sample.tx * need * side;
      }
    }
    if (p.y < MIN_HEIGHT) p.y = MIN_HEIGHT;
  }

  /** Critically damped aim at the car, leading it slightly. */
  private aimAt(dt: number, cut: boolean): void {
    const distance = Math.max(this.position.distanceTo(this.target), 1);
    const goal = this.aimGoal.copy(this.velocity).multiplyScalar(LEAD_TIME);
    const limit = Math.min(LEAD_MAX, distance * LEAD_FRACTION);
    if (goal.lengthSq() > limit * limit) goal.setLength(limit);
    goal.add(this.target);
    if (cut || !isFinite3(this.aim) || !isFinite3(this.aimVelocity)) {
      this.aim.copy(goal);
      this.aimVelocity.copy(this.velocity);
    } else if (dt > 0) {
      const rate = this.kind === 'helicopter' ? HELI_AIM_RATE : AIM_RATE;
      follow(this.aim, this.aimVelocity, goal, this.velocity, rate, dt);
    }
    if (this.aim.distanceToSquared(this.position) < 1e-4) {
      // The aim point on the camera itself has no direction: look ahead and down instead.
      this.aim.set(this.position.x, this.position.y - 1, this.position.z - 1);
    }
  }

  /** Field of view that keeps the car about the same size on screen. */
  private zoom(dt: number, cut: boolean, aspect: number): void {
    const shortSide = aspect > 0 && aspect < 1 ? aspect : 1;
    const size = (this.kind === 'helicopter' ? HELI_FRAME : TRACKSIDE_FRAME) / shortSide;
    const distance = Math.max(this.position.distanceTo(this.target), 0.5);
    const goal = clamp((2 * Math.atan(size / (2 * distance))) / DEG, FOV_MIN, FOV_MAX);
    if (cut || !Number.isFinite(this.fov)) this.fov = goal;
    else this.fov += (goal - this.fov) * (1 - Math.exp(-FOV_RATE * dt));
    this.fov = clamp(this.fov, FOV_MIN, FOV_MAX);
  }
}
