import {
  PIT_BLEND,
  PIT_BOX,
  PIT_ENTRY,
  PIT_LENGTH,
  PIT_OFFSET,
  PIT_SPEED,
  PIT_TIME,
  laneShare,
  type PitInfo,
  type PitPhase,
} from '../../shared/pitLane';
import type { Track } from '../track/Track';
import type { Car } from '../vehicle/car';

/** The AI boxes once its tyres are this far gone, with laps enough left to gain from it. */
export const PIT_WEAR = 0.6;
/** Braking into the box and pulling away, m/s². */
const BRAKING = 9;
const ACCEL = 6;
/** Metres from the entry to the box. */
const BOX_AT = PIT_ENTRY - PIT_BOX;
/** A car this close to the entry, on the track, goes in when it means to. */
const ENTRY_REACH = 8;

export interface PitState {
  phase: PitPhase;
  /** Metres from the entry along the lane. */
  d: number;
  speed: number;
  timer: number;
  /** The car's sideways offset at the entry, blended into the lane's. */
  from: number;
}

/** What the strategy reads about the race. */
export interface PitRace {
  phase: string;
  laps: number;
  cars: ReadonlyArray<{ lap: number; finished: boolean }>;
}

/**
 * Pit stops: a car that means to box goes onto rails at the lane's entry, drives the lane at
 * its limit, stops at the box for new tyres and repairs, and is handed back at the exit. The
 * AI boxes on its own once its tyres are gone; the player asks.
 */
export class Pits {
  readonly states: PitState[] = [];
  /** The lane's offset from the centre line (to the left of the driving direction). */
  readonly lateral: number;

  constructor(
    private readonly track: Track,
    count: number,
    private readonly ai: readonly boolean[],
  ) {
    this.lateral = -(track.halfWidth + PIT_OFFSET);
    for (let i = 0; i < count; i++) this.states.push(fresh());
  }

  /** A restart: nobody in the lane, nobody asking. */
  reset(cars: readonly Car[]): void {
    for (let i = 0; i < this.states.length; i++) {
      Object.assign(this.states[i]!, fresh());
      const car = cars[i];
      if (car) car.onRails = false;
    }
  }

  /** Box this lap (or not): only before the car has reached the lane. */
  arm(i: number, on: boolean): void {
    const st = this.states[i];
    if (!st) return;
    if (on && st.phase === 'none') st.phase = 'armed';
    else if (!on && st.phase === 'armed') st.phase = 'none';
  }

  onRails(i: number): boolean {
    const phase = this.states[i]?.phase;
    return phase === 'in' || phase === 'stop' || phase === 'out';
  }

  info(i: number): PitInfo {
    const st = this.states[i];
    return { phase: st?.phase ?? 'none', timer: st?.timer ?? 0 };
  }

  /** Every step, before the cars move: the strategy, the entry, and the drive down the lane. */
  update(dt: number, cars: readonly Car[], race: PitRace | null): void {
    const entry = this.track.length - PIT_ENTRY;
    for (let i = 0; i < this.states.length; i++) {
      const st = this.states[i]!;
      const car = cars[i];
      if (!car || car.retired) continue;
      const racing = race?.phase === 'racing' && race.cars[i]?.finished !== true;
      if (
        st.phase === 'none' &&
        racing &&
        this.ai[i] === true &&
        car.wearRate > 0 &&
        car.tyreWear > PIT_WEAR &&
        this.lapsLeft(race, i) >= 2
      ) {
        st.phase = 'armed';
      }
      if (st.phase === 'armed') {
        if (!racing) {
          st.phase = 'none';
          continue;
        }
        const p = this.track.project(car.pos.x, car.pos.z);
        const ahead = entry - p.s;
        if (ahead >= 0 && ahead < ENTRY_REACH && Math.abs(p.lateral) < this.track.halfWidth + 2) {
          st.phase = 'in';
          st.d = 0;
          st.speed = Math.max(Math.hypot(car.vel.x, car.vel.z), 5);
          st.from = p.lateral;
          car.onRails = true;
          this.pose(car, st, dt);
        }
        continue;
      }
      if (this.onRails(i)) this.ride(car, st, dt);
    }
  }

  private lapsLeft(race: PitRace | null, i: number): number {
    if (!race || race.laps <= 0) return 99;
    return race.laps - (race.cars[i]?.lap ?? 0);
  }

  private ride(car: Car, st: PitState, dt: number): void {
    if (st.phase === 'in') {
      // Down to the lane's limit, then down to a stop at the box.
      const left = BOX_AT - st.d;
      const limit = Math.min(PIT_SPEED, Math.sqrt(2 * BRAKING * Math.max(left, 0)));
      st.speed =
        st.speed > limit
          ? Math.max(limit, st.speed - BRAKING * dt)
          : Math.min(limit, st.speed + ACCEL * dt);
      st.d += st.speed * dt;
      if (left <= 0.3) {
        st.d = BOX_AT;
        st.speed = 0;
        st.phase = 'stop';
        st.timer = PIT_TIME;
      }
    } else if (st.phase === 'stop') {
      st.timer = Math.max(0, st.timer - dt);
      if (st.timer <= 0) {
        // New tyres, and the damage mended while they are at it.
        car.repair();
        st.phase = 'out';
      }
    } else {
      st.speed = Math.min(PIT_SPEED, st.speed + ACCEL * dt);
      st.d += st.speed * dt;
      if (st.d >= PIT_LENGTH) {
        st.d = PIT_LENGTH;
        st.phase = 'none';
        this.pose(car, st, dt);
        car.onRails = false;
        return;
      }
    }
    this.pose(car, st, dt);
  }

  /** Where the lane has the car `d` metres in: across from the track by the lane's share. */
  private pose(car: Car, st: PitState, dt: number): void {
    const p = this.track.at(this.track.length - PIT_ENTRY + st.d);
    const share = laneShare(st.d);
    const lat =
      st.d < PIT_BLEND ? st.from + (this.lateral - st.from) * share : this.lateral * share;
    car.rideRails(p.x - p.tz * lat, p.z + p.tx * lat, Math.atan2(-p.tx, -p.tz), st.speed, dt);
  }
}

const fresh = (): PitState => ({ phase: 'none', d: 0, speed: 0, timer: 0, from: 0 });
