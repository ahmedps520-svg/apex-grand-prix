import { signalState } from '../../content/city/lanes';
import { SIDEWALK, type CityMap, type Junction, type Road } from '../../content/city/map';
import { mulberry32 } from '../../shared/math';
import {
  PED_CROSSING,
  PED_LEAPING,
  PED_STRIDE,
  PED_WAITING,
  PED_WALKING,
} from '../../shared/protocol';
import type { Car } from '../vehicle/car';
import type { Traffic } from './Traffic';

/**
 * Pedestrians: walkers on the pavements of the downtown grid, in a bubble around the player.
 * Each walks along a road's pavement; at a junction it turns onto the crossing road's pavement,
 * turns back, or crosses the road ahead: at a signalled junction when the traffic it crosses
 * has red (and its own side has just gone green, so there is time), elsewhere when no car is
 * near. A car bearing down on one makes it leap clear (nobody is ever run over: the leap is
 * the whole of the collision). The traffic stops for anyone in the road. Kinematic, cheap:
 * a position along a road, a side and a direction; positions go to the renderer after the
 * cars and the soft body in the snapshot.
 */

const CONTROL_HZ = 20;
const SPAWN_MIN = 40;
const SPAWN_RADIUS = 180;
const DESPAWN_RADIUS = 260;
/** Where on the pavement they walk: its middle, give or take. */
const PAVEMENT_MID = SIDEWALK / 2;
/** How far back from the crossing road's edge the kerb wait is. */
const KERB = 1.2;
/** A car this close in time along its path makes a pedestrian leap; the leap's speed and time. */
const DANGER_TIME = 1.6;
const DANGER_WIDTH = 2.4;
const LEAP_SPEED = 5.5;
const LEAP_TIME = 0.55;
/** Not signalled: cross when no moving car is this near the junction. */
const GAP_RANGE = 32;

interface RoadJunction {
  node: Junction;
  /** Along this road. */
  s: number;
  /** The road crossed there: half its width, and its axis for the signals. */
  crossRoad: Road | null;
  crossHalf: number;
  crossAxis: 0 | 1;
}

interface RoadInfo {
  road: Road;
  /** The road's start, its unit direction and its axis. */
  x0: number;
  z0: number;
  tx: number;
  tz: number;
  axis: 0 | 1;
  junctions: RoadJunction[];
}

export interface Pedestrian {
  active: boolean;
  x: number;
  y: number;
  z: number;
  yaw: number;
  state: number;
  info: RoadInfo | null;
  s: number;
  side: -1 | 1;
  dir: -1 | 1;
  pace: number;
  /** Sideways wander within the pavement. */
  wobble: number;
  /** The junction being dealt with (crossed or waited at), and where the crossing ends. */
  junction: RoadJunction | null;
  crossTo: number;
  /** A leap in progress: its direction and time left; the push it left behind, easing out. */
  leapX: number;
  leapZ: number;
  leapLeft: number;
  pushX: number;
  pushZ: number;
  /** Seconds waited at the kerb (a long wait ends with a turn instead). */
  waited: number;
}

export class Pedestrians {
  readonly list: Pedestrian[] = [];
  readonly count: number;
  /** Simulation time (the signals run from it). */
  time = 0;
  private readonly infos: RoadInfo[] = [];
  private readonly rand: () => number;
  private timer = 0;

  constructor(
    private readonly map: CityMap,
    count: number,
    seed: number,
  ) {
    this.count = count;
    this.rand = mulberry32(seed ^ 0x9ed5);
    this.build();
    for (let i = 0; i < count; i++) {
      this.list.push({
        active: false,
        x: 1e5,
        y: -100,
        z: 1e5,
        yaw: 0,
        state: PED_WALKING,
        info: null,
        s: 0,
        side: 1,
        dir: 1,
        pace: 1.3,
        wobble: 0,
        junction: null,
        crossTo: 0,
        leapX: 0,
        leapZ: 0,
        leapLeft: 0,
        pushX: 0,
        pushZ: 0,
        waited: 0,
      });
    }
  }

  /** The downtown roads (straight) and the junctions along each, with the road crossed there. */
  private build(): void {
    const roads = this.map.roads.filter((r) => r.kind === 'street' || r.kind === 'avenue');
    const infos: RoadInfo[] = roads.map((road) => {
      const p = road.points;
      const x0 = p[0]!;
      const z0 = p[1]!;
      const x1 = p[p.length - 2]!;
      const z1 = p[p.length - 1]!;
      const len = Math.hypot(x1 - x0, z1 - z0) || 1;
      const tx = (x1 - x0) / len;
      const tz = (z1 - z0) / len;
      return { road, x0, z0, tx, tz, axis: Math.abs(tx) > Math.abs(tz) ? 0 : 1, junctions: [] };
    });
    const along = (info: RoadInfo, x: number, z: number) =>
      (x - info.x0) * info.tx + (z - info.z0) * info.tz;
    const beside = (info: RoadInfo, x: number, z: number) =>
      Math.abs(-(x - info.x0) * info.tz + (z - info.z0) * info.tx);
    for (const node of this.map.junctions) {
      if (node.control === 'none') continue;
      const here = infos.filter(
        (info) =>
          beside(info, node.x, node.z) < 0.5 &&
          along(info, node.x, node.z) > -0.5 &&
          along(info, node.x, node.z) < info.road.length + 0.5,
      );
      for (const info of here) {
        const cross = here.find((o) => o !== info) ?? null;
        info.junctions.push({
          node,
          s: along(info, node.x, node.z),
          crossRoad: cross?.road ?? null,
          crossHalf: cross ? cross.road.width / 2 : 4,
          crossAxis: cross ? cross.axis : info.axis === 0 ? 1 : 0,
        });
      }
    }
    for (const info of infos) info.junctions.sort((a, b) => a.s - b.s);
    this.infos.push(...infos.filter((i) => i.junctions.length > 0));
  }

  step(dt: number, player: Car, traffic: Traffic | null): void {
    this.time += dt;
    this.timer += dt;
    const control = this.timer >= 1 / CONTROL_HZ;
    const cdt = this.timer;
    if (control) {
      this.timer = 0;
      this.respawn(player.pos.x, player.pos.z);
    }
    for (const ped of this.list) {
      if (!ped.active) continue;
      if (control) this.decide(ped, cdt, player, traffic);
      this.move(ped, dt);
    }
  }

  /** Writes every slot after the cars and the soft body: x, y, z, yaw, state. */
  writeSnapshot(out: Float32Array, base: number): void {
    for (let i = 0; i < this.list.length; i++) {
      const ped = this.list[i]!;
      const o = base + i * PED_STRIDE;
      out[o] = ped.x;
      out[o + 1] = ped.y;
      out[o + 2] = ped.z;
      out[o + 3] = ped.yaw;
      out[o + 4] = ped.active ? ped.state : -1;
    }
  }

  // ---------------------------------------------------------------- walking

  private decide(ped: Pedestrian, dt: number, player: Car, traffic: Traffic | null): void {
    // Danger first: a car coming this way, and it leaps clear.
    if (ped.state !== PED_LEAPING && this.danger(ped, player, traffic)) return;
    if (ped.state === PED_LEAPING) return;
    const info = ped.info;
    if (!info) return;
    if (ped.state === PED_CROSSING) return;
    // The junction ahead, and the kerb before it.
    const next = this.nextJunction(ped);
    if (!next) {
      // The pavement ends: turn back.
      ped.dir = ped.dir === 1 ? -1 : 1;
      ped.junction = null;
      return;
    }
    const kerb = next.s - ped.dir * (next.crossHalf + KERB);
    const atKerb = (ped.s - kerb) * ped.dir >= 0;
    if (!atKerb) {
      ped.state = PED_WALKING;
      return;
    }
    if (ped.junction !== next) {
      // Arriving: what to do here. Straight on means crossing; a turn keeps to the corner.
      ped.junction = next;
      ped.waited = 0;
      const roll = this.rand();
      if (roll < 0.36 && next.crossRoad) {
        this.turnOnto(ped, next);
        return;
      }
      if (roll < 0.46) {
        ped.dir = ped.dir === 1 ? -1 : 1;
        ped.junction = null;
        ped.state = PED_WALKING;
        return;
      }
    }
    // Waiting to cross.
    ped.s = kerb;
    ped.state = PED_WAITING;
    ped.waited += dt;
    if (this.mayCross(ped, next, player, traffic)) {
      ped.state = PED_CROSSING;
      ped.crossTo = next.s + ped.dir * (next.crossHalf + KERB);
    } else if (ped.waited > 25 && next.crossRoad) {
      // Long enough: go along the corner instead.
      this.turnOnto(ped, next);
    }
  }

  private nextJunction(ped: Pedestrian): RoadJunction | null {
    const info = ped.info!;
    if (ped.dir === 1) {
      for (const j of info.junctions) if (j.s > ped.s - 0.5) return j;
    } else {
      for (let i = info.junctions.length - 1; i >= 0; i--) {
        const j = info.junctions[i]!;
        if (j.s < ped.s + 0.5) return j;
      }
    }
    return null;
  }

  /** Round the corner onto the crossing road's pavement, away from the junction. */
  private turnOnto(ped: Pedestrian, at: RoadJunction): void {
    const info = this.infos.find((i) => i.road === at.crossRoad);
    if (!info) return;
    const x = ped.x - ped.pushX;
    const z = ped.z - ped.pushZ;
    const s = (x - info.x0) * info.tx + (z - info.z0) * info.tz;
    const lateral = -(x - info.x0) * info.tz + (z - info.z0) * info.tx;
    const here = info.junctions.find((j) => j.node === at.node);
    const sj = here ? here.s : s;
    ped.info = info;
    ped.side = lateral >= 0 ? 1 : -1;
    ped.dir = s >= sj ? 1 : -1;
    // Just clear of the corner, on the new pavement's middle.
    ped.s = sj + ped.dir * ((here?.crossHalf ?? 5) + KERB + 0.5);
    ped.junction = null;
    ped.state = PED_WALKING;
    ped.wobble = (this.rand() - 0.5) * 1.6;
  }

  private mayCross(
    ped: Pedestrian,
    at: RoadJunction,
    player: Car,
    traffic: Traffic | null,
  ): boolean {
    const node = at.node;
    if (node.control === 'signal') {
      // The traffic being crossed stopped, and its own side just gone: time to get across.
      if (signalState(node, at.crossAxis, this.time) !== 'red') return false;
      if (signalState(node, ped.info!.axis, this.time) !== 'green') return false;
    }
    // Nothing moving near the junction on the crossing road (or anywhere close).
    const near = (x: number, z: number, speed: number) =>
      speed > 1 && Math.hypot(x - node.x, z - node.z) < GAP_RANGE;
    if (near(player.pos.x, player.pos.z, Math.hypot(player.vel.x, player.vel.z))) return false;
    if (traffic) {
      for (const v of traffic.vehicles) {
        if (v.active && near(v.x, v.z, v.v)) return false;
      }
    }
    return true;
  }

  /** A car about to reach this pedestrian: it leaps aside, and true. */
  private danger(ped: Pedestrian, player: Car, traffic: Traffic | null): boolean {
    const check = (
      x: number,
      z: number,
      fx: number,
      fz: number,
      speed: number,
      halfWidth: number,
    ): boolean => {
      if (speed < 3) return false;
      const dx = ped.x - x;
      const dz = ped.z - z;
      if (Math.abs(dx) > 60 || Math.abs(dz) > 60) return false;
      const ahead = dx * fx + dz * fz;
      if (ahead < -1 || ahead > speed * DANGER_TIME + 4) return false;
      const lateral = -dx * fz + dz * fx;
      if (Math.abs(lateral) > halfWidth + DANGER_WIDTH) return false;
      // Sideways, away from the car's line (its right normal is (-fz, fx)).
      const away = lateral >= 0 ? 1 : -1;
      ped.leapX = -fz * away;
      ped.leapZ = fx * away;
      ped.leapLeft = LEAP_TIME;
      ped.state = PED_LEAPING;
      return true;
    };
    const q = player.rot;
    const pfx = -2 * (q.x * q.z + q.w * q.y);
    const pfz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const pv = Math.hypot(player.vel.x, player.vel.z);
    // The way it is actually going, not just facing (a slide counts).
    const vfx = pv > 0.5 ? player.vel.x / pv : pfx;
    const vfz = pv > 0.5 ? player.vel.z / pv : pfz;
    if (check(player.pos.x, player.pos.z, vfx, vfz, pv, player.spec.body.halfWidth)) return true;
    if (traffic) {
      for (const v of traffic.vehicles) {
        if (!v.active || v.v < 3) continue;
        if (check(v.x, v.z, -Math.sin(v.yaw), -Math.cos(v.yaw), v.v, v.halfWidth)) return true;
      }
    }
    return false;
  }

  private move(ped: Pedestrian, dt: number): void {
    const info = ped.info;
    if (!info) return;
    if (ped.state === PED_LEAPING) {
      ped.leapLeft -= dt;
      ped.pushX += ped.leapX * LEAP_SPEED * dt;
      ped.pushZ += ped.leapZ * LEAP_SPEED * dt;
      if (ped.leapLeft <= 0) {
        ped.leapLeft = 0;
        ped.state = ped.junction && ped.crossTo !== 0 ? PED_CROSSING : PED_WALKING;
        if (ped.state === PED_WALKING) ped.junction = null;
      }
    } else {
      // The push of a leap eases out as it walks on.
      const push = Math.hypot(ped.pushX, ped.pushZ);
      if (push > 0) {
        const k = Math.max(push - 1.2 * dt, 0) / push;
        ped.pushX *= k;
        ped.pushZ *= k;
      }
      if (ped.state === PED_WALKING) {
        ped.s += ped.dir * ped.pace * dt;
      } else if (ped.state === PED_CROSSING) {
        ped.s += ped.dir * ped.pace * 1.25 * dt;
        if ((ped.s - ped.crossTo) * ped.dir >= 0) {
          ped.s = ped.crossTo;
          ped.state = PED_WALKING;
          ped.junction = null;
          ped.crossTo = 0;
        }
      }
    }
    // The pose: along the road on its pavement (the crossing keeps the line across the road).
    const lateral = ped.side * (info.road.width / 2 + PAVEMENT_MID + ped.wobble);
    const nx = -info.tz;
    const nz = info.tx;
    ped.x = info.x0 + info.tx * ped.s + nx * lateral + ped.pushX;
    ped.z = info.z0 + info.tz * ped.s + nz * lateral + ped.pushZ;
    ped.y = this.map.groundHeight(ped.x, ped.z);
    const fx = ped.state === PED_LEAPING ? ped.leapX : info.tx * ped.dir;
    const fz = ped.state === PED_LEAPING ? ped.leapZ : info.tz * ped.dir;
    ped.yaw = Math.atan2(-fx, -fz);
  }

  // ---------------------------------------------------------------- spawning

  private respawn(px: number, pz: number): void {
    if (this.infos.length === 0) return;
    for (const ped of this.list) {
      const d = ped.active ? Math.hypot(ped.x - px, ped.z - pz) : Infinity;
      if (d <= DESPAWN_RADIUS) continue;
      ped.active = this.spawn(ped, px, pz);
      if (!ped.active) {
        ped.x = 1e5;
        ped.z = 1e5;
        ped.y = -100;
      }
    }
  }

  /** Somewhere on a downtown pavement between the two radii of the player, off the junctions. */
  private spawn(ped: Pedestrian, px: number, pz: number): boolean {
    for (let attempt = 0; attempt < 12; attempt++) {
      const info = this.infos[Math.floor(this.rand() * this.infos.length)]!;
      const s = this.rand() * info.road.length;
      const x = info.x0 + info.tx * s;
      const z = info.z0 + info.tz * s;
      const d = Math.hypot(x - px, z - pz);
      if (d < SPAWN_MIN || d > SPAWN_RADIUS) continue;
      if (info.junctions.some((j) => Math.abs(j.s - s) < j.crossHalf + KERB + 3)) continue;
      ped.info = info;
      ped.s = s;
      ped.side = this.rand() < 0.5 ? -1 : 1;
      ped.dir = this.rand() < 0.5 ? -1 : 1;
      ped.pace = 1.1 + this.rand() * 0.6;
      ped.wobble = (this.rand() - 0.5) * 1.6;
      ped.state = PED_WALKING;
      ped.junction = null;
      ped.crossTo = 0;
      ped.leapLeft = 0;
      ped.pushX = 0;
      ped.pushZ = 0;
      ped.waited = 0;
      ped.active = true;
      this.move(ped, 0);
      return true;
    }
    return false;
  }
}
