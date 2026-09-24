import { policeModel, racerModel, trafficModel } from '../../content/city/fleet';
import {
  laneGraph,
  signalState,
  type LaneGraph,
  type LaneLink,
  type LanePoint,
} from '../../content/city/lanes';
import type { CityMap } from '../../content/city/map';
import { mulberry32, quatFromYaw, type Quat, type Vec3 } from '../../shared/math';
import {
  C,
  CAR_STRIDE,
  FLAG_HAZARDS,
  FLAG_HEADLIGHTS,
  FLAG_INDICATOR_LEFT,
  FLAG_INDICATOR_RIGHT,
  FLAG_SIREN,
  PED_CROSSING,
  W,
  WHEEL_COUNT,
  WHEEL_STRIDE,
} from '../../shared/protocol';
import type { Car } from '../vehicle/car';
import type { CarSpec } from '../vehicle/spec';
import type { Pedestrians } from './Pedestrians';

/**
 * Traffic: everyday cars driving the lane graph around the player. They are kinematic (a
 * position along a lane and a speed, no tyre model), so a full field costs little: they follow
 * the car ahead (an intelligent-driver model), obey the signals, stop signs and give-way
 * rules, pick turns at random, indicate before turning, show brake lights, and put their
 * hazards on after a crash. Cars that fall out of the bubble around the player respawn on a
 * lane inside it. The player collides with them as oriented boxes: the player's car takes the
 * impulse, the traffic car is shoved and stops.
 */

const CONTROL_HZ = 50;
/** Bubble around the player: spawn inside the inner radius, respawn beyond the outer one. */
const SPAWN_RADIUS = 380;
const DESPAWN_RADIUS = 540;
const SPAWN_CLEAR = 60;
/** IDM parameters: comfortable acceleration and braking, headway, standstill gap. */
const ACCEL = 1.7;
const BRAKE = 2.6;
const HEADWAY = 1.3;
const STANDSTILL = 2.6;
const HARD_BRAKE = 4.5;
/** Seconds a car waits at a stop line, and shows its hazards after a crash. */
const STOP_WAIT = 0.9;
const HAZARD_TIME = 12;
/** A siren this close: slow to this (m/s) and ease this far over to the right. */
const SIREN_RANGE = 70;
const PULL_OVER_SPEED = 2;
const PULL_OVER_OFFSET = 1.7;

export type VehicleMode = 'lane' | 'free' | 'block' | 'race';

export interface Vehicle {
  slot: number;
  spec: CarSpec;
  active: boolean;
  /** A police car (the police module drives its modes and targets). */
  police: boolean;
  /** A street racer (the racers module drives it along a race's route). */
  racer: boolean;
  /** On the lanes, driving freely at a target (pursuits), parked as a block, or racing. */
  mode: VehicleMode;
  /** Pursuit: follow the lanes towards the target instead of picking turns at random. */
  chase: boolean;
  siren: boolean;
  heading: number;
  targetX: number;
  targetZ: number;
  targetSpeed: number;
  link: LaneLink;
  s: number;
  v: number;
  a: number;
  next: LaneLink | null;
  x: number;
  y: number;
  z: number;
  yaw: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  prevYaw: number;
  steer: number;
  spin: number;
  brake: number;
  indicator: -1 | 0 | 1;
  hazards: number;
  /** Pulled over for a siren, 0 … 1 (its sideways offset and its brake). */
  pullOver: number;
  /** Seconds stood at a stop line. */
  waited: number;
  /** Sideways shove after a crash, decaying. */
  shoveX: number;
  shoveZ: number;
  /** The simple damage: how dented each end is, 0 … 1. */
  dentFront: number;
  dentRear: number;
  /** This driver's speed relative to the limit and following gap. */
  pace: number;
  halfWidth: number;
  front: number;
  rear: number;
}

const point: LanePoint = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
const kmh = (v: number): number => v / 3.6;

export class Traffic {
  readonly vehicles: Vehicle[] = [];
  readonly graph: LaneGraph;
  /** The pedestrians, when there are any: anyone in the road ahead stops the traffic. */
  pedestrians: Pedestrians | null = null;
  private readonly rand: () => number;
  private controlTimer = 0;
  private time = 0;
  private readonly playerBox = { x: 0, z: 0, fx: 0, fz: 1, halfWidth: 1, front: 2, rear: 2 };

  /** Slots in the snapshot: the traffic, then the police, then the racers. */
  readonly count: number;
  /** Times the player has hit a car (the police count it as an offence when they see it). */
  playerHits = 0;

  constructor(
    readonly map: CityMap,
    trafficCount: number,
    policeCount: number,
    seed: number,
    /** Headlights on (dusk and night; the world's clock switches it). */
    public lightsOn: boolean,
    racerCount = 0,
  ) {
    this.graph = laneGraph(map);
    this.rand = mulberry32(seed ^ 0x7a11c);
    this.count = trafficCount + policeCount + racerCount;
    for (let slot = 0; slot < this.count; slot++) {
      const police = slot >= trafficCount && slot < trafficCount + policeCount;
      const racer = slot >= trafficCount + policeCount;
      const model = racer
        ? racerModel(slot - trafficCount - policeCount)
        : police
          ? policeModel()
          : trafficModel(slot);
      const spec = model.spec;
      this.vehicles.push({
        slot,
        spec,
        active: false,
        police,
        racer,
        mode: racer ? 'race' : 'lane',
        chase: false,
        siren: false,
        heading: 0,
        targetX: 0,
        targetZ: 0,
        targetSpeed: 0,
        link: this.graph.links[0]!,
        s: 0,
        v: 0,
        a: 0,
        next: null,
        x: 1e5,
        y: -100,
        z: 1e5,
        yaw: 0,
        prevX: 1e5,
        prevY: -100,
        prevZ: 1e5,
        prevYaw: 0,
        steer: 0,
        spin: 0,
        brake: 0,
        indicator: 0,
        hazards: 0,
        pullOver: 0,
        waited: 0,
        shoveX: 0,
        shoveZ: 0,
        dentFront: 0,
        dentRear: 0,
        pace: 0.88 + this.rand() * 0.17,
        halfWidth: spec.body.halfWidth,
        front: spec.body.front,
        rear: spec.body.rear,
      });
    }
  }

  /** One physics step: drivers decide at CONTROL_HZ, every car moves every step. */
  step(dt: number, player: Car): void {
    this.time += dt;
    this.controlTimer += dt;
    const px = player.pos.x;
    const pz = player.pos.z;
    if (this.controlTimer >= 1 / CONTROL_HZ) {
      const cdt = this.controlTimer;
      this.controlTimer = 0;
      this.placePlayer(player);
      this.respawn(px, pz);
      for (const car of this.vehicles) {
        if (car.active && car.mode === 'lane') this.decide(car, cdt, player);
      }
    }
    for (const car of this.vehicles) {
      if (!car.active) continue;
      if (car.hazards > 0) car.hazards -= dt;
      const decay = Math.exp(-dt * 0.8);
      car.shoveX *= decay;
      car.shoveZ *= decay;
      // Racers are driven by the racers module along their route.
      if (car.mode === 'race') continue;
      if (car.mode === 'block') {
        car.v = 0;
        car.a = 0;
        continue;
      }
      if (car.mode === 'free') {
        this.driveFree(car, dt);
        continue;
      }
      car.v = Math.max(car.v + car.a * dt, 0);
      car.s += car.v * dt;
      while (car.s >= car.link.length) {
        const next =
          car.next ??
          (car.chase ? this.towards(car.link, car.targetX, car.targetZ) : this.choose(car.link));
        if (!next) {
          car.active = false;
          break;
        }
        car.s -= car.link.length;
        car.link = next;
        car.next = null;
        car.waited = 0;
      }
      if (car.active) this.pose(car, dt);
    }
    this.contacts(player, dt);
  }

  storePrevious(): void {
    for (const car of this.vehicles) {
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevZ = car.z;
      car.prevYaw = car.yaw;
    }
  }

  /** Writes every slot's state after the physics cars in the snapshot. */
  writeSnapshot(out: Float32Array, firstIndex: number): void {
    const q: Quat = { x: 0, y: 0, z: 0, w: 1 };
    for (const car of this.vehicles) {
      const base = (firstIndex + car.slot) * CAR_STRIDE;
      out.fill(0, base, base + CAR_STRIDE);
      out[base + C.PREV_POS] = car.prevX;
      out[base + C.PREV_POS + 1] = car.prevY;
      out[base + C.PREV_POS + 2] = car.prevZ;
      quatFromYaw(q, car.prevYaw);
      out[base + C.PREV_ROT] = q.x;
      out[base + C.PREV_ROT + 1] = q.y;
      out[base + C.PREV_ROT + 2] = q.z;
      out[base + C.PREV_ROT + 3] = q.w;
      out[base + C.POS] = car.x;
      out[base + C.POS + 1] = car.y;
      out[base + C.POS + 2] = car.z;
      quatFromYaw(q, car.yaw);
      out[base + C.ROT] = q.x;
      out[base + C.ROT + 1] = q.y;
      out[base + C.ROT + 2] = q.z;
      out[base + C.ROT + 3] = q.w;
      const fx = -Math.sin(car.yaw);
      const fz = -Math.cos(car.yaw);
      out[base + C.VEL] = fx * car.v;
      out[base + C.VEL + 2] = fz * car.v;
      out[base + C.SPEED] = car.v;
      out[base + C.RPM] = 900 + car.v * 90;
      out[base + C.GEAR] = car.v < 1 ? 0 : Math.min(1 + Math.floor(car.v / 7), 6);
      out[base + C.THROTTLE] = car.a > 0.05 ? Math.min(car.a / ACCEL, 1) : 0;
      out[base + C.BRAKE] = car.brake;
      out[base + C.STEER] = car.steer;
      out[base + C.STEER_ANGLE] = car.steer * 0.5;
      out[base + C.STEER_AUTHORITY] = 0.5;
      out[base + C.DENT_FRONT] = car.dentFront;
      out[base + C.DENT_REAR] = car.dentRear;
      out[base + C.FLAGS] =
        (this.lightsOn && car.active ? FLAG_HEADLIGHTS : 0) |
        (car.siren && car.active ? FLAG_SIREN : 0) |
        (car.hazards > 0 ? FLAG_HAZARDS : 0) |
        (car.indicator < 0 ? FLAG_INDICATOR_LEFT : 0) |
        (car.indicator > 0 ? FLAG_INDICATOR_RIGHT : 0);
      out[base + C.ERS] = -1;
      for (let i = 0; i < WHEEL_COUNT; i++) {
        const o = base + C.WHEELS + i * WHEEL_STRIDE;
        const axle = i < 2 ? car.spec.front : car.spec.rear;
        out[o + W.PREV_LENGTH] = axle.staticLength;
        out[o + W.LENGTH] = axle.staticLength;
        const steer = i < 2 ? car.steer * 0.5 : 0;
        out[o + W.PREV_STEER] = steer;
        out[o + W.STEER] = steer;
        out[o + W.PREV_SPIN] = car.spin;
        out[o + W.SPIN] = car.spin;
        out[o + W.CONTACT] = car.active ? 1 : 0;
      }
    }
  }

  // ---------------------------------------------------------------- driving

  private decide(car: Vehicle, dt: number, player: Car): void {
    const link = car.link;
    const chasing = car.chase;
    if (!car.next) {
      car.next = chasing ? this.towards(link, car.targetX, car.targetZ) : this.choose(link);
    }
    const remaining = link.length - car.s;
    // In a pursuit the limits mean nothing: a unit runs at least as fast as the player — unless
    // the target is behind it, when it holds the limit and takes the next turn (or turns around).
    this.graph.pointAt(link, car.s, point);
    const behind =
      chasing && (car.targetX - car.x) * point.tx + (car.targetZ - car.z) * point.tz < 0;
    const limit = chasing
      ? behind
        ? kmh(link.speedLimit || 60)
        : Math.max(
            kmh(link.speedLimit || 60) * 2.2,
            Math.hypot(player.vel.x, player.vel.z) * 1.15 + 5,
            22,
          )
      : kmh(link.speedLimit || 60) * car.pace;
    // Slow for the next link's limit as its start nears.
    let target = limit;
    if (car.next) {
      const nextLimit = kmh(car.next.speedLimit || 60) * car.pace;
      if (nextLimit < target)
        target = Math.min(
          target,
          Math.sqrt(nextLimit * nextLimit + 2 * BRAKE * Math.max(remaining, 0)),
        );
    }

    // A siren close by, or the player on the horn right behind: slow right down and ease over
    // to the right until it has gone.
    if (!car.police && (this.sirenNear(car) || this.hornBehind(car, player))) {
      target = Math.min(target, PULL_OVER_SPEED);
      car.pullOver = Math.min(car.pullOver + dt * 1.2, 1);
    } else if (car.pullOver > 0) {
      car.pullOver = Math.max(car.pullOver - dt * 0.8, 0);
    }
    // The nearest thing ahead: a car on this link or the next, the player, or a stop line.
    let gap = Infinity;
    let leadSpeed = 0;
    const consider = (distance: number, speed: number) => {
      if (distance < gap) {
        gap = distance;
        leadSpeed = speed;
      }
    };
    // A unit in a pursuit doesn't queue behind the traffic (the sirens clear its way).
    for (const other of this.vehicles) {
      if (other === car || !other.active || chasing || other.mode === 'race') continue;
      if (other.link === link && other.s > car.s) {
        consider(other.s - car.s - car.front - other.rear, other.v);
      } else if (car.next && other.link === car.next) {
        consider(remaining + other.s - car.front - other.rear, other.v);
      } else if (car.next && car.next.next[0] === other.link && other.s < 30) {
        consider(remaining + car.next.length + other.s - car.front - other.rear, other.v);
      }
    }
    if (!chasing) this.playerAhead(car, player, remaining, consider);
    if (!chasing && this.pedestrians) this.pedestriansAhead(car, remaining, consider);

    // The line at the end of the link: signals, stop signs, giving way, left turns.
    const stopLine = remaining - 1.5;
    const control = link.control;
    const node = link.to >= 0 ? this.graph.nodes[link.to]! : null;
    let mustStop = false;
    if (node && link.kind === 'lane' && !chasing) {
      if (control === 'signal') {
        const state = signalState(node, link.axis, this.time);
        // Amber: stop unless it would take a hard brake.
        mustStop =
          state === 'red' || (state === 'amber' && stopLine > (car.v * car.v) / (2 * HARD_BRAKE));
      } else if (control === 'stop') {
        if (car.v < 0.3 && stopLine < 3) car.waited += dt;
        mustStop = car.waited < STOP_WAIT || this.crossingTraffic(node, link, 24, player);
      } else if (control === 'yield') {
        mustStop = this.crossingTraffic(node, link, 30, player);
      }
      // A left turn gives way to oncoming traffic.
      if (!mustStop && car.next?.turn === -1 && this.oncoming(node, link, 38, player))
        mustStop = true;
    }
    if (mustStop && stopLine > -1) consider(Math.max(stopLine, 0.1), 0);

    // Intelligent driver model; above the target speed it brakes properly rather than coasting.
    const over = car.v - target;
    let a =
      over <= 0
        ? ACCEL * (1 - Math.pow(car.v / Math.max(target, 0.5), 4))
        : -BRAKE * Math.min(over / 1.5 + 0.25, 1.3);
    if (gap < 200) {
      const dv = car.v - leadSpeed;
      const wanted = STANDSTILL + car.v * HEADWAY + (car.v * dv) / (2 * Math.sqrt(ACCEL * BRAKE));
      const ratio = wanted / Math.max(gap, 0.3);
      a -= ACCEL * ratio * ratio;
    }
    car.a = Math.max(a, -HARD_BRAKE * 1.5);
    car.brake = car.a < -0.5 ? Math.min(-car.a / BRAKE, 1) : 0;
    if (car.hazards > 0) car.brake = 1;

    // Indicators: before and through a turn, and hazards override nothing (both blink).
    const turning =
      link.kind === 'turn'
        ? link.turn
        : car.next?.kind === 'turn' && remaining < 35
          ? car.next.turn
          : 0;
    car.indicator = turning;
  }

  /** Anyone crossing (or leaping about) in this car's lane ahead: a stopped leader. */
  private pedestriansAhead(
    car: Vehicle,
    remaining: number,
    consider: (distance: number, speed: number) => void,
  ): void {
    for (const ped of this.pedestrians!.list) {
      if (!ped.active || ped.state < PED_CROSSING) continue;
      if (Math.abs(ped.x - car.x) > 45 || Math.abs(ped.z - car.z) > 45) continue;
      const p = this.projectOnLink(car.link, ped.x, ped.z);
      if (p && Math.abs(p.lateral) < 2.6 && p.s > car.s) {
        consider(p.s - car.s - car.front - 1.5, 0);
      } else if (car.next) {
        const q = this.projectOnLink(car.next, ped.x, ped.z);
        if (q && Math.abs(q.lateral) < 2.6) consider(remaining + q.s - car.front - 1.5, 0);
      }
    }
  }

  /** The player close behind this car in its lane, leaning on the horn. */
  private hornBehind(car: Vehicle, player: Car): boolean {
    if (!player.horn) return false;
    if (Math.abs(player.pos.x - car.x) > 40 || Math.abs(player.pos.z - car.z) > 40) return false;
    const p = this.projectOnLink(car.link, player.pos.x, player.pos.z);
    if (!p || Math.abs(p.lateral) > 4.5) return false;
    const behind = car.s - p.s;
    return behind > 0 && behind < 35;
  }

  /** A police car with its siren on within reach (ahead or behind). */
  private sirenNear(car: Vehicle): boolean {
    for (const unit of this.vehicles) {
      if (!unit.police || !unit.siren || !unit.active) continue;
      if (Math.abs(unit.x - car.x) > SIREN_RANGE || Math.abs(unit.z - car.z) > SIREN_RANGE)
        continue;
      if (Math.hypot(unit.x - car.x, unit.z - car.z) < SIREN_RANGE) return true;
    }
    return false;
  }

  /** The player as a leader when it is in this car's lane ahead. */
  private playerAhead(
    car: Vehicle,
    player: Car,
    remaining: number,
    consider: (distance: number, speed: number) => void,
  ): void {
    const box = this.playerBox;
    const links = car.next ? [car.link, car.next] : [car.link];
    let along = 0;
    for (const link of links) {
      const p = this.projectOnLink(link, box.x, box.z);
      if (p && Math.abs(p.lateral) < 2.4) {
        const ahead = along + p.s - car.s;
        if (ahead > 0 && ahead < 120) {
          const speed = player.vel.x * p.tx + player.vel.z * p.tz;
          consider(ahead - car.front - box.rear, Math.max(speed, 0));
        }
      }
      along += link === car.link ? remaining : link.length;
      if (link === car.link) along = remaining;
    }
  }

  /** Any car (or the player) approaching the node on another road within `reach` metres. */
  private crossingTraffic(
    node: { ins: LaneLink[]; x: number; z: number },
    mine: LaneLink,
    reach: number,
    player: Car,
  ): boolean {
    for (const other of this.vehicles) {
      if (!other.active || other.link === mine || other.mode === 'race') continue;
      if (other.link.road === mine.road && other.link.kind === 'lane') continue;
      if (!node.ins.includes(other.link) && other.link.from !== mine.to) continue;
      if (other.link.kind === 'lane' && node.ins.includes(other.link)) {
        const left = other.link.length - other.s;
        if (left < reach && other.v > 0.5) return true;
      } else if (other.link.kind === 'turn' && other.link.from === mine.to) {
        return true;
      }
    }
    const d = Math.hypot(player.pos.x - node.x, player.pos.z - node.z);
    return d < reach * 0.8 && Math.hypot(player.vel.x, player.vel.z) > 1.5;
  }

  /** Oncoming traffic on the same road heading into the node (for a left turn). */
  private oncoming(node: { ins: LaneLink[] }, mine: LaneLink, reach: number, player: Car): boolean {
    for (const other of this.vehicles) {
      if (!other.active || other.link === mine || other.link.kind !== 'lane') continue;
      if (other.mode === 'race') continue;
      if (other.link.road !== mine.road || !node.ins.includes(other.link)) continue;
      if (other.link.length - other.s < reach && other.v > 1) return true;
    }
    const p = this.projectOnLink(mine, player.pos.x, player.pos.z);
    return p !== null && p.lateral < -2 && p.lateral > -12 && p.s > mine.length - reach;
  }

  /**
   * The successor that passes nearest a point (a pursuit heading for the player): the lane
   * after each connector is measured by how close the point lies beside it, or to its end.
   */
  private towards(link: LaneLink, tx: number, tz: number): LaneLink | null {
    let best: LaneLink | null = null;
    let bestD = Infinity;
    for (const option of link.next) {
      const lane = option.kind === 'turn' && option.next[0] ? option.next[0] : option;
      const pts = lane.points;
      let d = Infinity;
      for (let i = 0; i < pts.length / 2 - 1; i++) {
        const ax = pts[i * 2]!;
        const az = pts[i * 2 + 1]!;
        const bx = pts[i * 2 + 2]!;
        const bz = pts[i * 2 + 3]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        const t = Math.min(
          Math.max(((tx - ax) * (bx - ax) + (tz - az) * (bz - az)) / (len * len), 0),
          1,
        );
        d = Math.min(d, Math.hypot(tx - (ax + (bx - ax) * t), tz - (az + (bz - az) * t)));
      }
      if (d < bestD) {
        bestD = d;
        best = option;
      }
    }
    return best;
  }

  /** Free driving (pursuits): steer at the target with a limited yaw rate, chase the speed. */
  private driveFree(car: Vehicle, dt: number): void {
    const dx = car.targetX - car.x;
    const dz = car.targetZ - car.z;
    const want = Math.atan2(-dx, -dz);
    let turn = want - car.heading;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const maxRate = Math.min(2.4, 9 / Math.max(car.v, 3));
    const applied = Math.max(-maxRate * dt, Math.min(maxRate * dt, turn));
    car.heading += applied;
    // A sharp turn (turning around for a target behind) is taken slowly, so it fits the road.
    const goal = Math.abs(turn) > 1 ? Math.min(car.targetSpeed, 9) : car.targetSpeed;
    const accel = goal > car.v ? 3.8 : -6.5;
    let v = car.v + accel * dt;
    if ((accel > 0 && v > goal) || (accel < 0 && v < goal)) v = goal;
    car.v = Math.max(v, 0);
    car.a = accel;
    car.brake = accel < 0 && car.v > 0.5 ? 1 : 0;
    car.x += -Math.sin(car.heading) * car.v * dt;
    car.z += -Math.cos(car.heading) * car.v * dt;
    const deck = this.map.deckAt(car.x, car.z, 0.5);
    car.y = (deck ? deck.height : this.map.groundHeight(car.x, car.z)) + car.spec.cogHeight;
    car.yaw = car.heading;
    const wanted = Math.max(
      -1,
      Math.min(1, ((applied / Math.max(dt, 1e-3)) * 2.6) / Math.max(car.v, 3)),
    );
    car.steer += (wanted - car.steer) * Math.min(dt * 12, 1);
    car.spin += (car.v * dt) / car.spec.front.wheelRadius;
    car.indicator = 0;
  }

  /** Puts a car back on the nearest lane (after driving freely), or false when none is near. */
  attachToLane(car: Vehicle): boolean {
    let best: { link: LaneLink; s: number; d: number } | null = null;
    for (const link of this.graph.linksNear(car.x, car.z, 60)) {
      if (link.kind !== 'lane') continue;
      const p = this.projectOnLink(link, car.x, car.z);
      if (!p) continue;
      const d = Math.abs(p.lateral);
      if (!best || d < best.d) best = { link, s: p.s, d };
    }
    if (!best) return false;
    car.mode = 'lane';
    car.link = best.link;
    car.s = Math.min(best.s, best.link.length - 0.1);
    car.next = null;
    car.waited = 0;
    this.pose(car, 0);
    return true;
  }

  /** Puts a car on a random lane between `min` and `max` metres from a point. */
  spawnNear(car: Vehicle, px: number, pz: number, min: number, max: number): boolean {
    const nearby = this.graph
      .linksNear(px, pz, max)
      .filter((l) => l.kind === 'lane' && l.length > 30);
    for (let attempt = 0; attempt < 10 && nearby.length > 0; attempt++) {
      const link = nearby[Math.floor(this.rand() * nearby.length)]!;
      const s = 6 + this.rand() * (link.length - 12);
      this.graph.pointAt(link, s, point);
      if (Math.hypot(point.x - px, point.z - pz) < min) continue;
      if (
        this.vehicles.some(
          (o) => o.active && o.mode !== 'race' && o.link === link && Math.abs(o.s - s) < 14,
        )
      ) {
        continue;
      }
      car.active = true;
      car.mode = 'lane';
      car.link = link;
      car.s = s;
      car.v = kmh(link.speedLimit || 40) * 0.6;
      car.a = 0;
      car.next = null;
      car.hazards = 0;
      car.waited = 0;
      car.shoveX = 0;
      car.shoveZ = 0;
      car.dentFront = 0;
      car.dentRear = 0;
      car.pullOver = 0;
      car.yaw = Math.atan2(-point.tx, -point.tz);
      car.heading = car.yaw;
      car.steer = 0;
      this.pose(car, 0);
      car.prevX = car.x;
      car.prevY = car.y;
      car.prevZ = car.z;
      car.prevYaw = car.yaw;
      return true;
    }
    return false;
  }

  private choose(link: LaneLink): LaneLink | null {
    const options = link.next;
    if (options.length === 0) return null;
    if (options.length === 1) return options[0]!;
    let total = 0;
    const weights = options.map((o) => {
      const w = o.kind !== 'turn' ? 3 : o.turn === 0 ? 3 : o.turn === 1 ? 1.4 : 0.9;
      const w2 = o.road?.kind === 'ramp' || o.next[0]?.road?.kind === 'ramp' ? w * 0.5 : w;
      total += w2;
      return w2;
    });
    let r = this.rand() * total;
    for (let i = 0; i < options.length; i++) {
      r -= weights[i]!;
      if (r <= 0) return options[i]!;
    }
    return options[options.length - 1]!;
  }

  private pose(car: Vehicle, dt: number): void {
    this.graph.pointAt(car.link, car.s, point);
    const yaw = Math.atan2(-point.tx, -point.tz);
    let turn = yaw - car.yaw;
    while (turn > Math.PI) turn -= Math.PI * 2;
    while (turn < -Math.PI) turn += Math.PI * 2;
    const rate = dt > 0 ? turn / dt : 0;
    // Steering from the yaw rate: the wheels point where the car is going.
    const wanted = Math.max(-1, Math.min(1, (rate * 2.6) / Math.max(car.v, 3)));
    car.steer += (wanted - car.steer) * Math.min(dt * 12, 1);
    car.yaw = yaw;
    // Over to the right of the lane when pulled over for a siren.
    const over = car.pullOver * PULL_OVER_OFFSET;
    car.x = point.x + car.shoveX - point.tz * over;
    car.z = point.z + car.shoveZ + point.tx * over;
    car.y = point.y + car.spec.cogHeight;
    car.spin += (car.v * dt) / car.spec.front.wheelRadius;
  }

  // ---------------------------------------------------------------- spawning

  private respawn(px: number, pz: number): void {
    for (const car of this.vehicles) {
      // The police module places its own cars while they are working; the racers are placed
      // by the racers module only.
      if (car.racer || (car.police && (car.mode !== 'lane' || car.chase))) continue;
      const d = car.active ? Math.hypot(car.x - px, car.z - pz) : Infinity;
      if (d <= DESPAWN_RADIUS) continue;
      if (!this.spawnNear(car, px, pz, SPAWN_CLEAR, SPAWN_RADIUS)) car.active = false;
    }
  }

  // ---------------------------------------------------------------- contacts

  private placePlayer(player: Car): void {
    const q = player.rot;
    const box = this.playerBox;
    box.x = player.pos.x;
    box.z = player.pos.z;
    box.fx = -2 * (q.x * q.z + q.w * q.y);
    box.fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const len = Math.hypot(box.fx, box.fz) || 1;
    box.fx /= len;
    box.fz /= len;
    box.halfWidth = player.spec.body.halfWidth;
    box.front = player.spec.body.front;
    box.rear = player.spec.body.rear;
  }

  /** The player against each nearby traffic car as oriented boxes on the ground plane. */
  private contacts(player: Car, dt: number): void {
    this.placePlayer(player);
    const box = this.playerBox;
    for (const car of this.vehicles) {
      if (!car.active) continue;
      if (Math.abs(car.x - box.x) > 9 || Math.abs(car.z - box.z) > 9) continue;
      if (Math.abs(car.y - player.pos.y) > 2.5) continue;
      const fx = -Math.sin(car.yaw);
      const fz = -Math.cos(car.yaw);
      const hit = overlap(
        box.x,
        box.z,
        box.fx,
        box.fz,
        box.halfWidth,
        box.front,
        box.rear,
        car.x,
        car.z,
        fx,
        fz,
        car.halfWidth,
        car.front,
        car.rear,
      );
      if (!hit) continue;
      // Push the player out along the separating axis, taking its approach speed away, and
      // shove the traffic car the other way; it stops with its hazards on.
      const vn =
        player.vel.x * hit.nx + player.vel.z * hit.nz - (fx * hit.nx + fz * hit.nz) * car.v;
      const mass = player.spec.mass;
      const impulse = mass * (Math.max(-vn, 0) * 1.1 + hit.depth * 6 * dt * 60);
      const point: Vec3 = { x: hit.x, y: player.pos.y, z: hit.z };
      player.applyImpulse(point, { x: hit.nx * impulse, y: 0, z: hit.nz * impulse });
      car.shoveX -= hit.nx * hit.depth * 0.5;
      car.shoveZ -= hit.nz * hit.depth * 0.5;
      // The simple damage: a dent at whichever end was hit, by the closing speed.
      const along = (hit.x - car.x) * fx + (hit.z - car.z) * fz;
      const dent = Math.min(Math.abs(vn) / 10, 0.6);
      if (along >= 0) car.dentFront = Math.min(car.dentFront + dent, 1);
      else car.dentRear = Math.min(car.dentRear + dent, 1);
      // A racer is knocked about but races on: rubbing is racing, and no offence.
      if (car.mode === 'race') {
        car.v = Math.max(car.v - Math.abs(vn) * 0.25, 0);
        continue;
      }
      car.v = Math.max(car.v - Math.abs(vn) * 0.5, 0);
      car.a = -HARD_BRAKE;
      // A unit ramming the player in a pursuit is its own doing: no hazards, no offence.
      if (car.police && car.mode === 'free') continue;
      if (Math.abs(vn) > 1.5 && car.hazards <= 0) this.playerHits++;
      car.hazards = HAZARD_TIME;
    }
  }

  /** Distance along a link and sideways from it for a point (null when far from it). */
  private projectOnLink(
    link: LaneLink,
    x: number,
    z: number,
  ): { s: number; lateral: number; tx: number; tz: number } | null {
    let best: { s: number; lateral: number; tx: number; tz: number } | null = null;
    let bestD = 12;
    const pts = link.points;
    for (let i = 0; i < pts.length / 2 - 1; i++) {
      const ax = pts[i * 2]!;
      const az = pts[i * 2 + 1]!;
      const bx = pts[i * 2 + 2]!;
      const bz = pts[i * 2 + 3]!;
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      const t = Math.min(Math.max(((x - ax) * tx + (z - az) * tz) / len, 0), 1);
      const px = ax + tx * len * t;
      const pz = az + tz * len * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < bestD) {
        bestD = d;
        const lateral = (x - px) * -tz + (z - pz) * tx;
        best = { s: link.cum[i]! + len * t, lateral, tx, tz };
      }
    }
    return best;
  }
}

/**
 * Two boxes on the ground plane (centre, forward direction, half width, and how far the body
 * reaches ahead of and behind the centre): the smallest push that separates them, as the
 * direction to move the first box, its depth and a contact point. Null when apart.
 */
export function overlap(
  ax: number,
  az: number,
  afx: number,
  afz: number,
  aw: number,
  afront: number,
  arear: number,
  bx: number,
  bz: number,
  bfx: number,
  bfz: number,
  bw: number,
  bfront: number,
  brear: number,
): { nx: number; nz: number; depth: number; x: number; z: number } | null {
  // Box centres shifted to the middle of each body.
  const acx = ax + afx * ((afront - arear) / 2);
  const acz = az + afz * ((afront - arear) / 2);
  const bcx = bx + bfx * ((bfront - brear) / 2);
  const bcz = bz + bfz * ((bfront - brear) / 2);
  const al = (afront + arear) / 2;
  const bl = (bfront + brear) / 2;
  const axes: Array<[number, number]> = [
    [afx, afz],
    [-afz, afx],
    [bfx, bfz],
    [-bfz, bfx],
  ];
  const dx = bcx - acx;
  const dz = bcz - acz;
  let best = Infinity;
  let nx = 0;
  let nz = 0;
  for (const [ux, uz] of axes) {
    const ra = Math.abs(afx * ux + afz * uz) * al + Math.abs(-afz * ux + afx * uz) * aw;
    const rb = Math.abs(bfx * ux + bfz * uz) * bl + Math.abs(-bfz * ux + bfx * uz) * bw;
    const d = dx * ux + dz * uz;
    const pen = ra + rb - Math.abs(d);
    if (pen <= 0) return null;
    if (pen < best) {
      best = pen;
      // Push a away from b.
      const sign = d > 0 ? -1 : 1;
      nx = ux * sign;
      nz = uz * sign;
    }
  }
  return { nx, nz, depth: best, x: (acx + bcx) / 2, z: (acz + bcz) / 2 };
}
