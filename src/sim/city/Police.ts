import { signalState } from '../../content/city/lanes';
import { insideLot, type CityMap, type Road } from '../../content/city/map';
import { rotateV, type Vec3 } from '../../shared/math';
import type { PoliceStatus } from '../../shared/protocol';
import type { Car } from '../vehicle/car';
import type { Traffic, Vehicle } from './Traffic';

/**
 * The police: patrol cars among the traffic that notice speeding, red lights and crashes when
 * they can see the player, raise the heat (wanted level, 0 … 5) and give chase — along the
 * lanes at first, then freely once close: a PIT on the rear quarter, boxing in from ahead, and
 * from heat 3 roadblocks across the road ahead, with spike strips from heat 4. Break their
 * line of sight long enough and you are away; stop next to them and you are busted and fined.
 */

const CONTROL_HZ = 20;
/**
 * How far a patrol car notices an offence, how far a unit keeps the player in sight once the
 * chase is on, and the time out of sight that ends a pursuit.
 */
const SEE_RANGE = 170;
const PURSUIT_RANGE = 320;
const EVADE_TIME = 14;
/** A unit this far behind rejoins from a side street near the player (while it is seen). */
const REJOIN_RANGE = 520;
/** Standing still this long within reach of a police car gets you busted. */
const BUST_TIME = 3.5;
const BUST_RANGE = 14;
/** Over the limit by this much (km/h) for two seconds is an offence. */
const SPEEDING_MARGIN = 20;
const OFFENCE_GAP = 10;
/** Roadblocks: this far ahead, this often, on heat 3 and above; strips on heat 4. */
const BLOCK_AHEAD = 260;
const BLOCK_GAP = 45;
const BLOCK_HEAT = 3;
const STRIP_HEAT = 4;
/** Switch to free driving this close to the player (in sight), back to the lanes when this far. */
const FREE_RANGE = 120;
const LANE_RANGE = 180;
/** Stopped or crawling: slower than this (m/s) counts as pulled over for the bust. */
const BUST_SPEED = 2.5;
/** From this heat a helicopter keeps the player in sight from above, except under the deck. */
const HELI_HEAT = 4;
const SHOWN = 4;

interface Block {
  units: Vehicle[];
  x: number;
  z: number;
  since: number;
  strip: number[] | null;
}

export class Police {
  readonly status: PoliceStatus = {
    heat: 0,
    state: 'clear',
    evade: 0,
    fine: 0,
    fines: 0,
    strips: [],
    helicopter: false,
  };
  private readonly units: Vehicle[];
  /** A festival event is on: speeding is sanctioned (red lights and crashes still count). */
  sanctioned = false;
  private time = 0;
  private timer = 0;
  private sinceSeen = 0;
  private stopped = 0;
  private speedingFor = 0;
  private offenceAt = -Infinity;
  private shownUntil = 0;
  private hits = 0;
  private insideNode = -1;
  /** Where the player was last seen: the units head there when they lose sight. */
  private lastX = 0;
  private lastZ = 0;
  private block: Block | null = null;
  private blockAt = -Infinity;
  private readonly corner: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly arm: Vec3 = { x: 0, y: 0, z: 0 };

  constructor(
    private readonly traffic: Traffic,
    private readonly map: CityMap,
  ) {
    this.units = traffic.vehicles.filter((v) => v.police);
  }

  step(dt: number, player: Car): void {
    this.time += dt;
    this.timer += dt;
    // Every step, so a fast wheel can't skip over a strip between two control ticks.
    this.strips(player);
    if (this.timer < 1 / CONTROL_HZ) return;
    const cdt = this.timer;
    this.timer = 0;
    const status = this.status;
    const px = player.pos.x;
    const pz = player.pos.z;
    const speed = Math.hypot(player.vel.x, player.vel.z);

    // Who can see the player.
    let seen = false;
    let nearest = Infinity;
    const range = status.heat > 0 ? PURSUIT_RANGE : SEE_RANGE;
    for (const unit of this.units) {
      if (!unit.active) continue;
      const d = Math.hypot(unit.x - px, unit.z - pz);
      nearest = Math.min(nearest, d);
      if (d < range && this.lineOfSight(unit.x, unit.z, px, pz)) seen = true;
    }
    // From four stars a helicopter has the player from above, except under the orbital's deck.
    status.helicopter = status.heat >= HELI_HEAT;
    if (status.helicopter && this.helicopterSees(player)) seen = true;
    if (seen || status.heat === 0) {
      this.lastX = px;
      this.lastZ = pz;
    }

    // Offences.
    const limit = this.map.speedLimitAt(px, pz, player.pos.y);
    this.speedingFor =
      limit > 0 && speed * 3.6 > limit + SPEEDING_MARGIN ? this.speedingFor + cdt : 0;
    if (this.speedingFor > 2 && seen && !this.sanctioned) this.offence();
    if (this.ranRedLight(player, speed) && seen) this.offence();
    if (this.traffic.playerHits > this.hits) {
      this.hits = this.traffic.playerHits;
      if (seen) this.offence();
    }
    // Hitting a patrolling or parked unit (its hazards just came on) is an offence too.
    for (const unit of this.units) {
      if (unit.active && unit.mode !== 'free' && unit.hazards > 11.9) this.offence();
    }

    // The pursuit.
    if (status.heat > 0) {
      status.state = 'pursuit';
      this.sinceSeen = seen ? 0 : this.sinceSeen + cdt;
      status.evade = Math.min(this.sinceSeen / EVADE_TIME, 1);
      if (this.sinceSeen >= EVADE_TIME) {
        this.endPursuit('escaped');
      } else {
        this.stopped = seen && speed < BUST_SPEED && nearest < BUST_RANGE ? this.stopped + cdt : 0;
        if (this.stopped >= BUST_TIME) {
          status.fines += status.fine;
          this.endPursuit('busted');
        } else {
          this.pursue(player, speed, seen);
          this.roadblocks(player, speed);
        }
      }
    } else {
      if (this.time > this.shownUntil && status.state !== 'clear') status.state = 'clear';
      this.patrol(player);
    }
  }

  /**
   * A getaway: the police are on the player at this many stars from this moment (the units
   * head for where the player was last seen, which is here).
   */
  startPursuit(heat: number): void {
    const status = this.status;
    status.heat = Math.max(1, Math.min(Math.round(heat), 5));
    status.fine = 250 * status.heat;
    status.state = 'pursuit';
    this.sinceSeen = 0;
    this.stopped = 0;
    this.offenceAt = this.time;
  }

  // ---------------------------------------------------------------- offences

  private offence(): void {
    if (this.time - this.offenceAt < OFFENCE_GAP) return;
    this.offenceAt = this.time;
    const status = this.status;
    status.heat = Math.min(status.heat + 1, 5);
    status.fine += 250 * status.heat;
    this.sinceSeen = 0;
    this.stopped = 0;
  }

  /** Entering a signalled junction's box against a red light, at speed. */
  private ranRedLight(player: Car, speed: number): boolean {
    const px = player.pos.x;
    const pz = player.pos.z;
    let inside = -1;
    for (let i = 0; i < this.map.junctions.length; i++) {
      const j = this.map.junctions[i]!;
      if (j.control !== 'signal') continue;
      if (Math.abs(j.x - px) < 12 && Math.abs(j.z - pz) < 12) {
        inside = i;
        break;
      }
    }
    const entered = inside >= 0 && inside !== this.insideNode;
    this.insideNode = inside;
    if (!entered || speed < 3) return false;
    const j = this.map.junctions[inside]!;
    const axis: 0 | 1 = Math.abs(player.vel.x) > Math.abs(player.vel.z) ? 0 : 1;
    return signalState(j, axis, this.time) === 'red';
  }

  /** Straight line from a police car to the player with no building in the way. */
  private lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    for (let i = 1; i <= 6; i++) {
      const t = i / 7;
      const x = ax + (bx - ax) * t;
      const z = az + (bz - az) * t;
      for (const lot of this.map.lotsNear(x, z)) {
        if (lot.style === 'container' && lot.y > 0.5) continue;
        if (insideLot(lot, x, z)) return false;
      }
    }
    return true;
  }

  /** Whether the helicopter can see the player: anywhere but under the orbital's deck. */
  helicopterSees(player: Car): boolean {
    const deck = this.map.deckAt(player.pos.x, player.pos.z, 1);
    return !(deck && player.pos.y < deck.height - 2);
  }

  // ---------------------------------------------------------------- driving

  /** Off duty: a couple of patrol cars drive the lanes with the traffic. */
  private patrol(player: Car): void {
    const wanted = Math.min(2, this.units.length);
    this.units.forEach((unit, i) => {
      unit.siren = false;
      unit.chase = false;
      if (i < wanted) {
        if (!unit.active) this.traffic.spawnNear(unit, player.pos.x, player.pos.z, 80, 320);
        else if (unit.mode !== 'lane' && !this.traffic.attachToLane(unit)) unit.active = false;
      } else if (unit.active && unit.mode !== 'block') {
        unit.active = false;
      }
    });
  }

  /**
   * On duty: units close in along the lanes (heading for where the player was last seen), then
   * drive at the player: the PIT, and boxing in.
   */
  private pursue(player: Car, speed: number, seen: boolean): void {
    const heat = this.status.heat;
    const chasing = Math.min(
      heat + 1,
      this.units.length - (this.block ? this.block.units.length : 0),
    );
    const px = player.pos.x;
    const pz = player.pos.z;
    const tx = seen ? px : this.lastX;
    const tz = seen ? pz : this.lastZ;
    const q = player.rot;
    // The player's forward and right on the ground.
    let fx = -2 * (q.x * q.z + q.w * q.y);
    let fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const len = Math.hypot(fx, fz) || 1;
    fx /= len;
    fz /= len;
    const rx = -fz;
    const rz = fx;
    let role = 0;
    for (const unit of this.units) {
      if (this.block?.units.includes(unit)) continue;
      if (role >= chasing) {
        if (unit.active && unit.mode !== 'lane') this.traffic.attachToLane(unit);
        unit.chase = false;
        unit.siren = false;
        continue;
      }
      role++;
      unit.siren = true;
      unit.chase = true;
      unit.targetX = tx;
      unit.targetZ = tz;
      if (!unit.active) {
        this.traffic.spawnNear(unit, tx, tz, 120, 300);
        continue;
      }
      const d = Math.hypot(unit.x - px, unit.z - pz);
      // Left far behind while the player is in sight: it rejoins from a side street.
      if (unit.mode === 'lane' && seen && d > REJOIN_RANGE) {
        this.traffic.spawnNear(unit, px, pz, 120, 300);
        continue;
      }
      const onDeck = player.pos.y > 3;
      if (unit.mode === 'lane' && d < FREE_RANGE && seen && !onDeck) {
        unit.mode = 'free';
        unit.heading = unit.yaw;
      } else if (unit.mode === 'free' && (d > LANE_RANGE || !this.map.paved(unit.x, unit.z))) {
        if (!this.traffic.attachToLane(unit)) {
          this.traffic.spawnNear(unit, px, pz, 100, 250);
        }
      }
      if (unit.mode !== 'free') continue;
      // The first unit goes for the PIT: the rear quarter on its side, then through it. The
      // others box the player in from ahead, one each side.
      const side = (unit.x - px) * rx + (unit.z - pz) * rz >= 0 ? 1 : -1;
      // Far away it closes at full tilt, then matches the player's pace near the contact.
      const closing = Math.max(0, d - 14) * 0.6;
      if (speed < 3) {
        // The player has stopped: pull up behind it and wait for the bust, no ramming.
        const along = -player.spec.body.rear - 7;
        unit.targetX = px + fx * along + rx * side * 1.2;
        unit.targetZ = pz + fz * along + rz * side * 1.2;
        const left = Math.hypot(unit.targetX - unit.x, unit.targetZ - unit.z);
        unit.targetSpeed = Math.min(Math.max(left - 1.5, 0) * 0.8, 24);
      } else if (role === 1 || heat < 3) {
        const behind = d > 9;
        const along = behind ? -player.spec.body.rear - 4 : -player.spec.body.rear + 0.6;
        const across = behind ? side * 1.3 : -side * 0.8;
        unit.targetX = px + fx * along + rx * across;
        unit.targetZ = pz + fz * along + rz * across;
        unit.targetSpeed = Math.min(speed + (behind ? 9 : 5) + closing, 78);
      } else {
        const ahead = 11 + role * 2;
        unit.targetX = px + fx * ahead + rx * side * 2.6;
        unit.targetZ = pz + fz * ahead + rz * side * 2.6;
        // Ahead of the player it holds a little under its speed so the box closes.
        const there = Math.hypot(unit.targetX - unit.x, unit.targetZ - unit.z) < 4;
        unit.targetSpeed = there ? Math.max(speed - 3, 0) : Math.min(speed + 10 + closing, 78);
      }
    }
  }

  /** From heat 3: two units park across the player's road ahead; a spike strip from heat 4. */
  private roadblocks(player: Car, speed: number): void {
    const block = this.block;
    const px = player.pos.x;
    const pz = player.pos.z;
    if (block) {
      const d = Math.hypot(block.x - px, block.z - pz);
      const passed = d < 30 || this.time - block.since > 70;
      if (passed) {
        for (const unit of block.units) {
          unit.mode = 'free';
          unit.heading = unit.yaw;
          unit.chase = true;
        }
        this.status.strips = this.status.strips.filter((s) => s !== block.strip);
        this.block = null;
      }
      return;
    }
    const heat = this.status.heat;
    if (heat < BLOCK_HEAT || this.time - this.blockAt < BLOCK_GAP || speed < 6) return;
    if (this.units.length < 3) return;
    const p = this.map.project(px, pz, { level: player.pos.y > 3, maxDist: 14 });
    if (!p || p.piece.road.kind === 'ramp') return;
    const road = p.piece.road;
    const forward = player.vel.x * p.piece.tx + player.vel.z * p.piece.tz >= 0 ? 1 : -1;
    const at = this.map.pointAlong(road, clampAlong(road, p.s + forward * BLOCK_AHEAD));
    if (!at) return;
    const units = this.units.slice(-2);
    const half = road.width / 2;
    units.forEach((unit, i) => {
      const across = (i === 0 ? -1 : 1) * Math.min(half * 0.5, 3);
      unit.active = true;
      unit.mode = 'block';
      unit.chase = false;
      unit.siren = true;
      unit.v = 0;
      unit.a = 0;
      unit.x = at.x + -at.tz * across;
      unit.z = at.z + at.tx * across;
      unit.y = at.y + unit.spec.cogHeight;
      unit.yaw = Math.atan2(-at.tx, -at.tz) + Math.PI / 2;
      unit.heading = unit.yaw;
      unit.prevX = unit.x;
      unit.prevY = unit.y;
      unit.prevZ = unit.z;
      unit.prevYaw = unit.yaw;
    });
    let strip: number[] | null = null;
    if (heat >= STRIP_HEAT) {
      const back = 12 * forward;
      const sx = at.x - at.tx * back;
      const sz = at.z - at.tz * back;
      strip = [
        sx + -at.tz * (half - 1),
        sz + at.tx * (half - 1),
        sx - -at.tz * (half - 1),
        sz - at.tx * (half - 1),
      ];
      this.status.strips.push(strip);
    }
    this.block = { units, x: at.x, z: at.z, since: this.time, strip };
    this.blockAt = this.time;
  }

  /** A wheel crossing a strip bursts its tyre; the strip is spent. */
  private strips(player: Car): void {
    const strips = this.status.strips;
    if (strips.length === 0) return;
    const body = player.spec.body;
    const corners: Array<[number, number, number]> = [
      [-body.halfWidth, -body.front, 0],
      [body.halfWidth, -body.front, 1],
      [-body.halfWidth, body.rear, 2],
      [body.halfWidth, body.rear, 3],
    ];
    for (const strip of [...strips]) {
      const [x1, z1, x2, z2] = strip as [number, number, number, number];
      let burst = false;
      for (const [cx, cz, wheel] of corners) {
        const arm = this.arm;
        arm.x = cx;
        arm.y = 0;
        arm.z = cz;
        const world = rotateV(this.corner, player.rot, arm);
        const wx = player.pos.x + world.x;
        const wz = player.pos.z + world.z;
        if (segmentDistance(x1, z1, x2, z2, wx, wz) < 0.7) {
          player.burstTyre(wheel);
          burst = true;
        }
      }
      if (burst) this.status.strips = this.status.strips.filter((s) => s !== strip);
    }
  }

  private endPursuit(how: 'escaped' | 'busted'): void {
    const status = this.status;
    status.heat = 0;
    status.evade = 0;
    status.fine = 0;
    status.state = how;
    status.strips = [];
    status.helicopter = false;
    this.shownUntil = this.time + SHOWN;
    this.sinceSeen = 0;
    this.stopped = 0;
    this.speedingFor = 0;
    this.block = null;
    for (const unit of this.units) {
      unit.siren = false;
      unit.chase = false;
      if (unit.mode !== 'lane' && !this.traffic.attachToLane(unit)) unit.active = false;
    }
  }
}

function segmentDistance(
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  x: number,
  z: number,
): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len = dx * dx + dz * dz;
  const t = len > 0 ? Math.min(Math.max(((x - x1) * dx + (z - z1) * dz) / len, 0), 1) : 0;
  return Math.hypot(x - (x1 + dx * t), z - (z1 + dz * t));
}

/** A distance along a road kept a little inside its ends (a loop wraps instead). */
function clampAlong(road: Road, s: number): number {
  return road.loop ? s : Math.min(Math.max(s, 5), road.length - 5);
}
