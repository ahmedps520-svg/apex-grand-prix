import { PIT_BOX, PIT_OFFSET } from '../../shared/pitLane';
import { defaultAids } from '../../shared/protocol';
import type { Surface } from '../track/surface';
import type { Track } from '../track/Track';
import { Car, type Spawn } from '../vehicle/car';
import type { CarSpec } from '../vehicle/spec';
import { AiDriver } from './AiDriver';
import { Pits, type PitRace } from './Pits';
import type { RaceStatus, SafetyCarStatus } from './RaceDirector';
import type { RacingLine } from './racingLine';
import { projectNear, trackPos, wrapDelta } from './trackPos';

/** The safety car's speed, m/s: the field's limit behind it. */
export const SAFETY_CAR_SPEED = 24;
/** A yellow flag that stands this long brings it out. */
export const SAFETY_CAR_AFTER = 5;
/**
 * Times it crosses the line before the lap it comes in on: one, so it leads the rest of the
 * lap it came out on and one more (the board says IN THIS LAP for that one).
 */
export const SAFETY_CAR_LAPS = 1;
/** The penalty for a pass under it, seconds. */
export const SAFETY_CAR_PENALTY = 3;
/** Metres ahead of the leader it joins the track. */
const JOIN_AHEAD = 70;
/** Never with fewer laps left than this, nor sooner after a restart than this (seconds). */
const MIN_LAPS_LEFT = 2;
const COOL_DOWN = 60;
/** A car this close ahead of the player counts as passed when the player gets by it. */
const PASS_RANGE = 60;

/** Where a car is round the lap, 0 … 1, from the director's progress (negative before the line). */
const lapFraction = (progress: number): number => ((progress % 1) + 1) % 1;

/**
 * The safety car: it waits out of sight in its box in the pit lane; when a yellow flag has
 * stood a while it joins the track just ahead of the leader and drives the line at its own
 * speed, the field bunching up behind it and holding station (the AI by its limit, the player
 * on pain of a penalty); after its laps it peels into the pit lane, the race goes green as it
 * does, and it rides the lane back to its box.
 */
export class SafetyCar {
  readonly car: Car;
  readonly driver: AiDriver;
  readonly status: SafetyCarStatus = { phase: 'none', laps: 0, deployments: 0 };
  /** Laps it leads before coming in (the tests shorten it). */
  lapsToLead = SAFETY_CAR_LAPS;
  private readonly pits: Pits;
  private readonly pitRace: PitRace = {
    phase: 'racing',
    laps: 0,
    cars: [{ lap: 0, finished: false }],
  };
  private readonly pos = trackPos();
  private readonly box: Spawn;
  private yellowFor = 0;
  private sinceGreen = Infinity;
  private lastS = 0;
  /** Riding the rails back to its box after the green. */
  private leaving = false;
  /** Per racer (and last the safety car itself): ahead of the player within range last step. */
  private readonly wasAhead: boolean[] = [];

  constructor(
    private readonly track: Track,
    spec: CarSpec,
    line: RacingLine,
    seed: number,
  ) {
    const p = track.at(track.length - PIT_BOX);
    const lat = -(track.halfWidth + PIT_OFFSET);
    this.box = { x: p.x - p.tz * lat, z: p.z + p.tx * lat, yaw: Math.atan2(-p.tx, -p.tz) };
    this.car = new Car(spec, this.box, track);
    this.car.retired = true;
    this.car.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high', abs: 'high' });
    this.car.autoHybrid = true;
    this.driver = new AiDriver(track, line, { skill: 1, seed: seed ^ 0x5afe });
    this.driver.limit = SAFETY_CAR_SPEED;
    this.pits = new Pits(track, 1, [true]);
  }

  /** On the track, or riding into its box: part of the field's contacts. */
  get active(): boolean {
    return this.status.phase !== 'none' || this.leaving;
  }

  /** A restart: back in its box, nothing counted. */
  reset(): void {
    this.park();
    this.status.deployments = 0;
    this.yellowFor = 0;
    this.sinceGreen = Infinity;
  }

  /**
   * Brings it out now, ahead of the leader: on its own when the race allows it (a yellow that
   * has stood), or `force`d (the debug command). True when it came out.
   */
  deploy(race: RaceStatus | null, force: boolean): boolean {
    if (!race || race.mode !== 'race' || race.phase !== 'racing') return false;
    if (this.status.phase !== 'none' || this.leaving) return false;
    if (!force && !this.allowed(race)) return false;
    const leader = race.order.find((i) => !race.cars[i]!.finished) ?? 0;
    const length = this.track.length;
    const s = (lapFraction(race.cars[leader]!.progress) * length + JOIN_AHEAD) % length;
    const p = this.track.at(s);
    this.car.retired = false;
    this.car.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
    const v = SAFETY_CAR_SPEED * 0.8;
    this.car.vel.x = p.tx * v;
    this.car.vel.z = p.tz * v;
    this.car.hazards = true;
    this.driver.reset();
    this.pos.index = -1;
    this.lastS = s;
    this.wasAhead.length = 0;
    this.yellowFor = 0;
    const st = this.status;
    st.phase = 'out';
    st.laps = 0;
    st.deployments++;
    return true;
  }

  /** Every step, before the field moves: the call, its drive, its laps and the player's passes. */
  update(dt: number, cars: readonly Car[], race: RaceStatus | null, surface: Surface): void {
    this.sinceGreen += dt;
    if (this.leaving) this.ride(dt);
    const st = this.status;
    if (!race || race.mode !== 'race') return;
    if (race.phase !== 'racing') {
      if (st.phase !== 'none') this.park();
      return;
    }
    this.yellowFor = race.yellow >= 0 ? this.yellowFor + dt : 0;
    if (st.phase === 'none') {
      if (this.yellowFor >= SAFETY_CAR_AFTER) this.deploy(race, false);
      return;
    }
    if (!this.car.onRails) {
      this.car.setInput(this.driver.drive(this.car, cars, dt));
      this.car.step(dt, surface);
      if (!this.car.isFinite()) this.car.reset();
      this.countLap();
      if (st.phase === 'out' && st.laps >= this.lapsToLead) {
        st.phase = 'in';
        this.pits.arm(0, true);
      }
    }
    if (st.phase === 'in') {
      this.pits.update(dt, [this.car], this.pitRace);
      if (this.car.onRails) {
        // Into the lane: the race is green again, and it rides on to its box.
        st.phase = 'none';
        st.laps = 0;
        this.leaving = true;
        this.sinceGreen = 0;
        this.car.hazards = false;
        return;
      }
    }
    this.judgePasses(cars, race);
  }

  private allowed(race: RaceStatus): boolean {
    if (!race.rules || race.elimination || race.qualifying || race.laps < 3) return false;
    if (this.sinceGreen < COOL_DOWN) return false;
    const leader = race.order.find((i) => !race.cars[i]!.finished);
    if (leader === undefined) return false;
    return race.laps - race.cars[leader]!.lap >= MIN_LAPS_LEFT;
  }

  private countLap(): void {
    const s = projectNear(this.track, this.car.pos.x, this.car.pos.z, this.pos.index, this.pos).s;
    if (this.lastS - s > this.track.length / 2) this.status.laps++;
    this.lastS = s;
  }

  /** The player's passes under the safety car: each one a penalty (a pitting car is no pass). */
  private judgePasses(cars: readonly Car[], race: RaceStatus): void {
    const player = race.cars[0];
    const me = cars[0];
    if (!player || !me || player.finished) return;
    const length = this.track.length;
    const s0 = lapFraction(player.progress) * length;
    const n = cars.length;
    for (let j = 1; j <= n; j++) {
      // The racers, then the safety car itself.
      const car = j < n ? cars[j]! : this.car;
      const sj = j < n ? lapFraction(race.cars[j]!.progress) * length : this.lastS;
      const out = j < n && (race.cars[j]!.finished || car.retired || car.onRails);
      const gap = wrapDelta(sj - s0, length);
      const ahead = !out && gap > 0 && gap < PASS_RANGE;
      if (this.wasAhead[j] && !out && gap < 0 && gap > -PASS_RANGE && car.forwardSpeed() >= 0) {
        player.penalty += SAFETY_CAR_PENALTY;
        player.penaltyFor = 'safetyCar';
      }
      this.wasAhead[j] = ahead;
    }
  }

  /** Down the lane to the box, where it stops out of sight. */
  private ride(dt: number): void {
    this.pits.update(dt, [this.car], this.pitRace);
    if (this.pits.info(0).phase === 'stop') this.park();
  }

  private park(): void {
    this.pits.reset([this.car]);
    this.car.retired = true;
    this.car.hazards = false;
    this.car.teleport(this.box);
    this.driver.reset();
    this.leaving = false;
    this.status.phase = 'none';
    this.status.laps = 0;
  }
}
