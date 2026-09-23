import * as THREE from 'three/webgpu';
import { KERB_WIDTH, type Track } from '../sim/track/Track';

/**
 * Geometry built along a track's centre line: road, kerbs, painted lines, run-off and barriers.
 * Surfaces are split into cells, one per centre-line sample, running from halfway to the previous
 * sample to halfway to the next: the stretch where the physics uses that sample's kerb and run-off
 * flags, so what you see is what you drive on. Right of the driving direction is (−tz, tx).
 */

/** Heights of the flat layers above the ground. They are polygon-offset as well (TrackScene). */
export const RUNOFF_Y = 0.003;
export const ROAD_Y = 0.006;
export const LINE_Y = 0.012;
export const KERB_Y = 0.02;
/** Painted edge line width, metres. */
const LINE_WIDTH = 0.2;
/** Grid box: half width across the lane, depth of the bars, and how far ahead of the car. */
const GRID_HALF_WIDTH = 1.35;
const GRID_BAR = 0.2;
const GRID_SIDE = 1.6;
const GRID_AHEAD = 2.75;
const GRID_SLOTS = 12;

/** Growable indexed mesh; each triangle is wound to face the way its first vertex normal points. */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  constructor(private readonly withColors = false) {}

  /** Adds a vertex and returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u = 0,
    v = 0,
    color?: THREE.Color,
  ): number {
    this.positions.push(x, y, z);
    this.normals.push(nx, ny, nz);
    this.uvs.push(u, v);
    if (this.withColors) this.colors.push(color?.r ?? 1, color?.g ?? 1, color?.b ?? 1);
    return this.positions.length / 3 - 1;
  }

  /** Quad through a, b, c, d in order around its edge. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  triangle(a: number, b: number, c: number): void {
    const p = this.positions;
    const ax = p[a * 3]!;
    const ay = p[a * 3 + 1]!;
    const az = p[a * 3 + 2]!;
    const ux = p[b * 3]! - ax;
    const uy = p[b * 3 + 1]! - ay;
    const uz = p[b * 3 + 2]! - az;
    const vx = p[c * 3]! - ax;
    const vy = p[c * 3 + 1]! - ay;
    const vz = p[c * 3 + 2]! - az;
    const n = this.normals;
    const facing =
      (uy * vz - uz * vy) * n[a * 3]! +
      (uz * vx - ux * vz) * n[a * 3 + 1]! +
      (ux * vy - uy * vx) * n[a * 3 + 2]!;
    if (facing >= 0) this.indices.push(a, b, c);
    else this.indices.push(a, c, b);
  }

  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (this.withColors) {
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    }
    geometry.setIndex(this.indices);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** A point on the centre line with its unit tangent and distance along the lap. */
export interface Frame {
  x: number;
  z: number;
  tx: number;
  tz: number;
  s: number;
}

const px = (f: Frame, lateral: number): number => f.x - f.tz * lateral;
const pz = (f: Frame, lateral: number): number => f.z + f.tx * lateral;

export class TrackMeshBuilder {
  /** Frame i lies halfway between samples i and i + 1; cell i runs from frame i − 1 to frame i. */
  readonly frames: Frame[] = [];
  /**
   * How far from the centre line each side (0 = left, 1 = right) reaches at each frame: the
   * barrier distance, except inside corners tighter than that or where two parts of the circuit
   * run close together (there the physics has no wall either).
   */
  readonly reach: [Float32Array, Float32Array];
  /** Edge of the paved area: road plus the kerb strip, which is asphalt where there's no kerb. */
  private readonly apron: number;

  constructor(private readonly track: Track) {
    const samples = track.samples;
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const a = samples[i]!;
      const b = samples[(i + 1) % n]!;
      const tx = a.tx + b.tx;
      const tz = a.tz + b.tz;
      const len = Math.hypot(tx, tz) || 1;
      this.frames.push({
        x: (a.x + b.x) / 2,
        z: (a.z + b.z) / 2,
        tx: tx / len,
        tz: tz / len,
        s: i + 1 < n ? (a.s + b.s) / 2 : (a.s + track.length) / 2,
      });
    }
    this.apron = track.halfWidth + KERB_WIDTH;
    this.reach = [this.findReach(-1), this.findReach(1)];
  }

  /** Asphalt from kerb edge to kerb edge (kerbs lie on top); UVs in `tile`s along and across. */
  road(tile: number): THREE.BufferGeometry {
    const mb = new MeshBuilder();
    const w = this.apron;
    const n = this.frames.length;
    const edge = (f: Frame, s: number): [number, number] => [
      mb.vertex(px(f, -w), ROAD_Y, pz(f, -w), 0, 1, 0, s / tile, -w / tile),
      mb.vertex(px(f, w), ROAD_Y, pz(f, w), 0, 1, 0, s / tile, w / tile),
    ];
    // The last frame again, a lap earlier, so the texture runs on through the start line.
    const last = this.frames[n - 1]!;
    let prev = edge(last, last.s - this.track.length);
    for (const f of this.frames) {
      const next = edge(f, f.s);
      mb.quad(prev[0], prev[1], next[1], next[0]);
      prev = next;
    }
    return mb.build();
  }

  /** Red and white kerb blocks, one per cell, wherever the track flags a kerb. */
  kerbs(): THREE.BufferGeometry {
    const mb = new MeshBuilder(true);
    const red = new THREE.Color(0xb41d17);
    const white = new THREE.Color(0xeeede6);
    const inner = this.track.halfWidth;
    for (const side of [-1, 1]) {
      this.eachCell((i, a, b) => {
        const kerb = this.track.kerbs[i];
        if (!(side < 0 ? kerb?.left : kerb?.right)) return;
        this.flatQuad(mb, a, b, side * inner, side * this.apron, KERB_Y, i % 2 ? white : red);
      });
    }
    return mb.build();
  }

  /**
   * Run-off between the kerb strip and the barrier on cells where `gravel(i)` equals
   * `wantGravel`. UVs are world metres divided by `tile`, so overlapping cells inside tight
   * corners show the same texels and don't flicker.
   */
  runoff(gravel: (i: number) => boolean, wantGravel: boolean, tile: number): THREE.BufferGeometry {
    const mb = new MeshBuilder();
    const n = this.frames.length;
    for (const side of [-1, 1]) {
      const reach = this.reach[side < 0 ? 0 : 1];
      this.eachCell((i, a, b) => {
        if (gravel(i) !== wantGravel) return;
        const ra = reach[(i - 1 + n) % n]!;
        const rb = reach[i]!;
        const corners: Array<[Frame, number]> = [
          [a, side * this.apron],
          [a, side * ra],
          [b, side * rb],
          [b, side * this.apron],
        ];
        const [v0, v1, v2, v3] = corners.map(([f, l]) => {
          const x = px(f, l);
          const z = pz(f, l);
          return mb.vertex(x, RUNOFF_Y, z, 0, 1, 0, x / tile, z / tile);
        }) as [number, number, number, number];
        mb.quad(v0, v1, v2, v3);
      });
    }
    return mb.build();
  }

  /** White lines along both road edges, and the grid boxes behind the start line. */
  lines(): THREE.BufferGeometry {
    const mb = new MeshBuilder();
    const hw = this.track.halfWidth;
    for (const side of [-1, 1]) {
      const l0 = side * (hw - LINE_WIDTH);
      const l1 = side * hw;
      const edge = (f: Frame): [number, number] => [
        mb.vertex(px(f, l0), LINE_Y, pz(f, l0), 0, 1, 0),
        mb.vertex(px(f, l1), LINE_Y, pz(f, l1), 0, 1, 0),
      ];
      let prev = edge(this.frames[this.frames.length - 1]!);
      for (const f of this.frames) {
        const next = edge(f);
        mb.quad(prev[0], prev[1], next[1], next[0]);
        prev = next;
      }
    }
    // A bar across the front of each grid slot with short arms back along the car's sides.
    for (let slot = 0; slot < GRID_SLOTS; slot++) {
      const g = this.track.gridSlot(slot);
      const fx = -Math.sin(g.yaw);
      const fz = -Math.cos(g.yaw);
      const rect = (along0: number, along1: number, across0: number, across1: number) => {
        const corner = (along: number, across: number) =>
          mb.vertex(
            g.x + fx * along - fz * across,
            LINE_Y,
            g.z + fz * along + fx * across,
            0,
            1,
            0,
          );
        mb.quad(
          corner(along0, across0),
          corner(along0, across1),
          corner(along1, across1),
          corner(along1, across0),
        );
      };
      const front = GRID_AHEAD;
      rect(front, front + GRID_BAR, -GRID_HALF_WIDTH, GRID_HALF_WIDTH);
      rect(front - GRID_SIDE, front, -GRID_HALF_WIDTH, -GRID_HALF_WIDTH + GRID_BAR);
      rect(front - GRID_SIDE, front, GRID_HALF_WIDTH - GRID_BAR, GRID_HALF_WIDTH);
    }
    return mb.build();
  }

  /** The start/finish line across the road at s = 0, `depth` deep; UVs 0–1 across and along. */
  startLine(depth: number, y: number): THREE.BufferGeometry {
    const mb = new MeshBuilder();
    const p = this.track.samples[0]!;
    const f: Frame = { x: p.x, z: p.z, tx: p.tx, tz: p.tz, s: 0 };
    const w = this.track.halfWidth;
    const corner = (along: number, across: number, u: number, v: number) =>
      mb.vertex(px(f, across) + f.tx * along, y, pz(f, across) + f.tz * along, 0, 1, 0, u, v);
    mb.quad(
      corner(-depth / 2, -w, 0, 0),
      corner(-depth / 2, w, 1, 0),
      corner(depth / 2, w, 1, 1),
      corner(depth / 2, -w, 0, 1),
    );
    return mb.build();
  }

  /**
   * Walls along both sides at the barrier distance: a face towards the track, a top and a back,
   * with end caps wherever a wall stops. u counts red and white pairs of about `block` metres
   * each along the wall, v runs from the foot (0) to the top (1).
   */
  barriers(height: number, thickness: number, block: number): THREE.BufferGeometry {
    const mb = new MeshBuilder();
    const n = this.frames.length;
    const wall = this.track.wallOffset;
    for (const side of [-1, 1]) {
      const reach = this.reach[side < 0 ? 0 : 1];
      const valid = (i: number) => reach[(i + n) % n]! >= wall - 1e-3;
      const inner = side * wall;
      const outer = side * (wall + thickness);
      // Length along the face at each frame, for the stripes.
      const along = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) {
        const a = this.frames[(i - 1 + n) % n]!;
        const b = this.frames[i]!;
        const d = Math.hypot(px(b, inner) - px(a, inner), pz(b, inner) - pz(a, inner));
        along[i + 1] = along[i]! + (valid(i - 1) && valid(i) ? d : 0);
      }
      // A whole number of pairs round a closed wall, so the stripes meet up at the start line.
      const total = along[n]!;
      const pair = total / Math.max(1, Math.round(total / (2 * block)));
      this.eachCell((i, a, b) => {
        if (!valid(i - 1) || !valid(i)) return;
        const u0 = along[i]! / pair;
        const u1 = along[i + 1]! / pair;
        // Face, towards the track.
        const fa = (f: Frame, y: number, u: number) =>
          mb.vertex(px(f, inner), y, pz(f, inner), f.tz * side, 0, -f.tx * side, u, y / height);
        mb.quad(fa(a, 0, u0), fa(b, 0, u1), fa(b, height, u1), fa(a, height, u0));
        // Top, in the band's colours.
        const top = (f: Frame, l: number, u: number) =>
          mb.vertex(px(f, l), height, pz(f, l), 0, 1, 0, u, 0.9);
        mb.quad(top(a, inner, u0), top(b, inner, u1), top(b, outer, u1), top(a, outer, u0));
        // Back.
        const back = (f: Frame, y: number, u: number) =>
          mb.vertex(px(f, outer), y, pz(f, outer), -f.tz * side, 0, f.tx * side, u, y / height);
        mb.quad(back(a, 0, u0), back(a, height, u0), back(b, height, u1), back(b, 0, u1));
        // End caps where the wall stops.
        const cap = (f: Frame, dir: number, u: number) => {
          const c = (l: number, y: number, du: number) =>
            mb.vertex(px(f, l), y, pz(f, l), f.tx * dir, 0, f.tz * dir, u + du, y / height);
          const du = thickness / pair;
          mb.quad(c(inner, 0, 0), c(outer, 0, du), c(outer, height, du), c(inner, height, 0));
        };
        if (!valid(i - 2)) cap(a, -1, u0);
        if (!valid(i + 1)) cap(b, 1, u1);
      });
    }
    return mb.build();
  }

  /** Calls `fn` for each cell with its start and end frames. */
  private eachCell(fn: (i: number, a: Frame, b: Frame) => void): void {
    const n = this.frames.length;
    for (let i = 0; i < n; i++) fn(i, this.frames[(i - 1 + n) % n]!, this.frames[i]!);
  }

  /** Flat, up-facing quad over a cell between lateral offsets l0 and l1. */
  private flatQuad(
    mb: MeshBuilder,
    a: Frame,
    b: Frame,
    l0: number,
    l1: number,
    y: number,
    color?: THREE.Color,
  ): void {
    const v = (f: Frame, l: number) => mb.vertex(px(f, l), y, pz(f, l), 0, 1, 0, 0, 0, color);
    mb.quad(v(a, l0), v(a, l1), v(b, l1), v(b, l0));
  }

  /**
   * For one side, how far out each frame's run-off may reach: a point belongs to this frame as
   * long as no other part of the track is clearly closer (the physics measures walls from the
   * nearest sample, so beyond that point there's no wall to draw).
   */
  private findReach(side: number): Float32Array {
    const out = new Float32Array(this.frames.length);
    const wall = this.track.wallOffset;
    const owned = (f: Frame, l: number) =>
      Math.abs(this.track.project(px(f, side * l), pz(f, side * l)).lateral) >= l - 0.5;
    this.frames.forEach((f, i) => {
      if (owned(f, wall)) {
        out[i] = wall;
        return;
      }
      let lo = this.apron;
      let hi = wall;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (owned(f, mid)) lo = mid;
        else hi = mid;
      }
      out[i] = lo;
    });
    return out;
  }
}
