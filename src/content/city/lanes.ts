import { type CityMap, type JunctionControl, type Road, type RoadKind } from './map';

/**
 * The lane graph traffic drives on: each road becomes one directed lane polyline per lane and
 * direction (right-hand traffic), cut at the junctions it passes through; turn connectors join
 * the lanes across each junction; on- and off-ramps join the orbital's outer lanes at merge
 * nodes. Each link knows the control at its end (signal, stop, yield), so a driver can obey it.
 * Pure code, shared by the simulation worker (which drives the traffic) and the renderer
 * (which shows the signals), from the same map.
 */

export interface LaneLink {
  id: number;
  road: Road | null;
  /** A lane along a road, or a connector across a junction. */
  kind: 'lane' | 'turn';
  /** Flat [x0, z0, x1, z1, …] and the surface height at each point. */
  points: number[];
  heights: number[];
  /** Cumulative distance at each point; the last is the length. */
  cum: number[];
  length: number;
  /** km/h. */
  speedLimit: number;
  /** Node at the start and end (-1 when the lane starts or ends in the open). */
  from: number;
  to: number;
  /** Links a car can take at the end. */
  next: LaneLink[];
  /** What the driver faces at the end. */
  control: JunctionControl;
  /** For signals: the approach axis, 0 along x, 1 along z. */
  axis: 0 | 1;
  /** Connectors: -1 left, 0 straight, 1 right. */
  turn: -1 | 0 | 1;
  elevated: boolean;
  /** 0 = the rightmost lane. */
  lane: number;
}

export interface LaneNode {
  id: number;
  x: number;
  z: number;
  control: JunctionControl;
  ins: LaneLink[];
  outs: LaneLink[];
  /** Merge nodes (ramps joining the orbital) have no crossing traffic. */
  merge: boolean;
}

/** Where a car is on a link. */
export interface LanePoint {
  x: number;
  z: number;
  y: number;
  tx: number;
  tz: number;
}

/** Signal timing: green, then amber, then all red, per axis in turn. */
export const SIGNAL_GREEN = 11;
export const SIGNAL_AMBER = 3;
export const SIGNAL_RED_GAP = 1.5;
export const SIGNAL_CYCLE = 2 * (SIGNAL_GREEN + SIGNAL_AMBER + SIGNAL_RED_GAP);

export type SignalState = 'green' | 'amber' | 'red';

/** The signal a node shows to an approach along `axis` at `time` (seconds). */
export function signalState(
  node: { x: number; z: number },
  axis: 0 | 1,
  time: number,
): SignalState {
  // Each junction starts its cycle at its own offset, so the city doesn't blink in step.
  const offset = (Math.abs(node.x * 0.37 + node.z * 0.53) * 7.31) % SIGNAL_CYCLE;
  let t = (time + offset) % SIGNAL_CYCLE;
  if (t < 0) t += SIGNAL_CYCLE;
  const half = SIGNAL_CYCLE / 2;
  const phase = t < half ? 0 : 1;
  if (phase !== axis) return 'red';
  const u = t - phase * half;
  return u < SIGNAL_GREEN ? 'green' : u < SIGNAL_GREEN + SIGNAL_AMBER ? 'amber' : 'red';
}

/** Lane centre offsets from the road's centre line, rightmost first, by road kind. */
export function laneOffsets(kind: RoadKind, lanes: number): number[] {
  switch (kind) {
    case 'avenue':
      return [5.4, 1.8].slice(0, lanes);
    case 'highway':
      return [6.65, 2.9].slice(0, lanes);
    case 'ramp':
      return [0];
    case 'street':
      return [2.75];
    case 'suburb':
    case 'access':
      return [2.25];
    case 'port':
      return [3];
    case 'mountain':
      return [2];
    case 'circuit':
      return [];
  }
}

/** Speed through a connector, km/h. */
const TURN_SPEED = { left: 28, straight: 0, right: 22 } as const;
const CELL = 100;

interface Cut {
  s: number;
  gap: number;
  node: number;
  /** A ramp's merge cut applies to one carriageway only: the lanes driving this way. */
  dirSide?: 1 | -1;
}

export class LaneGraph {
  readonly links: LaneLink[] = [];
  readonly nodes: LaneNode[] = [];
  private readonly cells = new Map<number, LaneLink[]>();

  constructor(readonly map: CityMap) {
    const nodeAt = new Map<string, number>();
    const nodeFor = (x: number, z: number, control: JunctionControl, merge = false): number => {
      const key = `${Math.round(x)},${Math.round(z)}`;
      const found = nodeAt.get(key);
      if (found !== undefined) return found;
      const id = this.nodes.length;
      this.nodes.push({ id, x, z, control, ins: [], outs: [], merge });
      nodeAt.set(key, id);
      return id;
    };
    for (const j of map.junctions) nodeFor(j.x, j.z, j.control);

    // Each road's lanes, cut where the junctions on it are.
    for (const road of map.roads) {
      if (road.kind === 'circuit') continue;
      const cuts = this.cutsFor(road, nodeFor);
      const offsets = laneOffsets(road.kind, road.lanes);
      const directions: Array<1 | -1> = road.oneWay ? [1] : [1, -1];
      for (const dir of directions) {
        offsets.forEach((offset, lane) => {
          this.buildLane(road, dir, lane, offset, cuts);
        });
      }
    }
    this.connect();
    for (const link of this.links) this.index(link);
  }

  /** The point `s` metres along a link. */
  pointAt(link: LaneLink, s: number, out: LanePoint): LanePoint {
    const cum = link.cum;
    const n = cum.length;
    let i = 1;
    while (i < n - 1 && cum[i]! < s) i++;
    const s0 = cum[i - 1]!;
    const s1 = cum[i]!;
    const t = s1 > s0 ? Math.min(Math.max((s - s0) / (s1 - s0), 0), 1) : 0;
    const ax = link.points[(i - 1) * 2]!;
    const az = link.points[(i - 1) * 2 + 1]!;
    const bx = link.points[i * 2]!;
    const bz = link.points[i * 2 + 1]!;
    const len = Math.hypot(bx - ax, bz - az) || 1;
    out.x = ax + (bx - ax) * t;
    out.z = az + (bz - az) * t;
    out.y = link.heights[i - 1]! + (link.heights[i]! - link.heights[i - 1]!) * t;
    out.tx = (bx - ax) / len;
    out.tz = (bz - az) / len;
    return out;
  }

  /** Links whose midpoint lies within `radius` of a point (for spawning). */
  linksNear(x: number, z: number, radius: number): LaneLink[] {
    const out: LaneLink[] = [];
    const reach = Math.ceil(radius / CELL);
    const ix = Math.floor(x / CELL);
    const iz = Math.floor(z / CELL);
    for (let cx = ix - reach; cx <= ix + reach; cx++) {
      for (let cz = iz - reach; cz <= iz + reach; cz++) {
        const list = this.cells.get((cx + 4096) * 16384 + (cz + 4096));
        if (!list) continue;
        for (const link of list) {
          const mid = link.points.length / 4;
          const mx = link.points[Math.floor(mid) * 2]!;
          const mz = link.points[Math.floor(mid) * 2 + 1]!;
          if (Math.hypot(mx - x, mz - z) <= radius) out.push(link);
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- building

  /** The junctions along a road, as cuts of its centre-line distance, widest crossing first. */
  private cutsFor(
    road: Road,
    nodeFor: (x: number, z: number, c: JunctionControl) => number,
  ): Cut[] {
    const cuts: Cut[] = [];
    const map = this.map;
    for (const j of map.junctions) {
      const p = this.projectRoad(road, j.x, j.z);
      if (!p || p.dist > 2) continue;
      // The junction box: half the widest crossing road, plus a margin.
      let cross = 0;
      for (const other of map.roads) {
        if (other === road || other.kind === 'circuit') continue;
        const q = this.projectRoad(other, j.x, j.z);
        if (q && q.dist <= 2) cross = Math.max(cross, other.width / 2);
      }
      cuts.push({ s: p.s, gap: cross + 3, node: nodeFor(j.x, j.z, j.control) });
    }
    // Ramps: their deck ends join the orbital's outer lane at merge nodes.
    if (road.kind === 'highway') {
      for (const ramp of map.roads) {
        if (ramp.kind !== 'ramp') continue;
        const n = ramp.points.length / 2;
        const first = ramp.heights[0]! >= ramp.heights[n - 1]!;
        const i = first ? 0 : n - 1;
        const x = ramp.points[i * 2]!;
        const z = ramp.points[i * 2 + 1]!;
        const p = this.projectRoad(road, x, z);
        if (!p || p.dist > 12) continue;
        // Right of the ring's (clockwise) direction is the inside: the forward carriageway.
        const side = map.project(x, z, { kinds: ['highway'], maxDist: 12 });
        const dirSide: 1 | -1 = side && side.lateral > 0 ? 1 : -1;
        cuts.push({ s: p.s, gap: 0, node: nodeFor(x, z, 'none'), dirSide });
        this.nodes[this.nodes.length - 1]!.merge = true;
      }
    }
    if (road.kind === 'ramp') {
      // The ramp's own deck end is a node too (the same one the orbital was cut at).
      const n = road.points.length / 2;
      const first = road.heights[0]! >= road.heights[n - 1]!;
      const i = first ? 0 : n - 1;
      const s = first ? 0 : road.length;
      cuts.push({ s, gap: 0, node: nodeFor(road.points[i * 2]!, road.points[i * 2 + 1]!, 'none') });
    }
    return cuts.sort((a, b) => a.s - b.s);
  }

  /** Distance along a road and to its centre line for a point. */
  private projectRoad(road: Road, x: number, z: number): { s: number; dist: number } | null {
    let best: { s: number; dist: number } | null = null;
    const n = road.points.length / 2;
    const count = road.loop ? n : n - 1;
    let s = 0;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % n;
      const ax = road.points[i * 2]!;
      const az = road.points[i * 2 + 1]!;
      const bx = road.points[j * 2]!;
      const bz = road.points[j * 2 + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const t = Math.min(
        Math.max(((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (len * len), 0),
        1,
      );
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      const dist = Math.hypot(x - px, z - pz);
      if (!best || dist < best.dist) best = { s: s + len * t, dist };
      s += len;
    }
    return best;
  }

  /** One lane of a road in one direction, offset from the centre line, split at the cuts. */
  private buildLane(road: Road, dir: 1 | -1, lane: number, offset: number, cuts: Cut[]): void {
    const n = road.points.length / 2;
    const count = road.loop ? n + 1 : n;
    // Offset points with their distance along the centre line.
    const pts: Array<{ x: number; z: number; y: number; s: number }> = [];
    let s = 0;
    for (let k = 0; k < count; k++) {
      const i = k % n;
      const prev = road.loop ? (i - 1 + n) % n : Math.max(i - 1, 0);
      const next = road.loop ? (i + 1) % n : Math.min(i + 1, n - 1);
      let tx = road.points[next * 2]! - road.points[prev * 2]!;
      let tz = road.points[next * 2 + 1]! - road.points[prev * 2 + 1]!;
      const len = Math.hypot(tx, tz) || 1;
      tx /= len;
      tz /= len;
      if (k > 0) {
        const pi = (k - 1) % n;
        s += Math.hypot(
          road.points[i * 2]! - road.points[pi * 2]!,
          road.points[i * 2 + 1]! - road.points[pi * 2 + 1]!,
        );
      }
      // Right of the driving direction is (-tz, tx); the far side for the other direction.
      pts.push({
        x: road.points[i * 2]! + -tz * offset * dir,
        z: road.points[i * 2 + 1]! + tx * offset * dir,
        y: road.heights[i]!,
        s,
      });
    }
    // Cut into pieces between junction boxes; for loops the pieces wrap around.
    const bounds: Array<{ from: number; to: number; fromNode: number; toNode: number }> = [];
    const applicable = cuts.filter((c) => c.dirSide === undefined || c.dirSide === dir);
    if (applicable.length === 0) {
      bounds.push({ from: 0, to: road.length, fromNode: -1, toNode: -1 });
    } else {
      const ordered = applicable;
      if (!road.loop) {
        let start = 0;
        let startNode = -1;
        for (const c of ordered) {
          const end = c.s - c.gap;
          if (end > start + 1)
            bounds.push({ from: start, to: end, fromNode: startNode, toNode: c.node });
          start = c.s + c.gap;
          startNode = c.node;
        }
        if (road.length > start + 1) {
          bounds.push({ from: start, to: road.length, fromNode: startNode, toNode: -1 });
        }
      } else {
        for (let i = 0; i < ordered.length; i++) {
          const a = ordered[i]!;
          const b = ordered[(i + 1) % ordered.length]!;
          const from = a.s + a.gap;
          let to = b.s - b.gap;
          if (to <= from) to += road.length;
          bounds.push({ from, to, fromNode: a.node, toNode: b.node });
        }
      }
    }
    for (const b of bounds) {
      const forward = dir === 1;
      const link = this.linkFrom(pts, b.from, b.to, road, forward);
      link.lane = lane;
      link.from = forward ? b.fromNode : b.toNode;
      link.to = forward ? b.toNode : b.fromNode;
      const endNode = link.to >= 0 ? this.nodes[link.to]! : null;
      link.control = endNode ? this.approachControl(road, endNode) : 'none';
      link.axis =
        Math.abs(link.points[link.points.length - 2]! - link.points[link.points.length - 4]!) >
        Math.abs(link.points[link.points.length - 1]! - link.points[link.points.length - 3]!)
          ? 0
          : 1;
      this.links.push(link);
      if (link.from >= 0) this.nodes[link.from]!.outs.push(link);
      if (link.to >= 0) this.nodes[link.to]!.ins.push(link);
    }
  }

  /** The polyline of a lane between two centre-line distances, in the driving direction. */
  private linkFrom(
    pts: ReadonlyArray<{ x: number; z: number; y: number; s: number }>,
    from: number,
    to: number,
    road: Road,
    forward: boolean,
  ): LaneLink {
    const total = road.length;
    const at = (s: number) => {
      const u = road.loop ? ((s % total) + total) % total : Math.min(Math.max(s, 0), total);
      let i = 1;
      while (i < pts.length - 1 && pts[i]!.s < u) i++;
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const t = b.s > a.s ? (u - a.s) / (b.s - a.s) : 0;
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, y: a.y + (b.y - a.y) * t };
    };
    const points: number[] = [];
    const heights: number[] = [];
    const push = (s: number) => {
      const p = at(s);
      points.push(p.x, p.z);
      heights.push(p.y);
    };
    push(from);
    for (const p of pts) {
      const s = p.s;
      const inside = road.loop
        ? (s > from && s < to) || (s + total > from && s + total < to)
        : s > from && s < to;
      if (inside) push(road.loop && s < from ? s + total : s);
    }
    push(to);
    if (!forward) {
      const rp: number[] = [];
      const rh: number[] = [];
      for (let i = points.length / 2 - 1; i >= 0; i--) {
        rp.push(points[i * 2]!, points[i * 2 + 1]!);
        rh.push(heights[i]!);
      }
      points.length = 0;
      heights.length = 0;
      points.push(...rp);
      heights.push(...rh);
    }
    return this.makeLink(points, heights, road, 'lane', road.speedLimit, 0);
  }

  private makeLink(
    points: number[],
    heights: number[],
    road: Road | null,
    kind: 'lane' | 'turn',
    speedLimit: number,
    turn: -1 | 0 | 1,
  ): LaneLink {
    const cum = [0];
    for (let i = 1; i < points.length / 2; i++) {
      cum.push(
        cum[i - 1]! +
          Math.hypot(points[i * 2]! - points[i * 2 - 2]!, points[i * 2 + 1]! - points[i * 2 - 1]!),
      );
    }
    return {
      id: this.links.length,
      road,
      kind,
      points,
      heights,
      cum,
      length: cum[cum.length - 1]!,
      speedLimit,
      from: -1,
      to: -1,
      next: [],
      control: 'none',
      axis: 0,
      turn,
      elevated: road?.elevated ?? false,
      lane: 0,
    };
  }

  /** What a road's traffic faces at a junction: the minor road stops or yields, signals for all. */
  private approachControl(road: Road, node: LaneNode): JunctionControl {
    if (node.merge) return 'none';
    if (node.control === 'signal') return 'signal';
    if (node.control === 'none') return 'none';
    // Is this the major road? The one with the higher class doesn't stop.
    const rank = (r: Road) =>
      r.kind === 'avenue' ? 3 : r.kind === 'port' || r.kind === 'street' ? 2 : 1;
    let major = rank(road);
    for (const other of this.map.roads) {
      if (other === road || other.kind === 'circuit') continue;
      const p = this.projectRoad(other, node.x, node.z);
      if (p && p.dist <= 2) major = Math.max(major, rank(other));
    }
    return rank(road) >= major ? 'none' : node.control;
  }

  /** Turn connectors across every node, and each link's successors. */
  private connect(): void {
    for (const node of this.nodes) {
      const outs = [...node.outs];
      for (const link of node.ins) {
        const n = link.points.length / 2;
        const ix = link.points[n * 2 - 2]! - link.points[n * 2 - 4]!;
        const iz = link.points[n * 2 - 1]! - link.points[n * 2 - 3]!;
        const ilen = Math.hypot(ix, iz) || 1;
        const dx = ix / ilen;
        const dz = iz / ilen;
        const inner = (l: LaneLink) =>
          l.road ? laneOffsets(l.road.kind, l.road.lanes).length - 1 : 0;
        const attempt = (strict: boolean, uTurns = false) => {
          for (const out of outs) {
            if (out.road === link.road && out.lane === link.lane && node.merge) {
              if (!link.next.includes(out)) link.next.push(out);
              continue;
            }
            const ox = out.points[2]! - out.points[0]!;
            const oz = out.points[3]! - out.points[1]!;
            const olen = Math.hypot(ox, oz) || 1;
            const ex = ox / olen;
            const ez = oz / olen;
            const dot = dx * ex + dz * ez;
            const cross = dx * ez - dz * ex;
            if (dot < -0.6 && !uTurns) continue; // no U-turns, except at a dead end
            const turn: -1 | 0 | 1 = Math.abs(cross) < 0.35 && dot > 0.6 ? 0 : cross > 0 ? 1 : -1;
            if (strict) {
              // Straight on stays in the lane; right turns go from and to the rightmost lane;
              // left turns from and to the innermost.
              if (turn === 0 && out.lane !== link.lane) continue;
              if (turn === 1 && (link.lane !== 0 || out.lane !== 0)) continue;
              if (turn === -1 && (link.lane !== inner(link) || out.lane !== inner(out))) continue;
            } else if (turn === 0 && out.road === link.road) {
              continue; // straight on in another lane is a lane change, not a turn
            }
            // At a merge node the only moves are along the carriageway and on or off a ramp.
            if (
              node.merge &&
              out.road !== link.road &&
              link.road?.kind !== 'ramp' &&
              out.road?.kind !== 'ramp'
            ) {
              continue;
            }
            const connector = this.connector(link, out, dx, dz, ex, ez, turn);
            connector.from = node.id;
            connector.to = node.id;
            link.next.push(connector);
            connector.next.push(out);
            this.links.push(connector);
          }
        };
        attempt(true);
        // A lane with nowhere to go (a corner with a single turn) may make it from any lane;
        // at a dead end it turns around.
        if (link.next.length === 0) attempt(false);
        if (link.next.length === 0) attempt(false, true);
      }
    }
  }

  /** A curve from the end of one lane to the start of another across a junction. */
  private connector(
    a: LaneLink,
    b: LaneLink,
    dx: number,
    dz: number,
    ex: number,
    ez: number,
    turn: -1 | 0 | 1,
  ): LaneLink {
    const na = a.points.length / 2;
    const ax = a.points[na * 2 - 2]!;
    const az = a.points[na * 2 - 1]!;
    const bx = b.points[0]!;
    const bz = b.points[1]!;
    // Control point: where the two headings meet (the corner), or the midpoint when parallel.
    const denom = dx * ez - dz * ex;
    let cx = (ax + bx) / 2;
    let cz = (az + bz) / 2;
    if (Math.abs(denom) > 0.2) {
      const t = ((bx - ax) * ez - (bz - az) * ex) / denom;
      if (t > 0 && t < 80) {
        cx = ax + dx * t;
        cz = az + dz * t;
      }
    }
    const points: number[] = [];
    const heights: number[] = [];
    const ya = a.heights[na - 1]!;
    const yb = b.heights[0]!;
    const steps = 8;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      points.push(
        u * u * ax + 2 * u * t * cx + t * t * bx,
        u * u * az + 2 * u * t * cz + t * t * bz,
      );
      heights.push(ya + (yb - ya) * t);
    }
    const limit =
      turn === 0
        ? Math.min(a.speedLimit || 60, b.speedLimit || 60)
        : turn === 1
          ? TURN_SPEED.right
          : TURN_SPEED.left;
    const link = this.makeLink(points, heights, null, 'turn', limit, turn);
    link.elevated = a.elevated || b.elevated;
    link.lane = b.lane;
    return link;
  }

  private index(link: LaneLink): void {
    const mid = Math.floor(link.points.length / 4);
    const x = link.points[mid * 2]!;
    const z = link.points[mid * 2 + 1]!;
    const key = (Math.floor(x / CELL) + 4096) * 16384 + (Math.floor(z / CELL) + 4096);
    let list = this.cells.get(key);
    if (!list) this.cells.set(key, (list = []));
    list.push(link);
  }
}

let shared: LaneGraph | null = null;
/** The lane graph of the shared map (built on first use). */
export function laneGraph(map: CityMap): LaneGraph {
  if (!shared || shared.map !== map) shared = new LaneGraph(map);
  return shared;
}
