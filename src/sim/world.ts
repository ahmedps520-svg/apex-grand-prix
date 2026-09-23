import { SPAWN, SPAWNS } from '../content/testGround';
import { TRACKS, trackById } from '../content/tracks';
import { mulberry32 } from '../shared/math';
import {
  CAR_STRIDE,
  defaultAids,
  neutralInput,
  type Difficulty,
  type DriverAids,
  type DriverInput,
  type SessionConfig,
  type SpawnPoint,
} from '../shared/protocol';
import { AiDriver } from './race/AiDriver';
import { resolveCarContacts } from './race/collisions';
import { RaceDirector } from './race/RaceDirector';
import { DEFAULT_LINE_OPTIONS, computeRacingLine, type RacingLineOptions } from './race/racingLine';
import { TestGround, type Surface } from './track/surface';
import { Track } from './track/Track';
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
  private readonly neutral = neutralInput();

  constructor(
    playerCount = 1,
    surface: Surface = new TestGround(),
    spawn: Spawn = SPAWN,
    spec: CarSpec = TEST_MULE,
  ) {
    this.surface = surface;
    this.cars = [];
    for (let i = 0; i < Math.max(playerCount, 1); i++) {
      const at = { x: spawn.x + i * 6, z: spawn.z, yaw: spawn.yaw };
      this.cars.push(new Car(spec, at, surface));
      this.drivers.push(null);
    }
  }

  /** Builds the world for a session: the proving ground, or a circuit with a grid of AI cars. */
  static forSession(config: SessionConfig): World {
    const model = carById(config.carId);
    const spec = model.spec;
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
    world.setAids(0, config.aids);
    const line = computeRacingLine(track, lineOptionsFor(spec, model.aiGrip, track.gripScale));
    const rand = mulberry32(config.seed);
    for (let i = config.attract ? 0 : 1; i < count; i++) {
      const skill = SKILL[config.difficulty] * (0.985 + rand() * 0.03);
      world.drivers[i] = new AiDriver(track, line, { skill, seed: config.seed + i * 7919 });
      world.cars[i]!.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high', abs: 'high' });
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
      car.holdForStart = director?.holding(i) ?? false;
      car.step(dt, this.surface);
      if (!car.isFinite()) {
        // Never let invalid numbers reach the renderer. This is a bug if it ever happens.
        car.reset();
        this.warnings.push('Physics produced invalid numbers; the car was reset.');
      }
    }
    if (cars.length > 1) resolveCarContacts(cars);
    director?.update(dt, cars);
  }

  writeSnapshot(out: Float32Array): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i]!.writeSnapshot(out, i * CAR_STRIDE);
  }
}
