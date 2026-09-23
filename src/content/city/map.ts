import { mulberry32 } from '../../shared/math';
import type { RoamStart } from '../../shared/protocol';
import { trackById } from '../tracks';
import {
  MAP_MAX_X,
  MAP_MAX_Z,
  MAP_MIN_X,
  MAP_MIN_Z,
  districtAt,
  smooth01,
  terrainHeight,
} from './terrain';

/**
 * The open world's map, generated from a seed: a downtown grid of avenues and streets, an
 * elevated orbital highway with climbing on/off ramps at four interchanges, suburbs to the
 * west, an industrial port to the east with the sea beyond the quay, a mountain road winding up
 * the ridge to the north and the club circuit embedded to the south. Pure code (no three.js)
 * shared by the simulation worker and the renderer, so both build the same map.
 *
 * Roads are centre-line polylines with a surface height at each point; the map keeps them in a
 * grid of cells so the physics can find the nearest road under a wheel quickly.
 */

export type RoadKind =
  'street' | 'avenue' | 'highway' | 'ramp' | 'mountain' | 'circuit' | 'access' | 'port' | 'suburb';

export type { RoamStart };

export interface Road {
  id: number;
  kind: RoadKind;
  name: string;
  /** Centre line, flat [x0, z0, x1, z1, …]; closed when `loop`. */
  points: number[];
  /** Surface height at each point, metres. */
  heights: number[];
  width: number;
  /** Lanes per direction. */
  lanes: number;
  oneWay: boolean;
  loop: boolean;
  /** km/h, 0 = none. */
  speedLimit: number;
  /** On a deck above the ground (the highway and its ramps). */
  elevated: boolean;
  length: number;
}

/** One straight piece of a road's centre line. */
export interface RoadPiece {
  road: Road;
  ax: number;
  az: number;
  ay: number;
  bx: number;
  bz: number;
  by: number;
  /** Unit direction a → b. */
  tx: number;
  tz: number;
  len: number;
  /** Distance along the road at a. */
  s0: number;
  halfWidth: number;
}

export type JunctionControl = 'signal' | 'stop' | 'yield' | 'none';
export interface Junction {
  x: number;
  z: number;
  control: JunctionControl;
}

export type LotStyle = 'tower' | 'block' | 'shop' | 'house' | 'warehouse' | 'container' | 'crane';
/** A building or a large prop: a box footprint w × d (x, z before `yaw`), `height` tall. */
export interface Lot {
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  yaw: number;
  height: number;
  style: LotStyle;
  /** For colours and window patterns. */
  seed: number;
}

export interface RoadProjection {
  piece: RoadPiece;
  /** 0 … 1 along the piece. */
  t: number;
  /** Distance along the road. */
  s: number;
  /** Signed sideways offset, + = right of the road's direction. */
  lateral: number;
  /** Distance to the centre line (to its nearest end beyond the piece). */
  dist: number;
  /** Road surface height there. */
  height: number;
}

export interface Spawn {
  x: number;
  z: number;
  yaw: number;
  y?: number;
}

/** Chunk size for streaming and lot lookup, metres. */
export const CHUNK = 250;
/** The orbital's deck above the ground. */
export const DECK_HEIGHT = 7.5;
/** Pavement beside city streets, metres. */
export const SIDEWALK = 3.5;
/** The orbital's centre line: a rounded rectangle. */
export const RING_HALF = 600;
export const RING_CORNER = 200;
const CELL = 50;
const RESAMPLE = 10;

export const speedLimitFor: Record<RoadKind, number> = {
  street: 40,
  avenue: 60,
  highway: 110,
  ramp: 60,
  mountain: 60,
  circuit: 0,
  access: 50,
  port: 50,
  suburb: 40,
};

/** Heading (yaw, radians; 0 = facing −z) for a direction. */
export const yawFor = (tx: number, tz: number): number => Math.atan2(-tx, -tz);

interface RoadSpec {
  kind: RoadKind;
  name: string;
  points: number[];
  heights?: number[];
  width: number;
  lanes: number;
  oneWay?: boolean;
  loop?: boolean;
  elevated?: boolean;
  speedLimit?: number;
}

export class CityMap {
  readonly roads: Road[] = [];
  readonly pieces: RoadPiece[] = [];
  readonly junctions: Junction[] = [];
  readonly lots: Lot[] = [];
  readonly spawns: Record<RoamStart, Spawn>;
  /** The mountain road's last point: a paved lookout. */
  readonly lookout: { x: number; z: number; y: number; radius: number };
  private readonly cells = new Map<number, RoadPiece[]>();
  private readonly lotChunks = new Map<number, Lot[]>();

  constructor(readonly seed = 7) {
    const rand = mulberry32(seed);
    this.buildDowntown();
    this.buildOrbital();
    this.buildSuburbs();
    this.buildPort();
    this.lookout = this.buildMountainRoad();
    const circuitStart = this.buildCircuit();
    this.buildLots(rand);
    this.spawns = {
      downtown: { x: 5.4, z: 380, yaw: 0 },
      // The inner (clockwise) carriageway of the north side, heading east.
      highway: { x: -100, z: -RING_HALF + 6.65, yaw: yawFor(1, 0), y: DECK_HEIGHT },
      suburbs: { x: -830, z: -2.2, yaw: yawFor(-1, 0) },
      port: { x: 830, z: 5.4, yaw: yawFor(1, 0) },
      mountain: { x: 2.2, z: -740, yaw: 0 },
      circuit: circuitStart,
    };
  }

  // ---------------------------------------------------------------- queries

  /**
   * The nearest road to a point. `level` picks ground roads (false), decks (true) or either
   * (undefined); `kinds` narrows the search. Null when none is within `maxDist`.
   */
  project(
    x: number,
    z: number,
    options: { level?: boolean; kinds?: ReadonlyArray<RoadKind>; maxDist?: number } = {},
  ): RoadProjection | null {
    const maxDist = options.maxDist ?? 40;
    let best: RoadProjection | null = null;
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    const reach = Math.ceil(maxDist / CELL);
    for (let cx = ix - reach; cx <= ix + reach; cx++) {
      for (let cz = iz - reach; cz <= iz + reach; cz++) {
        const list = this.cells.get(cellKey(cx, cz));
        if (!list) continue;
        for (const piece of list) {
          if (options.level !== undefined && piece.road.elevated !== options.level) continue;
          if (options.kinds && !options.kinds.includes(piece.road.kind)) continue;
          const p = projectOnPiece(piece, x, z);
          if (p.dist > maxDist || (best && p.dist >= best.dist)) continue;
          best = p;
        }
      }
    }
    return best;
  }

  /** The deck (highway or ramp) over a point, when the point is within its paved width. */
  deckAt(x: number, z: number, margin = 0): RoadProjection | null {
    const p = this.project(x, z, { level: true, maxDist: 12 + margin });
    return p && p.dist <= p.piece.halfWidth + margin ? p : null;
  }

  /**
   * Ground height with the roads cut into the land: the mountain road's corridor is levelled to
   * the road and blends back into the hillside beside it.
   */
  groundHeight(x: number, z: number): number {
    const natural = terrainHeight(x, z);
    if (z > -650) return natural;
    const p = this.project(x, z, { kinds: ['mountain'], maxDist: 50 });
    if (!p) return natural;
    const flat = p.piece.halfWidth + 4;
    if (p.dist <= flat) return p.height;
    return p.height + (natural - p.height) * smooth01((p.dist - flat) / 25);
  }

  /** Paved ground (roads with their pavements, the port's yards, the lookout). */
  paved(x: number, z: number): boolean {
    if (districtAt(x, z) === 'port' && x >= 790) return true;
    const look = this.lookout;
    if ((x - look.x) ** 2 + (z - look.z) ** 2 < look.radius ** 2) return true;
    const p = this.project(x, z, { level: false, maxDist: 24 });
    if (!p) return false;
    const road = p.piece.road;
    const walk = road.kind === 'street' || road.kind === 'avenue' ? SIDEWALK : 1.5;
    return p.dist <= p.piece.halfWidth + walk;
  }

  /** Speed limit of the road under a point (km/h; 0 when none or off road). */
  speedLimitAt(x: number, z: number, y = 0): number {
    const p = this.project(x, z, { level: y > 3 ? true : false, maxDist: 20 });
    return p && p.dist <= p.piece.halfWidth + 2 ? p.piece.road.speedLimit : 0;
  }

  lotsInChunk(cx: number, cz: number): readonly Lot[] {
    return this.lotChunks.get(cellKey(cx, cz)) ?? [];
  }

  /** Lots whose footprint could reach a point (for contacts). */
  lotsNear(x: number, z: number): readonly Lot[] {
    return this.lotsInChunk(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
  }

  // ---------------------------------------------------------------- building

  private addRoad(spec: RoadSpec): Road {
    const points = spec.points;
    const n = points.length / 2;
    const heights = spec.heights ?? new Array<number>(n).fill(0);
    const road: Road = {
      id: this.roads.length,
      kind: spec.kind,
      name: spec.name,
      points,
      heights,
      width: spec.width,
      lanes: spec.lanes,
      oneWay: spec.oneWay ?? false,
      loop: spec.loop ?? false,
      speedLimit: spec.speedLimit ?? speedLimitFor[spec.kind],
      elevated: spec.elevated ?? false,
      length: 0,
    };
    const count = road.loop ? n : n - 1;
    let s = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % n;
      const ax = points[i * 2]!;
      const az = points[i * 2 + 1]!;
      const bx = points[j * 2]!;
      const bz = points[j * 2 + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const piece: RoadPiece = {
        road,
        ax,
        az,
        ay: heights[i]!,
        bx,
        bz,
        by: heights[j]!,
        tx: (bx - ax) / len,
        tz: (bz - az) / len,
        len,
        s0: s,
        halfWidth: road.width / 2,
      };
      s += len;
      this.pieces.push(piece);
      this.index(piece);
    }
    road.length = s;
    this.roads.push(road);
    return road;
  }

  private index(piece: RoadPiece): void {
    const pad = piece.halfWidth + SIDEWALK + 4;
    const x0 = Math.floor((Math.min(piece.ax, piece.bx) - pad) / CELL);
    const x1 = Math.floor((Math.max(piece.ax, piece.bx) + pad) / CELL);
    const z0 = Math.floor((Math.min(piece.az, piece.bz) - pad) / CELL);
    const z1 = Math.floor((Math.max(piece.az, piece.bz) + pad) / CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cellKey(cx, cz);
        let list = this.cells.get(key);
        if (!list) this.cells.set(key, (list = []));
        list.push(piece);
      }
    }
  }

  private addLot(lot: Lot): void {
    this.lots.push(lot);
    const reach = Math.hypot(lot.w, lot.d) / 2 + 2;
    const x0 = Math.floor((lot.x - reach) / CHUNK);
    const x1 = Math.floor((lot.x + reach) / CHUNK);
    const z0 = Math.floor((lot.z - reach) / CHUNK);
    const z1 = Math.floor((lot.z + reach) / CHUNK);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = cellKey(cx, cz);
        let list = this.lotChunks.get(key);
        if (!list) this.lotChunks.set(key, (list = []));
        list.push(lot);
      }
    }
  }

  /** Avenues every 200 m and streets between them; the central pair run out to the districts. */
  private buildDowntown(): void {
    const names = [
      'Kestrel',
      'Harbour',
      'Meridian',
      'Larkspur',
      'Vantage',
      'Corvid',
      'Ashby',
      'Tallow',
      'Quill',
    ];
    for (let i = 0; i <= 8; i++) {
      const c = -400 + i * 100;
      const avenue = i % 2 === 0;
      const kind: RoadKind = avenue ? 'avenue' : 'street';
      const width = avenue ? 18 : 11;
      const lanes = avenue ? 2 : 1;
      // North–south.
      const z0 = c === 0 ? -720 : -400;
      const z1 = c === 0 ? 780 : 400;
      this.addRoad({
        kind,
        name: `${names[i]} ${avenue ? 'Avenue' : 'Street'}`,
        points: straight(c, z0, c, z1),
        width,
        lanes,
      });
      // East–west.
      const x0 = c === 0 ? -1550 : -400;
      const x1 = c === 0 ? 1400 : 400;
      this.addRoad({
        kind,
        name: `${names[(i + 4) % names.length]} ${avenue ? 'Boulevard' : 'Row'}`,
        points: straight(x0, c, x1, c),
        width,
        lanes,
      });
    }
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const avenues = (i % 2 === 0 ? 1 : 0) + (j % 2 === 0 ? 1 : 0);
        this.junctions.push({
          x: -400 + i * 100,
          z: -400 + j * 100,
          control: avenues === 2 ? 'signal' : avenues === 1 ? 'stop' : 'yield',
        });
      }
    }
    // Where the central avenue becomes the mountain road, and the circuit's access road.
    this.junctions.push({ x: 0, z: -720, control: 'none' }, { x: 0, z: 780, control: 'none' });
  }

  /** The elevated orbital: a clockwise rounded rectangle, with a diamond interchange per side. */
  private buildOrbital(): void {
    const points: number[] = [];
    const heights: number[] = [];
    const h = RING_HALF;
    const r = RING_CORNER;
    const straightSteps = 24;
    const arcSteps = 10;
    const push = (x: number, z: number) => {
      points.push(x, z);
      heights.push(DECK_HEIGHT);
    };
    const arc = (cx: number, cz: number, from: number) => {
      for (let k = 1; k <= arcSteps; k++) {
        const a = from + ((Math.PI / 2) * k) / arcSteps;
        push(cx + r * Math.cos(a), cz + r * Math.sin(a));
      }
    };
    const side = (x0: number, z0: number, x1: number, z1: number) => {
      for (let k = 0; k < straightSteps; k++) {
        const t = k / straightSteps;
        push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
      }
    };
    const s = h - r;
    side(-s, -h, s, -h);
    arc(s, -s, -Math.PI / 2);
    side(h, -s, h, s);
    arc(s, s, 0);
    side(s, h, -s, h);
    arc(-s, s, Math.PI / 2);
    side(-h, s, -h, -s);
    arc(-s, -s, Math.PI);
    this.addRoad({
      kind: 'highway',
      name: 'Orbital',
      points,
      heights,
      width: 22,
      lanes: 2,
      loop: true,
      elevated: true,
    });

    // Interchanges: (u along the clockwise deck, n outward). Each ramp leaves or joins its
    // carriageway and meets the crossing avenue at a T-junction 60 m out from the deck's
    // centre line.
    const frames: Array<{
      ox: number;
      oz: number;
      ux: number;
      uz: number;
      nx: number;
      nz: number;
    }> = [
      { ox: 0, oz: -h, ux: 1, uz: 0, nx: 0, nz: -1 },
      { ox: h, oz: 0, ux: 0, uz: 1, nx: 1, nz: 0 },
      { ox: 0, oz: h, ux: -1, uz: 0, nx: 0, nz: 1 },
      { ox: -h, oz: 0, ux: 0, uz: -1, nx: -1, nz: 0 },
    ];
    const rampHeight = (u: number) => DECK_HEIGHT * smooth01((Math.abs(u) - 40) / 200);
    const profile: Array<[number, number]> = [
      [270, 7],
      [200, 19],
      [80, 27],
      [20, 50],
      [0, 60],
    ];
    for (const f of frames) {
      const ramp = (uSign: number, nSign: number, fromDeck: boolean, name: string) => {
        const pts: number[] = [];
        const hs: number[] = [];
        const order = fromDeck ? profile : [...profile].reverse();
        for (const [u, n] of order) {
          pts.push(
            f.ox + f.ux * u * uSign + f.nx * n * nSign,
            f.oz + f.uz * u * uSign + f.nz * n * nSign,
          );
          hs.push(rampHeight(u));
        }
        this.addRoad({
          kind: 'ramp',
          name,
          points: pts,
          heights: hs,
          width: 7,
          lanes: 1,
          oneWay: true,
          elevated: true,
        });
        this.junctions.push({
          x: f.ox + f.nx * 60 * nSign,
          z: f.oz + f.nz * 60 * nSign,
          control: 'yield',
        });
      };
      // Right-hand traffic keeps to the inside of a clockwise ring: the inner carriageway runs
      // clockwise (+u) with its off-ramp before the crossing and its on-ramp after it; the
      // outer carriageway runs anticlockwise (−u).
      ramp(-1, -1, true, 'Orbital exit');
      ramp(1, -1, false, 'Orbital entry');
      ramp(1, 1, true, 'Orbital exit');
      ramp(-1, 1, false, 'Orbital entry');
    }
  }

  private buildSuburbs(): void {
    const names = ['Maple', 'Alder', 'Rowan', 'Hazel', 'Linden', 'Willow', 'Birch', 'Elm', 'Cedar'];
    for (let i = 0; i <= 5; i++) {
      const x = -800 - i * 150;
      this.addRoad({
        kind: 'suburb',
        name: `${names[i]} Drive`,
        points: straight(x, -600, x, 600),
        width: 9,
        lanes: 1,
      });
    }
    for (let j = 0; j <= 8; j++) {
      const z = -600 + j * 150;
      if (z === 0) continue; // the boulevard runs through
      this.addRoad({
        kind: 'suburb',
        name: `${names[j]} Close`,
        points: straight(-1550, z, -800, z),
        width: 9,
        lanes: 1,
      });
    }
    for (let i = 0; i <= 5; i++) {
      for (let j = 0; j <= 8; j++) {
        this.junctions.push({ x: -800 - i * 150, z: -600 + j * 150, control: 'yield' });
      }
    }
  }

  private buildPort(): void {
    for (const z of [-250, 250]) {
      this.addRoad({
        kind: 'port',
        name: 'Dock Road',
        points: straight(800, z, 1400, z),
        width: 12,
        lanes: 1,
      });
    }
    for (const x of [800, 1100, 1400]) {
      this.addRoad({
        kind: 'port',
        name: 'Quay Street',
        points: straight(x, -500, x, 500),
        width: 12,
        lanes: 1,
      });
    }
    for (const x of [800, 1100, 1400]) {
      for (const z of [-250, 0, 250]) this.junctions.push({ x, z, control: 'stop' });
    }
  }

  /** Switchbacks up the ridge, the height profile smoothed and its grade capped. */
  private buildMountainRoad(): { x: number; z: number; y: number; radius: number } {
    const raw: number[] = [];
    const steps = 400;
    for (let k = 0; k <= steps; k++) {
      const p = k / steps;
      const sway = smooth01(p * 4) * smooth01((1 - p) * 3);
      raw.push(250 * Math.sin(p * Math.PI * 2 * 2.2) * sway, -720 - 1750 * p);
    }
    const points = resample(raw, RESAMPLE);
    const n = points.length / 2;
    const heights: number[] = [];
    for (let i = 0; i < n; i++) heights.push(terrainHeight(points[i * 2]!, points[i * 2 + 1]!));
    // Smooth over ±80 m, then cap the grade at 10 % both ways.
    const smoothed = heights.map((_, i) => {
      let sum = 0;
      let count = 0;
      for (let k = -8; k <= 8; k++) {
        const j = Math.min(Math.max(i + k, 0), n - 1);
        sum += heights[j]!;
        count++;
      }
      return sum / count;
    });
    for (let i = 1; i < n; i++) {
      smoothed[i] = Math.min(smoothed[i]!, smoothed[i - 1]! + RESAMPLE * 0.1);
    }
    for (let i = n - 2; i >= 0; i--) {
      smoothed[i] = Math.min(smoothed[i]!, smoothed[i + 1]! + RESAMPLE * 0.1);
    }
    smoothed[0] = 0;
    this.addRoad({
      kind: 'mountain',
      name: 'Ridge Road',
      points,
      heights: smoothed,
      width: 8,
      lanes: 1,
    });
    return {
      x: points[(n - 1) * 2]!,
      z: points[(n - 1) * 2 + 1]!,
      y: smoothed[n - 1]!,
      radius: 26,
    };
  }

  /** The club circuit south of the city, joined to the avenue by an access road. */
  private buildCircuit(): Spawn {
    const def = trackById('merriford-park');
    const src = def?.points ?? [
      [0, 0],
      [200, 0],
      [200, 300],
      [0, 300],
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [x, z] of src) {
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z);
      maxZ = Math.max(maxZ, z);
    }
    const dx = 100 - (minX + maxX) / 2;
    const dz = 1230 - (minZ + maxZ) / 2;
    const raw: number[] = [];
    for (const [x, z] of src) raw.push(x + dx, z + dz);
    raw.push(src[0]![0] + dx, src[0]![1] + dz);
    const points = resample(raw, RESAMPLE);
    points.length -= 2; // the loop closes itself
    this.addRoad({
      kind: 'circuit',
      name: def?.name ?? 'Circuit',
      points,
      width: def?.width ?? 12,
      lanes: 1,
      loop: true,
    });
    // Access: from the avenue's end to the nearest point of the loop.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length / 2; i++) {
      const d = (points[i * 2]! - 0) ** 2 + (points[i * 2 + 1]! - 800) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const jx = points[best * 2]!;
    const jz = points[best * 2 + 1]!;
    this.addRoad({
      kind: 'access',
      name: 'Paddock Lane',
      points: [0, 780, 0, 800, jx, jz],
      width: 9,
      lanes: 1,
    });
    this.junctions.push({ x: jx, z: jz, control: 'yield' });
    const n = points.length / 2;
    const tx = points[2]! - points[0]!;
    const tz = points[3]! - points[1]!;
    const len = Math.hypot(tx, tz) || 1;
    void n;
    return { x: points[0]!, z: points[1]!, yaw: yawFor(tx / len, tz / len) };
  }

  private buildLots(rand: () => number): void {
    // Downtown: 2 × 2 lots per block; towers in the core, lower blocks and shops outside it.
    for (let bx = 0; bx < 8; bx++) {
      for (let bz = 0; bz < 8; bz++) {
        const cx = -350 + bx * 100;
        const cz = -350 + bz * 100;
        const core = smooth01(1 - Math.hypot(cx, cz) / 520);
        for (const [lx, lz] of [
          [-19, -19],
          [19, -19],
          [-19, 19],
          [19, 19],
        ] as const) {
          if (rand() < 0.12) continue; // a plaza
          const w = 24 + rand() * 10;
          const d = 24 + rand() * 10;
          const height = 12 + rand() * 30 + core * (30 + Math.pow(rand(), 0.8) * 150);
          const style: LotStyle = height > 50 ? 'tower' : rand() < 0.3 ? 'shop' : 'block';
          this.addLot({
            x: cx + lx,
            z: cz + lz,
            y: 0,
            w,
            d,
            yaw: 0,
            height: style === 'shop' ? Math.min(height, 14) : height,
            style,
            seed: Math.floor(rand() * 1e9),
          });
        }
      }
    }
    // Suburbs: houses along every block edge, facing the road.
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 8; j++) {
        const cx = -875 - i * 150;
        const cz = -525 + j * 150;
        for (const [ex, ez, yaw] of [
          [0, -1, 0],
          [0, 1, Math.PI],
          [-1, 0, -Math.PI / 2],
          [1, 0, Math.PI / 2],
        ] as const) {
          for (const along of [-56, -19, 19, 56]) {
            if (rand() < 0.15) continue;
            const inset = 4.5 + 12 + rand() * 4;
            const x = cx + ex * (75 - inset) + -ez * along;
            const z = cz + ez * (75 - inset) + ex * along;
            this.addLot({
              x,
              z,
              y: 0,
              w: 10 + rand() * 3,
              d: 8 + rand() * 2,
              yaw,
              height: 5 + rand() * 3,
              style: 'house',
              seed: Math.floor(rand() * 1e9),
            });
          }
        }
      }
    }
    // Port: warehouses in the western blocks, container stacks and cranes by the quay.
    for (const cx of [950, 1250]) {
      for (const cz of [-375, -125, 125, 375]) {
        if (cx === 950) {
          for (const off of [-60, 60]) {
            this.addLot({
              x: cx + off,
              z: cz,
              y: 0,
              w: 70,
              d: 36 + rand() * 20,
              yaw: 0,
              height: 10 + rand() * 4,
              style: 'warehouse',
              seed: Math.floor(rand() * 1e9),
            });
          }
        } else {
          for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 8; col++) {
              if (rand() < 0.25) continue;
              const stack = rand() < 0.4 ? 2 : 1;
              for (let level = 0; level < stack; level++) {
                this.addLot({
                  x: cx - 60 + col * 16,
                  z: cz - 60 + row * 40 + (rand() - 0.5) * 2,
                  y: level * 2.6,
                  w: 12.2,
                  d: 2.5,
                  yaw: 0,
                  height: 2.6,
                  style: 'container',
                  seed: Math.floor(rand() * 1e9),
                });
              }
            }
          }
        }
      }
    }
    for (const z of [-360, -120, 120, 360]) {
      this.addLot({ x: 1428, z, y: 0, w: 14, d: 22, yaw: 0, height: 34, style: 'crane', seed: 1 });
    }
  }
}

// ---------------------------------------------------------------- helpers

export function cellKey(ix: number, iz: number): number {
  return (ix + 4096) * 16384 + (iz + 4096);
}

function straight(x0: number, z0: number, x1: number, z1: number): number[] {
  return resample([x0, z0, x1, z1], 25);
}

/** Evenly spaced points along a polyline (the last point is kept). */
export function resample(points: number[], spacing: number): number[] {
  const out: number[] = [points[0]!, points[1]!];
  let carry = 0;
  for (let i = 0; i < points.length / 2 - 1; i++) {
    const ax = points[i * 2]!;
    const az = points[i * 2 + 1]!;
    const bx = points[i * 2 + 2]!;
    const bz = points[i * 2 + 3]!;
    const len = Math.hypot(bx - ax, bz - az);
    let d = spacing - carry;
    while (d <= len) {
      out.push(ax + ((bx - ax) * d) / len, az + ((bz - az) * d) / len);
      d += spacing;
    }
    carry = len - (d - spacing);
  }
  const lx = points[points.length - 2]!;
  const lz = points[points.length - 1]!;
  if (Math.hypot(out[out.length - 2]! - lx, out[out.length - 1]! - lz) > spacing * 0.3) {
    out.push(lx, lz);
  } else {
    out[out.length - 2] = lx;
    out[out.length - 1] = lz;
  }
  return out;
}

export function projectOnPiece(piece: RoadPiece, x: number, z: number): RoadProjection {
  const rx = x - piece.ax;
  const rz = z - piece.az;
  const along = rx * piece.tx + rz * piece.tz;
  const t = along <= 0 ? 0 : along >= piece.len ? 1 : along / piece.len;
  const px = piece.ax + piece.tx * piece.len * t;
  const pz = piece.az + piece.tz * piece.len * t;
  const lateral = (x - px) * -piece.tz + (z - pz) * piece.tx;
  const dist = t > 0 && t < 1 ? Math.abs(lateral) : Math.hypot(x - px, z - pz);
  return {
    piece,
    t,
    s: piece.s0 + piece.len * t,
    lateral,
    dist,
    height: piece.ay + (piece.by - piece.ay) * t,
  };
}

/** Whether a point on the ground lies inside a lot's footprint. */
export function insideLot(lot: Lot, x: number, z: number): boolean {
  const c = Math.cos(lot.yaw);
  const s = Math.sin(lot.yaw);
  const rx = x - lot.x;
  const rz = z - lot.z;
  const lx = rx * c - rz * s;
  const lz = rx * s + rz * c;
  return Math.abs(lx) < lot.w / 2 && Math.abs(lz) < lot.d / 2;
}

/** Inside the map (with a margin the soft boundary wall uses). */
export function insideMap(x: number, z: number, margin = 0): boolean {
  return (
    x > MAP_MIN_X + margin &&
    x < MAP_MAX_X - margin &&
    z > MAP_MIN_Z + margin &&
    z < MAP_MAX_Z - margin
  );
}

let shared: CityMap | null = null;
/** The one map everyone shares (built on first use, a few milliseconds). */
export function cityMap(): CityMap {
  if (!shared) shared = new CityMap();
  return shared;
}
