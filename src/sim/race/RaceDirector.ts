import { mulberry32 } from '../../shared/math';
import { SURFACE } from '../track/surface';
import type { Track } from '../track/Track';
import type { Car } from '../vehicle/car';
import { projectNear, trackPos, wrapDelta, type TrackPos } from './trackPos';

export type RaceMode = 'race' | 'timeTrial' | 'free';
export type RacePhase = 'grid' | 'countdown' | 'racing' | 'finished';
/**
 * What a car is shown: a blue flag (let the lapping car by), a yellow (a car stopped ahead) or
 * the safety car board (hold station behind it).
 */
export type RaceFlag = 'none' | 'blue' | 'yellow' | 'safety';
/** What a penalty was for. */
export type PenaltyReason = 'none' | 'limits' | 'safetyCar';

/** The safety car: in its box, out leading the field, or coming in this lap. */
export interface SafetyCarStatus {
  phase: 'none' | 'out' | 'in';
  /** Laps led since it came out. */
  laps: number;
  /** Times out this race. */
  deployments: number;
}

/** One car's race and timing state. Times are seconds; 0 means "none yet". */
export interface CarRaceState {
  /** Laps completed. */
  lap: number;
  /** Race position, 1 = leading. */
  position: number;
  /** Laps done + s/length (negative while still behind the line before the first lap). */
  progress: number;
  lastLap: number;
  bestLap: number;
  /** Time on the lap being driven (0 until timing starts). */
  currentLap: number;
  finished: boolean;
  /** Race clock when the car took the flag (or was put out). */
  finishTime: number;
  /** Elimination race: put out as the last car when the clock ran down. */
  eliminated: boolean;
  /** Sector being driven: 0, 1 or 2 (three equal lengths of the lap). */
  sector: number;
  /** Latest time for each sector. */
  sectorTimes: number[];
  bestSectors: number[];
  /** Time behind the leader at the last timing point passed (0 for the leader). */
  gapToLeader: number;
  /** Race rules: track-limit warnings, the seconds of penalty they added, and the flag shown. */
  warnings: number;
  penalty: number;
  flag: RaceFlag;
  /** What the last penalty was for. */
  penaltyFor: PenaltyReason;
}

/** Everything the HUD needs about the session, updated in place every step. */
export interface RaceStatus {
  mode: RaceMode;
  phase: RacePhase;
  /** Red start lights lit, 0–5. */
  lights: number;
  /** True from lights out. */
  go: boolean;
  /** Race distance in laps (0 = unlimited). */
  laps: number;
  /** Race clock: seconds since the start (time trial / free: since the session began). */
  time: number;
  cars: CarRaceState[];
  /** Car indices by position. */
  order: number[];
  /** Elimination race: seconds between eliminations, seconds to the next, and cars put out. */
  elimination: { every: number; next: number; out: number } | null;
  /** A qualifying session: positions by best lap, and every car runs its own laps. */
  qualifying: boolean;
  /** Race rules on: track limits enforced, flags shown. */
  rules: boolean;
  /** The sector under a yellow flag (a car stopped in it), or -1. */
  yellow: number;
  /** The safety car, when the session has one. */
  safetyCar: SafetyCarStatus | null;
}

/** Seconds on the grid before the first red light. */
const GRID_TIME = 2;
/** Timing points per lap for the gaps between cars. */
const GAP_POINTS = 16;
/** A car that moves further than this in one step was teleported (reset or restart). */
const JUMP = 30;
/** After the player finishes, the session ends this long after (unless everyone is in). */
const COOL_DOWN = 60;
/** Qualifying: after the player's laps, the rest get this long to finish theirs. */
const QUALIFYING_COOL_DOWN = 20;
/** Time trial: the car starts this far before the line on a flying lap. */
const RUN_UP = 150;
/**
 * Track limits: all four wheels off the road and the kerbs for this far (but no further, and
 * never slowly: that is a crash, and its own punishment) is a cut; every third cut is a penalty.
 */
const CUT_METRES = 12;
const CUT_MAX_METRES = 90;
const CUT_MIN_SPEED = 10;
const WARNINGS_PER_PENALTY = 3;
const PENALTY_SECONDS = 3;
/** A car this slow on the track for this long puts its sector under a yellow. */
const YELLOW_SPEED = 4;
const YELLOW_AFTER = 2;
/** A lapping car this close behind shows a blue flag. */
const BLUE_DISTANCE = 30;

interface Tracker {
  pos: TrackPos;
  lastX: number;
  lastZ: number;
  /** Passed half distance since the last counted crossing: the next crossing completes a lap. */
  armed: boolean;
  /** The lap clock is running. */
  timing: boolean;
  lapStart: number;
  sectorStart: number;
  /** Highest timing point passed (lap × GAP_POINTS + point). */
  point: number;
  /** Track limits: metres of the excursion under way, and whether it slowed to a crash. */
  offMetres: number;
  offSlow: boolean;
  /** Seconds stopped on the track (a yellow after a while). */
  slowFor: number;
}

/**
 * Race rules and timing: the start countdown, lap counting and timing (to a fraction of a step)
 * with three sectors, positions, gaps and the finish. Car 0 is the player.
 */
export class RaceDirector {
  readonly status: RaceStatus;
  private readonly trackers: Tracker[] = [];
  private readonly rand: () => number;
  private countdown = 0;
  private startDelay = 1;
  private leaderFinished = false;
  private playerFinishedAt = -1;
  /** Race clock when the leader first passed each timing point. */
  private readonly pointTimes: number[] = [];
  /** Sort keys for positions. */
  private readonly keys: Float64Array;

  constructor(
    private readonly track: Track,
    carCount: number,
    mode: RaceMode,
    laps: number,
    seed = 1,
    elimination = 0,
    qualifying = false,
    rules = false,
  ) {
    this.rand = mulberry32(seed ^ 0x51f15e);
    this.status = {
      mode,
      phase: mode === 'race' ? 'grid' : 'racing',
      lights: 0,
      go: mode !== 'race',
      laps: mode === 'race' ? Math.max(laps, 1) : Math.max(laps, 0),
      time: 0,
      cars: [],
      order: [],
      elimination:
        mode === 'race' && elimination > 0 && !qualifying
          ? { every: elimination, next: elimination, out: 0 }
          : null,
      qualifying: mode === 'race' && qualifying,
      rules: mode === 'race' && rules,
      yellow: -1,
      safetyCar: null,
    };
    for (let i = 0; i < carCount; i++) {
      this.status.cars.push(freshState());
      this.status.order.push(i);
      this.trackers.push(freshTracker());
    }
    this.keys = new Float64Array(carCount);
  }

  /** True while cars must be held on the grid (before the lights go out). */
  holding(carIndex: number): boolean {
    const phase = this.status.phase;
    return (
      this.status.mode === 'race' &&
      carIndex < this.trackers.length &&
      (phase === 'grid' || phase === 'countdown')
    );
  }

  /**
   * Puts all cars on the grid (player in slot `playerSlot`, the others in order, or every car
   * in its place in `gridOrder`, a qualifying's grid) and restarts the countdown. Time trial:
   * the player starts a run-up before the line.
   */
  restart(cars: readonly Car[], playerSlot: number, gridOrder?: readonly number[]): void {
    const status = this.status;
    const track = this.track;
    const race = status.mode === 'race';
    const slot = Math.max(0, Math.min(playerSlot, cars.length - 1));
    const byOrder =
      gridOrder && gridOrder.length === cars.length && cars.every((_, i) => gridOrder.includes(i))
        ? gridOrder
        : null;
    let next = 0;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      if (status.mode === 'timeTrial') {
        const p = track.at(track.length - RUN_UP - i * 30);
        car.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
      } else {
        let gridSlot = slot;
        if (byOrder) gridSlot = byOrder.indexOf(i);
        else if (i > 0) {
          if (next === slot) next++;
          gridSlot = next++;
        }
        car.teleport(track.gridSlot(gridSlot));
      }
    }
    status.phase = race ? 'grid' : 'racing';
    status.go = !race;
    status.lights = 0;
    status.time = 0;
    this.countdown = 0;
    this.startDelay = 0.4 + this.rand();
    this.leaderFinished = false;
    this.playerFinishedAt = -1;
    this.pointTimes.length = 0;
    if (status.elimination) {
      status.elimination.next = status.elimination.every;
      status.elimination.out = 0;
    }
    status.yellow = -1;
    for (let i = 0; i < this.trackers.length; i++) {
      Object.assign(this.status.cars[i]!, freshState());
      this.status.cars[i]!.position = i + 1;
      Object.assign(this.trackers[i]!, freshTracker());
    }
    this.project(cars, true);
    this.updateOrder();
  }

  /** Call every sim step after the cars moved. */
  /** While true, the cars wait on the grid and the lights don't start (the title screen). */
  holdGrid = false;

  update(dt: number, cars: readonly Car[]): void {
    const status = this.status;
    if (status.phase === 'grid' || status.phase === 'countdown') {
      if (this.holdGrid) {
        this.countdown = 0;
        status.phase = 'grid';
        status.lights = 0;
        this.project(cars, false);
        return;
      }
      this.countdown += dt;
      const lit = this.countdown - GRID_TIME;
      if (lit < 0) {
        status.phase = 'grid';
      } else if (lit < 4 + this.startDelay) {
        status.phase = 'countdown';
        status.lights = Math.min(Math.floor(lit) + 1, 5);
      } else {
        // Lights out: the race clock and every car's first lap start now.
        status.phase = 'racing';
        status.go = true;
        status.lights = 0;
        status.time = 0;
        for (const t of this.trackers) {
          t.timing = true;
          t.lapStart = 0;
          t.sectorStart = 0;
        }
      }
      this.project(cars, false);
      this.updateOrder();
      return;
    }

    const start = status.time;
    status.time += dt;
    const n = Math.min(cars.length, this.trackers.length);
    for (let i = 0; i < n; i++) this.advance(i, cars[i]!, start, dt);
    if (status.rules && status.phase === 'racing') this.enforce(cars, dt);
    this.updateOrder();

    if (status.mode === 'race' && status.phase === 'racing') {
      this.eliminate(dt);
      const player = status.cars[0];
      if (player?.finished && this.playerFinishedAt < 0) this.playerFinishedAt = status.time;
      let all = true;
      for (let i = 0; i < n; i++) all &&= status.cars[i]!.finished;
      const coolDown = status.qualifying ? QUALIFYING_COOL_DOWN : COOL_DOWN;
      if (all || (this.playerFinishedAt >= 0 && status.time - this.playerFinishedAt > coolDown)) {
        status.phase = 'finished';
      }
    }
  }

  /**
   * Elimination race: the clock runs down; at zero the last car still running is out (finished
   * where it stands, ranked below the rest by when it went), and when one car is left it has won.
   */
  private eliminate(dt: number): void {
    const status = this.status;
    const elim = status.elimination;
    if (!elim) return;
    const running = status.order.filter((i) => !status.cars[i]!.finished);
    if (running.length <= 1) {
      if (running.length === 1) this.finishHere(running[0]!, false);
      return;
    }
    elim.next -= dt;
    if (elim.next > 0) return;
    elim.next = elim.every;
    elim.out++;
    this.finishHere(running[running.length - 1]!, true);
    if (running.length === 2) this.finishHere(running[0]!, false);
  }

  /**
   * Race rules. Track limits: an excursion with all four wheels off the road and the kerbs is a
   * cut when it is short and quick (a warning, a penalty every third). A car stopped on the track
   * puts its sector under a yellow, and a car about to be lapped is shown a blue.
   */
  private enforce(cars: readonly Car[], dt: number): void {
    const status = this.status;
    const n = Math.min(cars.length, this.trackers.length);
    let yellow = -1;
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      const t = this.trackers[i]!;
      const state = status.cars[i]!;
      state.flag = 'none';
      if (state.finished || car.retired || car.onRails) {
        t.offMetres = 0;
        t.slowFor = 0;
        continue;
      }
      const speed = Math.hypot(car.vel.x, car.vel.z);
      const off = car.wheels.every(
        (w) => w.surface !== SURFACE.ASPHALT && w.surface !== SURFACE.KERB,
      );
      if (off) {
        t.offMetres += speed * dt;
        if (speed < CUT_MIN_SPEED) t.offSlow = true;
      } else {
        if (t.offMetres >= CUT_METRES && t.offMetres <= CUT_MAX_METRES && !t.offSlow) {
          state.warnings++;
          if (state.warnings % WARNINGS_PER_PENALTY === 0) {
            state.penalty += PENALTY_SECONDS;
            state.penaltyFor = 'limits';
          }
        }
        t.offMetres = 0;
        t.offSlow = false;
      }
      if (!off && speed < YELLOW_SPEED) {
        t.slowFor += dt;
        if (t.slowFor > YELLOW_AFTER) yellow = state.sector;
      } else {
        t.slowFor = 0;
      }
    }
    status.yellow = yellow;
    for (let i = 0; i < n; i++) {
      const state = status.cars[i]!;
      if (state.finished || cars[i]!.retired || cars[i]!.onRails) continue;
      if (yellow >= 0 && state.sector === yellow && this.trackers[i]!.slowFor <= YELLOW_AFTER) {
        state.flag = 'yellow';
      }
    }
    // Blue flags: a car a lap or more up, close behind.
    const length = this.track.length;
    for (let j = 0; j < n; j++) {
      const slow = status.cars[j]!;
      if (slow.finished || slow.flag !== 'none') continue;
      for (let i = 0; i < n; i++) {
        if (i === j) continue;
        const fast = status.cars[i]!;
        if (fast.finished || fast.lap - slow.lap < 1) continue;
        const behind = wrapDelta(this.trackers[j]!.pos.s - this.trackers[i]!.pos.s, length);
        if (behind > 0 && behind < BLUE_DISTANCE) {
          slow.flag = 'blue';
          break;
        }
      }
    }
    // Under the safety car every car on the track is shown it, over a yellow or a blue.
    if (status.safetyCar && status.safetyCar.phase !== 'none') {
      for (let i = 0; i < n; i++) {
        const state = status.cars[i]!;
        if (!state.finished && !cars[i]!.retired && !cars[i]!.onRails) state.flag = 'safety';
      }
    }
  }

  /** Ends a car's race where it stands: put out, or the winner of an elimination race. */
  private finishHere(i: number, out: boolean): void {
    const state = this.status.cars[i]!;
    state.finished = true;
    state.eliminated = out;
    state.finishTime = this.status.time + state.penalty;
    state.currentLap = 0;
    if (!out) this.leaderFinished = true;
    if (i === 0 && this.playerFinishedAt < 0) this.playerFinishedAt = this.status.time;
  }

  /** Projects every car onto the track (fresh lookups when `reset`). */
  private project(cars: readonly Car[], reset: boolean): void {
    const n = Math.min(cars.length, this.trackers.length);
    for (let i = 0; i < n; i++) {
      const car = cars[i]!;
      const t = this.trackers[i]!;
      projectNear(this.track, car.pos.x, car.pos.z, reset ? -1 : t.pos.index, t.pos);
      t.lastX = car.pos.x;
      t.lastZ = car.pos.z;
      this.status.cars[i]!.progress = progressOf(t, this.status.cars[i]!.lap, this.track.length);
    }
  }

  /** Lap, sector and gap bookkeeping for one car after a step that began at race time `t0`. */
  private advance(i: number, car: Car, t0: number, dt: number): void {
    const track = this.track;
    const length = track.length;
    const t = this.trackers[i]!;
    const state = this.status.cars[i]!;
    const jumped = Math.hypot(car.pos.x - t.lastX, car.pos.z - t.lastZ) > JUMP;
    const s0 = t.pos.s;
    projectNear(track, car.pos.x, car.pos.z, jumped ? -1 : t.pos.index, t.pos);
    t.lastX = car.pos.x;
    t.lastZ = car.pos.z;
    const s1 = t.pos.s;
    if (t.timing) state.currentLap = t0 + dt - t.lapStart;
    if (jumped || state.finished) {
      if (!state.finished) state.progress = progressOf(t, state.lap, length);
      return;
    }
    const ds = wrapDelta(s1 - s0, length);
    if (ds > 0) {
      if (s1 < s0) {
        // Crossed the start/finish line forwards.
        const crossing = crossTime(s0, ds, 0, length, t0, dt);
        if (t.armed) this.completeLap(i, t, state, crossing);
        else if (!t.timing) {
          // Flying lap (time trial, free): the clock starts at the first crossing.
          t.timing = true;
          t.lapStart = crossing;
          t.sectorStart = crossing;
          state.sector = 0;
        }
      }
      if (t.timing && !state.finished) {
        for (let k = 1; k <= 2; k++) {
          const boundary = (length * k) / 3;
          if (state.sector === k - 1 && passed(s0, s1, boundary)) {
            const crossing = crossTime(s0, ds, boundary, length, t0, dt);
            recordSector(state, k - 1, crossing - t.sectorStart);
            t.sectorStart = crossing;
            state.sector = k;
          }
        }
      }
      if (passed(s0, s1, length / 2)) t.armed = true;
    }
    if (!state.finished) state.progress = progressOf(t, state.lap, length);
    this.updateGap(t, state, t0, dt);
  }

  private completeLap(i: number, t: Tracker, state: CarRaceState, crossing: number): void {
    const status = this.status;
    const lapTime = crossing - t.lapStart;
    state.lap++;
    state.lastLap = lapTime;
    if (state.bestLap <= 0 || lapTime < state.bestLap) state.bestLap = lapTime;
    if (state.sector === 2) recordSector(state, 2, crossing - t.sectorStart);
    state.sector = 0;
    state.currentLap = status.time - crossing;
    t.lapStart = crossing;
    t.sectorStart = crossing;
    t.armed = false;
    if (status.mode !== 'race') return;
    // The flag comes out for everyone once the leader has taken it; in a qualifying each car
    // runs its own laps.
    if ((this.leaderFinished && !status.qualifying) || state.lap >= status.laps) {
      this.leaderFinished = true;
      state.finished = true;
      // The flag, plus any penalty the race rules added.
      state.finishTime = crossing + state.penalty;
      state.progress = state.lap;
      state.currentLap = 0;
      if (i === 0 && this.playerFinishedAt < 0) this.playerFinishedAt = crossing;
    }
  }

  /** Gap to the leader from the race time each car passes a set of timing points. */
  private updateGap(t: Tracker, state: CarRaceState, t0: number, dt: number): void {
    if (this.status.mode !== 'race') return;
    const reached = Math.floor(state.progress * GAP_POINTS);
    if (reached <= t.point) return;
    t.point = reached;
    if (reached < 0) return;
    const time = t0 + dt;
    const first = this.pointTimes[reached];
    if (first === undefined) {
      // First car here: it leads. (Points can be skipped by a reset; fill them in.)
      for (let p = this.pointTimes.length; p <= reached; p++) this.pointTimes[p] = time;
      state.gapToLeader = 0;
    } else {
      state.gapToLeader = time - first;
    }
  }

  /**
   * Positions: finished cars by laps then finish time, the rest by progress. Qualifying: by
   * best lap, the cars without one below them by progress.
   */
  private updateOrder(): void {
    const { cars, order, qualifying } = this.status;
    const keys = this.keys;
    for (let i = 0; i < cars.length; i++) {
      const c = cars[i]!;
      // Cars put out rank below everyone, the last out highest.
      keys[i] = c.eliminated
        ? -1000 + c.finishTime
        : qualifying
          ? c.bestLap > 0
            ? 1e6 - c.bestLap
            : c.progress
          : c.finished
            ? c.lap
            : c.progress;
    }
    // Insertion sort: the order barely changes from one step to the next.
    for (let a = 1; a < order.length; a++) {
      const car = order[a]!;
      let b = a - 1;
      while (b >= 0 && ahead(cars, keys, car, order[b]!)) {
        order[b + 1] = order[b]!;
        b--;
      }
      order[b + 1] = car;
    }
    for (let p = 0; p < order.length; p++) cars[order[p]!]!.position = p + 1;
  }
}

/** Is car `a` ahead of car `b`? */
function ahead(cars: CarRaceState[], keys: Float64Array, a: number, b: number): boolean {
  const ka = keys[a]!;
  const kb = keys[b]!;
  if (ka !== kb) return ka > kb;
  const ca = cars[a]!;
  const cb = cars[b]!;
  if (ca.finished !== cb.finished) return ca.finished;
  if (ca.finished) return ca.finishTime < cb.finishTime;
  return a < b;
}

/** Race time at which a car that moved `ds` forwards from `s0` during the step passed `at`. */
function crossTime(
  s0: number,
  ds: number,
  at: number,
  length: number,
  t0: number,
  dt: number,
): number {
  const into = wrapDelta(at - s0, length);
  return t0 + dt * Math.min(Math.max(into / ds, 0), 1);
}

/** Did the car pass distance `at` going forwards from s0 to s1 (no line crossing)? */
function passed(s0: number, s1: number, at: number): boolean {
  return s0 < at && s1 >= at && s1 > s0;
}

function progressOf(t: Tracker, lap: number, length: number): number {
  // Behind the line without having done the lap (grid, run-up, or backwards over the line).
  const behind = !t.armed && t.pos.s > length / 2;
  return lap + t.pos.s / length - (behind ? 1 : 0);
}

function recordSector(state: CarRaceState, sector: number, time: number): void {
  state.sectorTimes[sector] = time;
  const best = state.bestSectors[sector] ?? 0;
  if (best <= 0 || time < best) state.bestSectors[sector] = time;
}

const freshState = (): CarRaceState => ({
  lap: 0,
  position: 1,
  progress: 0,
  lastLap: 0,
  bestLap: 0,
  currentLap: 0,
  finished: false,
  finishTime: 0,
  eliminated: false,
  sector: 0,
  sectorTimes: [0, 0, 0],
  bestSectors: [0, 0, 0],
  gapToLeader: 0,
  warnings: 0,
  penalty: 0,
  flag: 'none',
  penaltyFor: 'none',
});

const freshTracker = (): Tracker => ({
  pos: trackPos(),
  lastX: 0,
  lastZ: 0,
  armed: false,
  timing: false,
  lapStart: 0,
  sectorStart: 0,
  point: -1_000_000,
  offMetres: 0,
  offSlow: false,
  slowFor: 0,
});
