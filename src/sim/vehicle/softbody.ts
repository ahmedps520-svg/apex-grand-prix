import {
  PART_BUMPER_FRONT,
  PART_BUMPER_REAR,
  PART_DOOR_LEFT,
  PART_DOOR_RIGHT,
  PART_HOOD,
  PART_WING,
  SOFT_NODES,
} from '../../shared/protocol';
import type { CarSpec } from './spec';

/**
 * A soft body for the car's shell: a coarse node-and-beam lattice in the body frame (3 wide,
 * 2 high, 5 long: nose, front axle, cabin, rear axle, tail) whose nodes ride on springs to their
 * rest positions and on beams to their neighbours. An impact throws the nearby nodes inwards;
 * beams and anchors that stretch past their yield stay stretched (plastic deformation), so the
 * crumple is permanent until a repair. The ends are soft (crumple zones), the cabin stiff (the
 * safety cell). From the permanent deformation come the crush of each end and side, the bend
 * of the chassis (which pulls the steering), the crush at each corner (which wrecks that
 * corner's suspension) and which panels have come off.
 *
 * The rigid body still does the handling; this lattice is the shape, and it feeds back into
 * the handling through those measurements. It is small on purpose (30 nodes, ~200 beams):
 * a few microseconds a step, and it sleeps between impacts.
 */

export const SOFT_NX = 3;
export const SOFT_NY = 2;
export const SOFT_NZ = 5;

/**
 * Spring rates (N/m) of the structural beams, the shear beams and the anchors: a soft shell
 * (sheet metal) around the cabin's safety cell, whose beams and anchors are stiffer.
 */
const STRUCT_K = 30_000;
const SHEAR_K = 12_000;
const ANCHOR_K = 12_000;
/** Stiffness and yield of the anchors by row: nose, front axle, cabin, rear axle, tail. */
const ROW_STIFFNESS = [1, 2, 4, 2, 1];
const ROW_YIELD = [0.015, 0.03, 0.06, 0.03, 0.015];
const CELL_STIFFNESS = 3;
/**
 * Damping ratios: light, so a blow travels into the shell rather than stopping at the skin (the
 * plastic flow takes the energy out), and the sum over a node's beams stays stable.
 */
const ANCHOR_DAMPING = 0.2;
const BEAM_DAMPING = 0.05;
/** Beam strain beyond which deformation becomes permanent. */
const YIELD_STRAIN = 0.02;
/** How fast the excess over the yield turns permanent, 1/s (metal yields at once). */
const PLASTIC_RATE = 400;
/** A node can be crushed at most this far from where it was, m; a beam to this share. */
const MAX_NODE_CRUSH = 0.6;
const MIN_BEAM_SCALE = 0.3;
/** An impact pushes the nodes within this radius, m, most at its centre, to at most this speed. */
const IMPACT_RADIUS = 1.4;
const MAX_NODE_SPEED = 12;
/** A sustained contact (against a wall) pushes at the closing speed times this per second. */
const PRESS_RATE = 24;
const SLEEP_SPEED = 0.01;
const SLEEP_AFTER = 0.3;
const MEASURE_HZ = 50;
/** Permanent crush that takes a panel off, m (the worst node of the panel's row). */
const HOOD_OFF = 0.12;
const BUMPER_OFF = 0.1;
const DOOR_OFF = 0.12;
const WING_OFF = 0.16;

export interface SoftMetrics {
  /** Permanent crush of each end and side and the roof, m (mean over that face's nodes). */
  front: number;
  rear: number;
  left: number;
  right: number;
  roof: number;
  /** Bend of the chassis: yaw of the nose relative to the tail, radians (+ = nose to the right). */
  bend: number;
  /** Crush at each wheel's corner, 0 … 1 (front left, front right, rear left, rear right). */
  corner: [number, number, number, number];
  /** Panels that have come off, PART_* flags. */
  parts: number;
}

interface Beam {
  a: number;
  b: number;
  /** Rest length now (plastic) and as built. */
  rest: number;
  rest0: number;
  k: number;
  c: number;
}

/** Node index in the lattice and the snapshot. */
export const nodeIndex = (ix: number, iy: number, iz: number): number =>
  (iz * SOFT_NY + iy) * SOFT_NX + ix;

/** The lattice's rest positions in the body frame (x right, y up, z back), from the car's spec. */
export function latticeRest(spec: CarSpec): Float32Array {
  const axes = latticeAxes(spec);
  const out = new Float32Array(SOFT_NODES * 3);
  for (let iz = 0; iz < SOFT_NZ; iz++) {
    for (let iy = 0; iy < SOFT_NY; iy++) {
      for (let ix = 0; ix < SOFT_NX; ix++) {
        const n = nodeIndex(ix, iy, iz) * 3;
        out[n] = axes.xs[ix]!;
        out[n + 1] = axes.ys[iy]!;
        out[n + 2] = axes.zs[iz]!;
      }
    }
  }
  return out;
}

/** The lattice's grid lines on each axis. */
export function latticeAxes(spec: CarSpec): { xs: number[]; ys: number[]; zs: number[] } {
  const body = spec.body;
  const zf = -spec.front.offset;
  const zr = -spec.rear.offset;
  return {
    xs: [-body.halfWidth, 0, body.halfWidth],
    ys: [body.floor + 0.05, body.roof],
    zs: [-body.front, zf, (zf + zr) / 2, zr, body.rear],
  };
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number, number, boolean]> = [
  [1, 0, 0, true],
  [0, 1, 0, true],
  [0, 0, 1, true],
  [1, 1, 0, false],
  [1, -1, 0, false],
  [1, 0, 1, false],
  [1, 0, -1, false],
  [0, 1, 1, false],
  [0, 1, -1, false],
];

type Pick = (ix: number, iy: number, iz: number) => boolean;

export class SoftBody {
  readonly rest: Float32Array;
  /** Where each node is, its velocity, and where its anchor spring now sits (plastic). */
  readonly pos: Float32Array;
  readonly vel: Float32Array;
  readonly anchor: Float32Array;
  readonly metrics: SoftMetrics = {
    front: 0,
    rear: 0,
    left: 0,
    right: 0,
    roof: 0,
    bend: 0,
    corner: [0, 0, 0, 0],
    parts: 0,
  };
  private readonly beams: Beam[] = [];
  private readonly accel: Float32Array;
  /** Each node's anchor stiffness, damping and yield (stiffer towards the cabin). */
  private readonly anchorK: Float32Array;
  private readonly anchorC: Float32Array;
  private readonly anchorYield: Float32Array;
  private readonly mass: number;
  private awake = false;
  private quietFor = 0;
  private measureTimer = 0;
  /** True once anything is permanently bent. */
  damaged = false;

  constructor(spec: CarSpec) {
    this.rest = latticeRest(spec);
    this.pos = new Float32Array(this.rest);
    this.anchor = new Float32Array(this.rest);
    this.vel = new Float32Array(SOFT_NODES * 3);
    this.accel = new Float32Array(SOFT_NODES * 3);
    this.anchorK = new Float32Array(SOFT_NODES);
    this.anchorC = new Float32Array(SOFT_NODES);
    this.anchorYield = new Float32Array(SOFT_NODES);
    // The shell carries half the car's mass, shared by the nodes.
    this.mass = (spec.mass * 0.5) / SOFT_NODES;
    for (let iz = 0; iz < SOFT_NZ; iz++) {
      for (let iy = 0; iy < SOFT_NY; iy++) {
        for (let ix = 0; ix < SOFT_NX; ix++) {
          const n = nodeIndex(ix, iy, iz);
          const k = ANCHOR_K * ROW_STIFFNESS[iz]!;
          this.anchorK[n] = k;
          this.anchorC[n] = 2 * ANCHOR_DAMPING * Math.sqrt(k * this.mass);
          this.anchorYield[n] = ROW_YIELD[iz]!;
          for (const [dx, dy, dz, structural] of NEIGHBOURS) {
            const jx = ix + dx;
            const jy = iy + dy;
            const jz = iz + dz;
            if (jx < 0 || jx >= SOFT_NX || jy < 0 || jy >= SOFT_NY || jz < 0 || jz >= SOFT_NZ) {
              continue;
            }
            const b = nodeIndex(jx, jy, jz);
            const rest = this.distance(this.rest, n, b);
            if (rest < 1e-4) continue;
            const cell = iz === 2 || jz === 2 ? CELL_STIFFNESS : 1;
            const beamK = (structural ? STRUCT_K : SHEAR_K) * cell;
            this.beams.push({
              a: n,
              b,
              rest,
              rest0: rest,
              k: beamK,
              c: 2 * BEAM_DAMPING * Math.sqrt(beamK * this.mass),
            });
          }
        }
      }
    }
  }

  /** An instantaneous blow at a body-frame point: the nearby nodes take off along `dir`. */
  impact(x: number, y: number, z: number, dx: number, dy: number, dz: number, speed: number): void {
    if (!(speed > 0)) return;
    const pos = this.pos;
    const vel = this.vel;
    for (let n = 0; n < SOFT_NODES; n++) {
      const i = n * 3;
      const d = Math.hypot(pos[i]! - x, pos[i + 1]! - y, pos[i + 2]! - z);
      if (d >= IMPACT_RADIUS) continue;
      const w = (1 - d / IMPACT_RADIUS) * speed;
      let vx = vel[i]! + dx * w;
      let vy = vel[i + 1]! + dy * w;
      let vz = vel[i + 2]! + dz * w;
      const v = Math.hypot(vx, vy, vz);
      if (v > MAX_NODE_SPEED) {
        vx *= MAX_NODE_SPEED / v;
        vy *= MAX_NODE_SPEED / v;
        vz *= MAX_NODE_SPEED / v;
      }
      vel[i] = vx;
      vel[i + 1] = vy;
      vel[i + 2] = vz;
    }
    this.awake = true;
    this.quietFor = 0;
  }

  /** A sustained push (a wall) at a body-frame point, at a closing speed, over one step. */
  press(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    closingSpeed: number,
    dt: number,
  ): void {
    this.impact(x, y, z, dx, dy, dz, closingSpeed * PRESS_RATE * dt);
  }

  step(dt: number): void {
    if (!this.awake) return;
    const pos = this.pos;
    const vel = this.vel;
    const acc = this.accel;
    const anchor = this.anchor;
    const rest = this.rest;
    const m = this.mass;
    const plastic = Math.min(PLASTIC_RATE * dt, 1);
    // Anchors: springs to the (plastic) rest position, with the yield moving the rest.
    for (let n = 0; n < SOFT_NODES; n++) {
      const i = n * 3;
      const k = this.anchorK[n]!;
      const c = this.anchorC[n]!;
      const ex = pos[i]! - anchor[i]!;
      const ey = pos[i + 1]! - anchor[i + 1]!;
      const ez = pos[i + 2]! - anchor[i + 2]!;
      acc[i] = (-k * ex - c * vel[i]!) / m;
      acc[i + 1] = (-k * ey - c * vel[i + 1]!) / m;
      acc[i + 2] = (-k * ez - c * vel[i + 2]!) / m;
      const e = Math.hypot(ex, ey, ez);
      const yieldAt = this.anchorYield[n]!;
      if (e > yieldAt) {
        const move = (1 - yieldAt / e) * plastic;
        anchor[i] = anchor[i]! + ex * move;
        anchor[i + 1] = anchor[i + 1]! + ey * move;
        anchor[i + 2] = anchor[i + 2]! + ez * move;
        // Never further than the crush limit from where the node was built.
        const cx = anchor[i]! - rest[i]!;
        const cy = anchor[i + 1]! - rest[i + 1]!;
        const cz = anchor[i + 2]! - rest[i + 2]!;
        const crush = Math.hypot(cx, cy, cz);
        if (crush > MAX_NODE_CRUSH) {
          const s = MAX_NODE_CRUSH / crush;
          anchor[i] = rest[i]! + cx * s;
          anchor[i + 1] = rest[i + 1]! + cy * s;
          anchor[i + 2] = rest[i + 2]! + cz * s;
        }
        this.damaged = true;
      }
    }
    // Beams: tension and compression between neighbours, yielding past the strain limit.
    for (const beam of this.beams) {
      const a = beam.a * 3;
      const b = beam.b * 3;
      const dx = pos[b]! - pos[a]!;
      const dy = pos[b + 1]! - pos[a + 1]!;
      const dz = pos[b + 2]! - pos[a + 2]!;
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-6) continue;
      const nx = dx / len;
      const ny = dy / len;
      const nz = dz / len;
      const relv =
        (vel[b]! - vel[a]!) * nx +
        (vel[b + 1]! - vel[a + 1]!) * ny +
        (vel[b + 2]! - vel[a + 2]!) * nz;
      const f = (beam.k * (len - beam.rest) + beam.c * relv) / m;
      acc[a] = acc[a]! + nx * f;
      acc[a + 1] = acc[a + 1]! + ny * f;
      acc[a + 2] = acc[a + 2]! + nz * f;
      acc[b] = acc[b]! - nx * f;
      acc[b + 1] = acc[b + 1]! - ny * f;
      acc[b + 2] = acc[b + 2]! - nz * f;
      const strain = (len - beam.rest) / beam.rest;
      if (Math.abs(strain) > YIELD_STRAIN) {
        const excess = len - beam.rest - Math.sign(strain) * YIELD_STRAIN * beam.rest;
        beam.rest = Math.min(
          Math.max(beam.rest + excess * plastic, beam.rest0 * MIN_BEAM_SCALE),
          beam.rest0 * 1.15,
        );
        this.damaged = true;
      }
    }
    // Integrate (semi-implicit Euler), and see whether everything has settled.
    let fastest = 0;
    for (let i = 0; i < SOFT_NODES * 3; i++) {
      const v = vel[i]! + acc[i]! * dt;
      vel[i] = v;
      pos[i] = pos[i]! + v * dt;
      const s = Math.abs(v);
      if (s > fastest) fastest = s;
    }
    this.quietFor = fastest < SLEEP_SPEED ? this.quietFor + dt : 0;
    if (this.quietFor > SLEEP_AFTER) {
      this.awake = false;
      this.quietFor = 0;
      // Settle exactly on the anchors so the last snapshot is clean.
      for (let i = 0; i < SOFT_NODES * 3; i++) {
        pos[i] = anchor[i]!;
        vel[i] = 0;
      }
      this.measure();
      return;
    }
    this.measureTimer += dt;
    if (this.measureTimer >= 1 / MEASURE_HZ) {
      this.measureTimer = 0;
      this.measure();
    }
  }

  /** Reads the permanent deformation into `metrics`. */
  measure(): void {
    const m = this.metrics;
    const a = this.anchor;
    const r = this.rest;
    m.front = this.crush((_ix, _iy, iz) => iz === 0, 2, 1, 'mean');
    m.rear = this.crush((_ix, _iy, iz) => iz === SOFT_NZ - 1, 2, -1, 'mean');
    m.left = this.crush((ix) => ix === 0, 0, 1, 'mean');
    m.right = this.crush((ix) => ix === SOFT_NX - 1, 0, -1, 'mean');
    m.roof = this.crush((_ix, iy) => iy === SOFT_NY - 1, 1, -1, 'mean');
    // The chassis bend: the nose's centre against the tail's centre.
    const nose = this.centre(0);
    const tail = this.centre(SOFT_NZ - 1);
    m.bend = Math.atan2(nose.x - tail.x, -(nose.z - tail.z));
    // Corners: the floor node beside each wheel.
    const corners: Array<[number, number]> = [
      [0, 1],
      [SOFT_NX - 1, 1],
      [0, SOFT_NZ - 2],
      [SOFT_NX - 1, SOFT_NZ - 2],
    ];
    corners.forEach(([ix, iz], w) => {
      const i = nodeIndex(ix, 0, iz) * 3;
      const d = Math.hypot(a[i]! - r[i]!, a[i + 1]! - r[i + 1]!, a[i + 2]! - r[i + 2]!);
      m.corner[w] = Math.min(d / 0.3, 1);
    });
    // Panels come off (and stay off) past a crush of their worst node.
    const hood = this.crush((_ix, iy, iz) => iz === 0 && iy === 1, 2, 1, 'max');
    const bumperF = this.crush((_ix, _iy, iz) => iz === 0, 2, 1, 'max');
    const bumperR = this.crush((_ix, _iy, iz) => iz === SOFT_NZ - 1, 2, -1, 'max');
    const doorL = this.crush((ix, _iy, iz) => ix === 0 && iz === 2, 0, 1, 'max');
    const doorR = this.crush((ix, _iy, iz) => ix === SOFT_NX - 1 && iz === 2, 0, -1, 'max');
    const wing = this.crush((_ix, iy, iz) => iz === SOFT_NZ - 1 && iy === 1, 2, -1, 'max');
    let parts = m.parts;
    if (hood > HOOD_OFF) parts |= PART_HOOD;
    if (bumperF > BUMPER_OFF) parts |= PART_BUMPER_FRONT;
    if (bumperR > BUMPER_OFF) parts |= PART_BUMPER_REAR;
    if (doorL > DOOR_OFF) parts |= PART_DOOR_LEFT;
    if (doorR > DOOR_OFF) parts |= PART_DOOR_RIGHT;
    if (wing > WING_OFF || m.roof > WING_OFF) parts |= PART_WING;
    m.parts = parts;
  }

  /** Back to the shape it was built with. */
  reset(): void {
    this.pos.set(this.rest);
    this.anchor.set(this.rest);
    this.vel.fill(0);
    for (const beam of this.beams) beam.rest = beam.rest0;
    this.awake = false;
    this.quietFor = 0;
    this.damaged = false;
    const m = this.metrics;
    m.front = m.rear = m.left = m.right = m.roof = m.bend = 0;
    m.corner.fill(0);
    m.parts = 0;
  }

  /** Node displacements from rest (x, y, z each), then the parts flags. */
  writeSnapshot(out: Float32Array, base: number): void {
    const pos = this.pos;
    const rest = this.rest;
    for (let i = 0; i < SOFT_NODES * 3; i++) out[base + i] = pos[i]! - rest[i]!;
    out[base + SOFT_NODES * 3] = this.metrics.parts;
  }

  /** Permanent displacement of the picked nodes along an axis (inwards = positive). */
  private crush(pick: Pick, axis: number, sign: number, agg: 'mean' | 'max'): number {
    let sum = 0;
    let max = 0;
    let count = 0;
    for (let iz = 0; iz < SOFT_NZ; iz++) {
      for (let iy = 0; iy < SOFT_NY; iy++) {
        for (let ix = 0; ix < SOFT_NX; ix++) {
          if (!pick(ix, iy, iz)) continue;
          const i = nodeIndex(ix, iy, iz) * 3 + axis;
          const d = (this.anchor[i]! - this.rest[i]!) * sign;
          sum += d;
          if (d > max) max = d;
          count++;
        }
      }
    }
    if (count === 0) return 0;
    return agg === 'max' ? max : Math.max(sum / count, 0);
  }

  private centre(iz: number): { x: number; z: number } {
    let x = 0;
    let z = 0;
    for (let iy = 0; iy < SOFT_NY; iy++) {
      for (let ix = 0; ix < SOFT_NX; ix++) {
        const i = nodeIndex(ix, iy, iz) * 3;
        x += this.anchor[i]!;
        z += this.anchor[i + 2]!;
      }
    }
    const n = SOFT_NX * SOFT_NY;
    return { x: x / n, z: z / n };
  }

  private distance(p: Float32Array, a: number, b: number): number {
    return Math.hypot(
      p[b * 3]! - p[a * 3]!,
      p[b * 3 + 1]! - p[a * 3 + 1]!,
      p[b * 3 + 2]! - p[a * 3 + 2]!,
    );
  }
}
