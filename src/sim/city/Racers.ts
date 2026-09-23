import { festivalEvents, type FestivalEvent } from '../../content/city/events';
import { laneOffsets } from '../../content/city/lanes';
import type { CityMap, Road, RoadPiece } from '../../content/city/map';
import { mulberry32 } from '../../shared/math';
import type { RoamRaceStatus } from '../../shared/protocol';
import type { Car } from '../vehicle/car';
import type { Traffic, Vehicle } from './Traffic';

/**
 * Street racers: rivals for the festival's races. When the player comes up to a race's start
 * they line up on a grid past the line; crossing the line puts the player on its own grid slot
 * (a standing start) and counts down; then they drive the race's route — kinematic like the
 * traffic, a position along the road plus a sideways offset — braking for the corners ahead,
 * taking the inside of them, moving over for traffic (or overtaking it), holding a gap to each
 * other, and rubber-banding to the player so a race stays a race. They finish with a time and
 * coast off; positions come from progress along the route.
 */

const CONTROL_HZ = 20;
/** The grid forms when the player is this close to a start line, behind it. */
const GRID_RANGE = 160;
/** The last row of the grid this far past the line (clear of a car crossing it); rows this far apart. */
const GRID_FIRST = 12;
const GRID_ROW = 7;
const COUNTDOWN = 3.5;
/** Kinematic cornering: lateral acceleration, m/s²; straight-line acceleration and braking. */
const A_LAT = 7;
const BRAKE = 8.5;
/** Distances ahead the corners are read at. */
const LOOK = [0, 15, 30, 50, 80, 120];
/** Rubber band: eased off this far ahead of the player, waiting beyond that, flat out behind. */
const BAND_EASE = 120;
const BAND_WAIT = 260;
const V_WAIT = 12;
/** Following another racer: the gap held, m, and where it moves over to pass. */
const FOLLOW_GAP = 9;
/** Finished racers coast for this long before they go. */
const COAST_TIME = 10;
/** A race is over this long after the player finishes, or after this many par times. */
const DONE_AFTER = 12;
const GIVE_UP = 4;
const DONE_TIME = 3;

interface Racer {
  car: Vehicle;
  /** Distance along the route, m. */
  s: number;
  lat: number;
  latTarget: number;
  /** Its lane of the road when nothing is in the way. */
  home: number;
  /** 0 … 1 across the field: top speed, acceleration and nerve. */
  skill: number;
  top: number;
  accel: number;
  /** Seconds since the finish (-1 while racing). */
  finished: number;
  time: number;
}

interface Route {
  event: FestivalEvent;
  road: Road;
  pieces: RoadPiece[];
  s0: number;
  length: number;
  /** The sideways band the racers use: [min, max] from the centre line, + = right. */
  bandMin: number;
  bandMax: number;
  columns: number[];
}

const point = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };

export class Racers {
  readonly status: RoamRaceStatus = {
    id: '',
    phase: 'grid',
    countdown: 0,
    time: 0,
    count: 1,
    position: 1,
    progress: 0,
    finished: -1,
    rivals: [],
  };
  /** The player is held on the grid (the countdown). */
  holding = false;
  private readonly racers: Racer[];
  private readonly events: FestivalEvent[];
  private route: Route | null = null;
  private phase: 'idle' | 'grid' | 'countdown' | 'racing' | 'done' = 'idle';
  private timer = 0;
  private countdown = 0;
  private time = 0;
  private doneFor = 0;
  private playerProgress = 0;
  private playerFinished = -1;
  private prevAlong = 0;
  private hint = 0;

  constructor(
    private readonly traffic: Traffic,
    private readonly map: CityMap,
  ) {
    const rand = mulberry32(0x5ac3);
    const cars = traffic.vehicles.filter((v) => v.racer);
    this.racers = cars.map((car, i) => ({
      car,
      s: 0,
      lat: 0,
      latTarget: 0,
      home: 0,
      skill: cars.length > 1 ? 1 - i / (cars.length - 1) : 1,
      top: 0,
      accel: 0,
      finished: -1,
      time: -1,
    }));
    for (const r of this.racers) r.skill = Math.min(Math.max(r.skill + (rand() - 0.5) * 0.2, 0), 1);
    this.events = festivalEvents(map).filter((e) => e.kind === 'race' && e.route);
  }

  /** The race status while a race is on (the grid included), else null. */
  get active(): RoamRaceStatus | null {
    return this.phase === 'idle' ? null : this.status;
  }

  /** The race under way is off (abandoned, a reset, a fast travel): everyone stands down. */
  endRace(): void {
    this.standDown();
  }

  step(dt: number, player: Car): void {
    this.timer += dt;
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0) {
        this.phase = 'racing';
        this.holding = false;
        this.time = 0;
        this.countdown = 0;
      }
    } else if (this.phase === 'racing') {
      this.time += dt;
    } else if (this.phase === 'done') {
      this.doneFor += dt;
      if (this.doneFor > DONE_TIME) this.standDown();
    }
    if (this.timer >= 1 / CONTROL_HZ) {
      const cdt = this.timer;
      this.timer = 0;
      this.control(cdt, player);
    }
    if (this.phase === 'racing' || this.phase === 'done') {
      for (const r of this.racers) this.move(r, dt);
    }
    this.report();
  }

  // ---------------------------------------------------------------- phases

  private control(dt: number, player: Car): void {
    const px = player.pos.x;
    const pz = player.pos.z;
    // The way the car points (start lines close together: the one it faces is the one).
    const q = player.rot;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    if (this.phase === 'idle') {
      this.arm(px, pz, fx, fz);
      return;
    }
    const route = this.route;
    if (!route) return;
    const e = route.event;
    const along = (px - e.x) * e.tx + (pz - e.z) * e.tz;
    const across = -(px - e.x) * e.tz + (pz - e.z) * e.tx;
    if (this.phase === 'grid') {
      // Gone away again, or turned away from the line: the grid breaks up. Crossed the line:
      // on the grid and counting.
      const d = Math.hypot(px - e.x, pz - e.z);
      const facing = fx * e.tx + fz * e.tz;
      if (d > GRID_RANGE + 40 || along < -GRID_RANGE || (facing < -0.5 && d > 20)) {
        this.standDown();
        return;
      }
      // Forwards over the line (the position's progress says so, whatever a bump did to the
      // velocity this instant).
      const crossed =
        this.prevAlong < 0 &&
        along >= 0 &&
        along < 30 &&
        Math.abs(across) <= e.halfWidth + 2 &&
        Math.abs(player.pos.y - e.y) < 4;
      this.prevAlong = along;
      if (crossed) this.lineUp(player);
      return;
    }
    if (this.phase === 'countdown') return;
    // Racing: the player's progress, the rivals' driving, the finish and the end.
    this.playerProgress = this.progressOf(px, pz);
    const speed = Math.hypot(player.vel.x, player.vel.z);
    if (this.playerFinished < 0 && this.playerProgress >= route.length) {
      this.playerFinished = this.time;
    }
    for (const r of this.racers) if (r.car.active) this.decide(r, route, speed);
    if (this.phase === 'racing') {
      const allIn = this.racers.every((r) => r.finished >= 0);
      const over =
        (this.playerFinished >= 0 && (allIn || this.time - this.playerFinished > DONE_AFTER)) ||
        this.time > e.par * GIVE_UP;
      if (over) {
        this.phase = 'done';
        this.doneFor = 0;
      }
    }
    for (const r of this.racers) {
      if (r.finished >= 0) {
        r.finished += dt;
        if (r.finished > COAST_TIME) r.car.active = false;
      }
    }
  }

  /** A start line close ahead of the player, the way it faces: the rivals line up on its grid. */
  private arm(px: number, pz: number, fx: number, fz: number): void {
    let best: FestivalEvent | null = null;
    let bestD = Infinity;
    for (const e of this.events) {
      const along = (px - e.x) * e.tx + (pz - e.z) * e.tz;
      const across = -(px - e.x) * e.tz + (pz - e.z) * e.tx;
      if (along > -8 || along < -GRID_RANGE || Math.abs(across) > 60) continue;
      if (fx * e.tx + fz * e.tz < 0.3) continue;
      if (-along < bestD) {
        bestD = -along;
        best = e;
      }
    }
    if (!best) return;
    const route = this.routeFor(best);
    if (!route) return;
    this.route = route;
    this.phase = 'grid';
    this.prevAlong = -bestD;
    this.playerProgress = 0;
    this.playerFinished = -1;
    const n = this.racers.length;
    const columns = route.columns.length;
    const rows = Math.ceil((n + 1) / columns);
    this.racers.forEach((r, i) => {
      const row = Math.floor(i / columns);
      r.s = GRID_FIRST + (rows - 1 - row) * GRID_ROW;
      r.home = route.columns[i % columns]!;
      r.lat = r.home;
      r.latTarget = r.home;
      r.finished = -1;
      r.time = -1;
      r.top = route.event.length / route.event.par;
      r.top *= 1.15 + 0.25 * r.skill;
      r.accel = 4 + 1.5 * r.skill;
      const car = r.car;
      car.active = true;
      car.mode = 'race';
      car.v = 0;
      car.a = 0;
      car.brake = 1;
      car.hazards = 0;
      car.shoveX = 0;
      car.shoveZ = 0;
      car.dentFront = 0;
      car.dentRear = 0;
      car.indicator = 0;
      this.pose(r, route, 0, 0);
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevZ = car.z;
      car.prevYaw = car.yaw;
    });
  }

  /** The player crossed the line: onto its grid slot, held, and the countdown starts. */
  private lineUp(player: Car): void {
    const route = this.route!;
    const n = this.racers.length;
    const columns = route.columns.length;
    const lat = route.columns[n % columns]!;
    this.at(route, route.s0 + GRID_FIRST);
    const nx = -point.tz;
    const nz = point.tx;
    player.teleport({
      x: point.x + nx * lat,
      z: point.z + nz * lat,
      yaw: Math.atan2(-point.tx, -point.tz),
      y: point.y + 0.5,
    });
    this.phase = 'countdown';
    this.countdown = COUNTDOWN;
    this.holding = true;
    this.time = 0;
    this.playerProgress = GRID_FIRST;
  }

  private standDown(): void {
    for (const r of this.racers) {
      const car = r.car;
      car.active = false;
      car.v = 0;
      car.a = 0;
      car.brake = 0;
      // Out of the world until the next grid.
      car.x = car.prevX = 1e5;
      car.z = car.prevZ = 1e5;
      car.y = car.prevY = -100;
      r.finished = -1;
    }
    this.phase = 'idle';
    this.route = null;
    this.holding = false;
    this.countdown = 0;
    this.time = 0;
    this.playerFinished = -1;
  }

  // ---------------------------------------------------------------- driving

  private decide(r: Racer, route: Route, playerSpeed: number): void {
    const car = r.car;
    if (r.finished >= 0) {
      // Coasting in after the flag.
      car.a = car.v > 8 ? -3 : 0;
      car.brake = car.v > 8 ? 0.4 : 0;
      r.latTarget = r.home;
      return;
    }
    // The corners ahead: the speed each allows, and what that allows now.
    let target = r.top;
    for (const d of LOOK) {
      const k = Math.abs(this.curvature(route, r.s + d));
      if (k < 1e-4) continue;
      const vc = Math.sqrt(A_LAT / k) * (0.9 + 0.15 * r.skill);
      target = Math.min(target, Math.sqrt(vc * vc + 2 * BRAKE * d));
    }
    // The rubber band: eased off well ahead of the player, waiting far ahead, flat out behind.
    const gap = r.s - this.playerProgress;
    if (gap > BAND_WAIT) target = Math.min(target, Math.max(playerSpeed + 2, V_WAIT));
    else if (gap > BAND_EASE) target *= 0.85;
    else if (gap < -BAND_EASE) target *= 1.12;
    // The line: inside of the corner coming up, otherwise its own lane.
    const k = this.curvature(route, r.s + 25);
    r.latTarget = Math.abs(k) > 1 / 150 ? (k > 0 ? route.bandMax - 1 : route.bandMin + 1) : r.home;
    // Another racer close ahead in the same line: hold a gap and move over to pass.
    for (const o of this.racers) {
      if (o === r || !o.car.active) continue;
      const ahead = o.s - r.s;
      if (ahead <= 0 || ahead > 40 || Math.abs(o.lat - r.latTarget) > 2.2) continue;
      const room = ahead - FOLLOW_GAP;
      if (room < 0 || car.v > o.car.v) {
        const other = o.lat > (route.bandMin + route.bandMax) / 2 ? o.lat - 3 : o.lat + 3;
        r.latTarget = Math.min(Math.max(other, route.bandMin + 0.8), route.bandMax - 0.8);
        if (Math.abs(r.latTarget - o.lat) < 2.2 || room < 2) {
          target = Math.min(target, Math.max(o.car.v + Math.min(room, 0) * 0.5, 0));
        }
      }
    }
    // Traffic ahead in the band: around it, or over into the oncoming lane when that is clear.
    this.avoidTraffic(r, route, (v) => (target = Math.min(target, v)));
    // Throttle or brake towards the target.
    if (car.v < target) {
      car.a = Math.min(r.accel, (target - car.v) / 0.5);
      car.brake = 0;
    } else {
      car.a = Math.max(-BRAKE, (target - car.v) / 0.4);
      car.brake = car.a < -1 ? Math.min(-car.a / BRAKE, 1) : 0;
    }
    car.indicator = 0;
  }

  private avoidTraffic(r: Racer, route: Route, slow: (v: number) => void): void {
    const car = r.car;
    const fx = -Math.sin(car.yaw);
    const fz = -Math.cos(car.yaw);
    const nx = -fz;
    const nz = fx;
    let blockedBy: Vehicle | null = null;
    let blockAt = Infinity;
    let oncoming = false;
    for (const o of this.traffic.vehicles) {
      if (!o.active || o.mode === 'race') continue;
      const dx = o.x - car.x;
      const dz = o.z - car.z;
      if (Math.abs(dx) > 100 || Math.abs(dz) > 100 || Math.abs(o.y - car.y) > 3) continue;
      const ahead = dx * fx + dz * fz;
      const side = dx * nx + dz * nz;
      const lat = r.lat + side;
      if (ahead < -6 || ahead > 90) continue;
      if (lat < route.bandMin - 0.5) {
        // In the oncoming lane (or beyond it): only matters for an overtake there.
        if (ahead > 0 && lat > route.bandMin - 4.5) oncoming = true;
        continue;
      }
      if (Math.abs(lat - r.latTarget) > 2.4 && Math.abs(lat - r.lat) > 2.4) continue;
      if (ahead < blockAt) {
        blockAt = ahead;
        blockedBy = o;
      }
    }
    if (!blockedBy) return;
    const width = route.bandMax - route.bandMin;
    const side = r.lat + ((blockedBy.x - car.x) * nx + (blockedBy.z - car.z) * nz);
    if (width >= 4.4) {
      // Room in the band: the other side of it.
      r.latTarget =
        side > (route.bandMin + route.bandMax) / 2 ? route.bandMin + 1 : route.bandMax - 1;
    } else if (!route.road.oneWay && !oncoming && blockAt < 60) {
      // A single lane: over into the oncoming lane while it is clear.
      r.latTarget = route.bandMin - 2.6;
    }
    // Until it is past: no faster than the car ahead, and stopped short of it.
    const room = blockAt - FOLLOW_GAP;
    if (Math.abs(side - r.lat) < 2.4 && room < 30) {
      slow(Math.max(blockedBy.v + Math.min(room, 0) * 0.5, room < 4 ? 0 : 6));
    }
  }

  /** One step of motion along the route and sideways towards the target lane. */
  private move(r: Racer, dt: number): void {
    const route = this.route;
    const car = r.car;
    if (!route || !car.active) return;
    car.v = Math.max(car.v + car.a * dt, 0);
    r.s += car.v * dt;
    if (r.finished < 0 && r.s >= route.length) {
      r.finished = 0;
      r.time = this.time;
    }
    // Sideways: a lane change takes about a second at speed.
    const rate = Math.max(1.5, car.v * 0.09);
    const want = r.latTarget - r.lat;
    const step = Math.max(-rate * dt, Math.min(rate * dt, want));
    r.lat += step;
    this.pose(r, route, dt > 0 ? step / dt : 0, dt);
  }

  private pose(r: Racer, route: Route, latRate: number, dt: number): void {
    const car = r.car;
    this.at(route, route.s0 + r.s);
    const nx = -point.tz;
    const nz = point.tx;
    car.x = point.x + nx * r.lat + car.shoveX;
    car.z = point.z + nz * r.lat + car.shoveZ;
    car.y = point.y + car.spec.cogHeight;
    // Heading: along the road, turned by the sideways motion.
    const v = Math.max(car.v, 3);
    const dx = point.tx + (nx * latRate) / v;
    const dz = point.tz + (nz * latRate) / v;
    const yaw = Math.atan2(-dx, -dz);
    let turn = yaw - car.yaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const yawRate = dt > 0 ? turn / dt : 0;
    const wanted = Math.max(-1, Math.min(1, (yawRate * 2.6) / v));
    car.steer += (wanted - car.steer) * Math.min(dt * 12, 1);
    car.yaw = yaw;
    car.heading = yaw;
    car.spin += (car.v * dt) / car.spec.front.wheelRadius;
  }

  // ---------------------------------------------------------------- the route

  private routeFor(e: FestivalEvent): Route | null {
    const route = e.route;
    if (!route) return null;
    const road = route.road;
    const pieces = this.map.pieces.filter((p) => p.road === road);
    if (pieces.length === 0) return null;
    const half = road.width / 2;
    let bandMin: number;
    let bandMax: number;
    if (road.kind === 'circuit' || road.oneWay) {
      bandMin = -half + 1.6;
      bandMax = half - 1.6;
    } else {
      const offsets = laneOffsets(road.kind, road.lanes);
      const lanes = offsets.length > 0 ? offsets : [half / 2];
      bandMin = Math.min(...lanes) - 1.2;
      bandMax = Math.min(Math.max(...lanes) + 1.2, half - 0.8);
    }
    const width = bandMax - bandMin;
    const columns = width >= 4.4 ? [bandMin + 1.1, bandMax - 1.1] : [(bandMin + bandMax) / 2];
    return {
      event: e,
      road,
      pieces,
      s0: route.s0,
      length: route.s1 - route.s0,
      bandMin,
      bandMax,
      columns,
    };
  }

  /** The route's point at a distance along the road (wrapping on a loop), into `point`. */
  private at(route: Route, s: number): void {
    const road = route.road;
    const L = road.length;
    const u = road.loop ? ((s % L) + L) % L : Math.min(Math.max(s, 0), L);
    const pieces = route.pieces;
    let i = Math.min(Math.max(this.hint, 0), pieces.length - 1);
    // The pieces run in order along the road: walk from the last one used.
    while (i > 0 && u < pieces[i]!.s0) i--;
    while (i < pieces.length - 1 && u > pieces[i]!.s0 + pieces[i]!.len) i++;
    this.hint = i;
    const p = pieces[i]!;
    const t = p.len > 0 ? Math.min(Math.max((u - p.s0) / p.len, 0), 1) : 0;
    point.x = p.ax + p.tx * p.len * t;
    point.z = p.az + p.tz * p.len * t;
    point.y = p.ay + (p.by - p.ay) * t;
    point.tx = p.tx;
    point.tz = p.tz;
  }

  /** Signed curvature of the route at a distance along it (+ = a right-hand bend), 1/m. */
  private curvature(route: Route, s: number): number {
    const h = 6;
    this.at(route, route.s0 + s - h);
    const ax = point.tx;
    const az = point.tz;
    this.at(route, route.s0 + s + h);
    const cross = ax * point.tz - az * point.tx;
    const dot = ax * point.tx + az * point.tz;
    return Math.atan2(cross, dot) / (2 * h);
  }

  /** The player's distance along the route, m (unwrapped on a loop). */
  private progressOf(px: number, pz: number): number {
    const route = this.route;
    if (!route) return 0;
    const p = this.map.alongRoad(route.road, px, pz);
    if (!p) return this.playerProgress;
    const L = route.road.length;
    let s = p.s - route.s0;
    if (route.road.loop) {
      s = ((s % L) + L) % L;
      // The representative nearest the last progress (behind the line reads as negative).
      const prev = this.playerProgress;
      while (s - prev > L / 2) s -= L;
      while (prev - s > L / 2) s += L;
    }
    return s;
  }

  private report(): void {
    const st = this.status;
    const route = this.route;
    if (this.phase === 'idle' || !route) {
      st.id = '';
      st.phase = 'grid';
      st.rivals.length = 0;
      st.count = 1;
      st.position = 1;
      st.progress = 0;
      st.finished = -1;
      st.time = 0;
      st.countdown = 0;
      return;
    }
    st.id = route.event.id;
    st.phase = this.phase;
    st.countdown = this.countdown;
    st.time = this.time;
    st.count = this.racers.length + 1;
    st.progress = this.playerProgress;
    st.finished = this.playerFinished;
    let position = 1;
    for (let i = 0; i < this.racers.length; i++) {
      const r = this.racers[i]!;
      const rival = st.rivals[i] ?? { slot: r.car.slot, progress: 0, time: -1 };
      rival.slot = r.car.slot;
      rival.progress = r.s;
      rival.time = r.time;
      st.rivals[i] = rival;
      // Level (the grid) counts as ahead: the player starts from the back.
      const aheadOfMe =
        this.playerFinished >= 0
          ? r.time >= 0 && r.time < this.playerFinished
          : r.time >= 0 || r.s >= this.playerProgress;
      if (aheadOfMe) position++;
    }
    st.rivals.length = this.racers.length;
    st.position = position;
  }
}
