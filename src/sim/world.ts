import { SPAWN, SPAWNS } from '../content/testGround';
import { TRACKS, trackById } from '../content/tracks';
import { mulberry32 } from '../shared/math';
import { afterDark, dayRate, sunElevationAt, wrapHour } from '../content/conditions';
import { cityHourOf } from '../content/city/day';
import {
  CAR_STRIDE,
  SOFT_FLOATS,
  defaultAids,
  neutralInput,
  type Difficulty,
  type DriverAids,
  type DriverInput,
  type HandlingMode,
  type SessionConfig,
  type SpawnPoint,
} from '../shared/protocol';
import { AiDriver, arcadePace } from './race/AiDriver';
import { resolveCarContacts } from './race/collisions';
import { RaceDirector } from './race/RaceDirector';
import { DEFAULT_LINE_OPTIONS, computeRacingLine, type RacingLineOptions } from './race/racingLine';
import { TestGround, type Surface } from './track/surface';
import { Track } from './track/Track';
import { festivalEvents, rampOf } from '../content/city/events';
import { cityMap } from '../content/city/map';
import { CitySurface } from './city/CitySurface';
import { Pedestrians } from './city/Pedestrians';
import { Police } from './city/Police';
import { Racers } from './city/Racers';
import { Traffic } from './city/Traffic';
import { Car, type Spawn } from './vehicle/car';
import { carById, peakPower, topSpeed } from './vehicle/cars';
import { TEST_MULE, type CarSpec } from './vehicle/spec';

/**
 * Racing line settings for a car, scaled from the ones tuned for the GT test car by grip,
 * downforce and power-to-weight, so the AI knows how fast each car can take a corner.
 */
export function lineOptionsFor(spec: CarSpec, calibration = 1, trackGrip = 1): RacingLineOptions {
  const d = DEFAULT_LINE_OPTIONS;
  const ref = TEST_MULE;
  const mu = (s: CarSpec) => (s.front.tyre.muY + s.rear.tyre.muY) / 2;
  const grip = mu(spec) / mu(ref);
  const aero = spec.aero.downforceArea / spec.mass / (ref.aero.downforceArea / ref.mass);
  const power = peakPower(spec) / spec.mass / (peakPower(ref) / ref.mass);
  const f = calibration;
  return {
    gripG: d.gripG * grip * f * trackGrip,
    downforce: d.downforce * aero * f * f,
    brake: d.brake * grip * f * trackGrip,
    accel: d.accel * Math.min(Math.max(power, 0.5), 1.6),
    topSpeed: topSpeed(spec) / 3.6,
  };
}

/** Share of the racing line's target speed each difficulty drives at. */
const SKILL: Record<Difficulty, number> = { easy: 0.86, medium: 0.92, hard: 0.965, expert: 0.995 };

/**
 * Everything that is simulated: the ground or circuit, the cars, the AI drivers and the race
 * rules. Pure logic, no DOM or rendering. Car 0 is the player.
 */
export class World {
  readonly surface: Surface;
  readonly cars: Car[];
  /** Messages for the main thread (e.g. a car was reset after invalid numbers). */
  readonly warnings: string[] = [];
  /** Set for race and time-trial sessions. */
  track: Track | null = null;
  director: RaceDirector | null = null;
  /** AI driver per car (null for the player). */
  drivers: Array<AiDriver | null> = [];
  /** Free roam: the traffic sharing the world, written after the cars in the snapshot. */
  traffic: Traffic | null = null;
  /** Free roam: the police, driving some of the traffic's slots. */
  police: Police | null = null;
  /** Free roam: the street racers for the festival's races (slots after the police). */
  racers: Racers | null = null;
  /** Free roam: the pedestrians on the pavements (after the cars in the snapshot). */
  pedestrians: Pedestrians | null = null;
  /** Free roam: the day's clock, hours, and its rate in hours per real second (null elsewhere). */
  day: { hour: number; rate: number } | null = null;
  private readonly neutral = neutralInput();
  /** Nearest track sample per car (a hint for projecting onto the track). */
  private readonly hints: number[] = [];
  private drsTimer = 0;

  constructor(
    playerCount = 1,
    surface: Surface = new TestGround(),
    spawn: Spawn = SPAWN,
    spec: CarSpec = TEST_MULE,
  ) {
    this.surface = surface;
    this.cars = [];
    for (let i = 0; i < Math.max(playerCount, 1); i++) {
      const at = { x: spawn.x + i * 6, z: spawn.z, yaw: spawn.yaw, y: spawn.y };
      this.cars.push(new Car(spec, at, surface));
      this.drivers.push(null);
    }
  }

  /** Builds the world for a session: the proving ground, or a circuit with a grid of AI cars. */
  static forSession(config: SessionConfig): World {
    const model = carById(config.carId);
    const spec = model.spec;
    if (config.mode === 'roam') {
      const surface = new CitySurface(cityMap());
      surface.gripScale = config.grip ?? 1;
      // The festival's jump ramps are part of the ground.
      for (const event of festivalEvents(surface.map)) {
        const ramp = rampOf(event);
        if (ramp) surface.ramps.push(ramp);
      }
      const spawn = config.roamSpawn ?? surface.map.spawns[config.roamStart ?? 'downtown'];
      const world = new World(1, surface, spawn, spec);
      world.setAids(0, config.aids);
      world.cars[0]!.damageScale = config.damage ?? 0;
      world.cars[0]!.enableSoftBody();
      // The day's clock starts at the spot's hour or the chosen time of day's, and runs at the
      // chosen rate; the headlights come on by themselves after dark (the switch still works).
      const hour = wrapHour(config.clock ?? cityHourOf(config.conditions?.time ?? 'track'));
      world.day = { hour, rate: dayRate(config.dayCycle ?? 0) };
      const dark = afterDark(sunElevationAt(hour));
      if (dark) world.cars[0]!.headlights = true;
      const police = config.police ?? 0;
      const racers = config.racers ?? 0;
      if ((config.traffic ?? 0) + police + racers > 0) {
        world.traffic = new Traffic(
          surface.map,
          config.traffic ?? 0,
          police,
          config.seed,
          dark,
          racers,
        );
        if (police > 0) world.police = new Police(world.traffic, surface.map);
        if (racers > 0) world.racers = new Racers(world.traffic, surface.map);
      }
      if ((config.pedestrians ?? 0) > 0) {
        world.pedestrians = new Pedestrians(surface.map, config.pedestrians!, config.seed);
        if (world.traffic) world.traffic.pedestrians = world.pedestrians;
      }
      return world;
    }
    if (config.mode === 'free' || !config.trackId) {
      const world = new World(1, new TestGround(), SPAWNS[config.location], spec);
      world.setAids(0, config.aids);
      return world;
    }
    const def = trackById(config.trackId) ?? TRACKS[0]!;
    const track = new Track(def);
    track.gripScale = config.grip ?? 1;
    const count = config.mode === 'race' ? Math.max(config.opponents, 0) + 1 : 1;
    const world = new World(count, track, track.gridSlot(0), spec);
    world.track = track;
    // Mixed fields: each car gets its own model (the player's is car 0).
    const models = world.cars.map((_, i) => carById(config.fieldCars?.[i] ?? config.carId));
    models.forEach((m, i) => {
      if (m.id !== model.id) world.cars[i] = new Car(m.spec, track.gridSlot(i), track);
    });
    world.setAids(0, config.aids);
    // One racing line per model in the race (they take a moment each to plan).
    const lines = new Map<string, ReturnType<typeof computeRacingLine>>();
    const lineFor = (m: typeof model) => {
      let line = lines.get(m.id);
      if (!line) {
        line = computeRacingLine(track, lineOptionsFor(m.spec, m.aiGrip, track.gripScale));
        lines.set(m.id, line);
      }
      return line;
    };
    const rand = mulberry32(config.seed);
    for (let i = config.attract ? 0 : 1; i < count; i++) {
      const skill = SKILL[config.difficulty] * (0.985 + rand() * 0.03);
      world.drivers[i] = new AiDriver(track, lineFor(models[i]!), {
        skill,
        seed: config.seed + i * 7919,
      });
      world.cars[i]!.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high', abs: 'high' });
      world.cars[i]!.autoHybrid = true;
    }
    for (const car of world.cars) car.damageScale = config.damage ?? 0;
    const laps = config.mode === 'race' ? config.laps : 0;
    world.director = new RaceDirector(track, count, config.mode, laps, config.seed);
    world.director.restart(world.cars, Math.min(config.gridSlot, count - 1));
    return world;
  }

  setInputs(inputs: readonly DriverInput[]): void {
    // Only human drivers take input from the main thread; AI drivers steer themselves.
    for (let i = 0; i < this.cars.length; i++) {
      if (!this.drivers[i]) this.cars[i]!.setInput(inputs[i] ?? this.neutral);
    }
  }

  setAids(car: number, aids: DriverAids): void {
    this.cars[car]?.setAids(aids);
  }

  /** Sim or arcade handling, for every car (the AI drives the same physics as the player). */
  setHandling(mode: HandlingMode): void {
    for (const car of this.cars) car.arcade = mode === 'arcade';
  }

  teleport(car: number, to: SpawnPoint): void {
    const spawn = SPAWNS[to];
    this.cars[car]?.teleport({ x: spawn.x + car * 6, z: spawn.z, yaw: spawn.yaw });
  }

  /** Puts a car back on the track (circuits: on the centre line where it left it). */
  resetCar(index: number): void {
    const car = this.cars[index];
    if (!car) return;
    const track = this.track;
    if (!track) {
      car.reset();
      return;
    }
    const pr = track.project(car.pos.x, car.pos.z);
    const p = track.at(pr.s);
    car.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
  }

  restartSession(playerSlot: number): void {
    for (const car of this.cars) car.repair();
    this.director?.restart(this.cars, playerSlot);
    if (!this.director) this.cars[0]?.reset();
  }

  storePrevious(): void {
    for (const car of this.cars) car.storePrevious();
    this.traffic?.storePrevious();
  }

  step(dt: number): void {
    const cars = this.cars;
    const director = this.director;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      const ai = this.drivers[i];
      if (ai) {
        car.setInput(ai.drive(car, cars, dt));
        if (ai.needsReset) {
          this.resetCar(i);
          ai.needsReset = false;
        }
      }
      car.holdForStart =
        (director?.holding(i) ?? false) || (i === 0 && this.racers?.holding === true);
      car.step(dt, this.surface);
      if (!car.isFinite()) {
        // Never let invalid numbers reach the renderer. This is a bug if it ever happens.
        car.reset();
        this.warnings.push('Physics produced invalid numbers; the car was reset.');
      }
    }
    if (cars.length > 1) resolveCarContacts(cars);
    this.tickDay(dt);
    this.traffic?.step(dt, cars[0]!);
    this.police?.step(dt, cars[0]!);
    this.racers?.step(dt, cars[0]!);
    this.pedestrians?.step(dt, cars[0]!, this.traffic);
    director?.update(dt, cars);
    this.rubberBand();
    this.drsTimer -= dt;
    if (this.drsTimer <= 0) {
      this.drsTimer = 0.02;
      this.updateDrs();
    }
  }

  /**
   * Free roam: the day's clock runs; when dusk falls the headlights come on (the player's and
   * the traffic's) and at dawn they go off, once each, so the switch still works in between.
   */
  private tickDay(dt: number): void {
    const day = this.day;
    if (!day || day.rate <= 0) return;
    const wasDark = afterDark(sunElevationAt(day.hour));
    day.hour = wrapHour(day.hour + dt * day.rate);
    const dark = afterDark(sunElevationAt(day.hour));
    if (dark === wasDark) return;
    this.cars[0]!.headlights = dark;
    if (this.traffic) this.traffic.lightsOn = dark;
  }

  /**
   * Arcade races: each rival's pace bends towards the player's position, so the race stays a
   * race whoever is faster (sim races keep their honest pace). Runs every step, after the
   * director has measured the field.
   */
  rubberBand(): void {
    const status = this.director?.status;
    const player = this.cars[0];
    if (!status || !player?.arcade || status.mode !== 'race' || this.drivers[0]) return;
    const mine = status.cars[0]?.progress ?? 0;
    for (let i = 1; i < this.drivers.length; i++) {
      const ai = this.drivers[i];
      if (!ai) continue;
      const theirs = status.cars[i]?.progress ?? mine;
      ai.paceScale = status.phase === 'racing' ? arcadePace(mine - theirs) : 1;
    }
  }

  /**
   * DRS is allowed in a zone; in a race only from the second lap and within a second of the car
   * ahead (measured at the timing points).
   */
  private updateDrs(): void {
    const track = this.track;
    if (!track) return;
    const status = this.director?.status;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i]!;
      if (!car.spec.hybrid) continue;
      const pr = track.project(car.pos.x, car.pos.z, this.hints[i] ?? -1);
      this.hints[i] = pr.index;
      let allowed = track.inDrsZone(pr.s);
      if (allowed && status?.mode === 'race') {
        const me = status.cars[i];
        const ahead = me ? status.cars[status.order[me.position - 2] ?? -1] : undefined;
        allowed =
          status.phase === 'racing' &&
          me !== undefined &&
          me.lap >= 1 &&
          ahead !== undefined &&
          me.gapToLeader - ahead.gapToLeader < 1;
      }
      car.drsAllowed = allowed;
    }
  }

  /** Cars in the snapshot: the physics cars, then the traffic slots. */
  get snapshotCount(): number {
    return this.cars.length + (this.traffic?.count ?? 0);
  }

  writeSnapshot(out: Float32Array): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i]!.writeSnapshot(out, i * CAR_STRIDE);
    this.traffic?.writeSnapshot(out, this.cars.length);
    // The player's soft body, after every car (zeros when there is none).
    const base = this.snapshotCount * CAR_STRIDE;
    const soft = this.cars[0]?.soft;
    if (soft) soft.writeSnapshot(out, base);
    else out.fill(0, base, base + SOFT_FLOATS);
    // The pedestrians, after that.
    this.pedestrians?.writeSnapshot(out, base + SOFT_FLOATS);
  }

  /** Pedestrian slots in the snapshot. */
  get pedestrianCount(): number {
    return this.pedestrians?.count ?? 0;
  }
}
