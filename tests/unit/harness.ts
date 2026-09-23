import { mulberry32 } from '../../src/shared/math';
import {
  SIM_DT,
  defaultAids,
  neutralInput,
  type DriverAids,
  type DriverInput,
} from '../../src/shared/protocol';
import { TestGround, type Surface } from '../../src/sim/track/surface';
import type { Car, Spawn } from '../../src/sim/vehicle/car';
import { World } from '../../src/sim/world';

/**
 * Test rig for the vehicle model: runs a world step by step with scripted drivers and
 * measures the benchmarks in PLAN.md.
 */

export const G = 9.81;

/** A world with asphalt everywhere, so long runs never leave the pad. */
export function openWorld(
  aids: Partial<DriverAids> = {},
  surface: Surface = new TestGround(1e7, 1e7),
  spawn: Spawn = { x: 0, z: 0, yaw: 0 },
): World {
  const world = new World(1, surface, spawn);
  world.setAids(0, { ...defaultAids(), ...aids });
  return world;
}

export type Driver = (t: number, car: Car) => Partial<DriverInput>;

/**
 * Steps the world for up to `seconds`, asking `driver` for controls every step. Stops early
 * when `until` returns true. Returns the simulated time.
 */
export function run(
  world: World,
  seconds: number,
  driver: Driver,
  until?: (t: number, car: Car) => boolean,
): number {
  const car = world.cars[0]!;
  const steps = Math.round(seconds / SIM_DT);
  const frame = neutralInput();
  for (let i = 0; i < steps; i++) {
    const t = i * SIM_DT;
    if (until?.(t, car)) return t;
    Object.assign(frame, neutralInput(), driver(t, car));
    world.setInputs([frame]);
    world.step(SIM_DT);
  }
  return seconds;
}

export const kmh = (car: Car): number => car.forwardSpeed() * 3.6;

/** Yaw of the car's nose (0 = facing -z, positive = turned left). */
export function heading(car: Car): number {
  const q = car.rot;
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.atan2(-fx, -fz);
}

export interface LaunchResult {
  t100: number;
  t200: number;
  /** Speed after 60 s flat out, km/h. */
  top: number;
  /** Largest sideways drift from the start line, metres. */
  drift: number;
}

/** Standing start at full throttle (or the given throttle schedule). */
export function launch(
  aids: Partial<DriverAids> = {},
  throttle: (t: number) => number = () => 1,
  seconds = 60,
): LaunchResult {
  const world = openWorld(aids);
  const car = world.cars[0]!;
  let t100 = Infinity;
  let t200 = Infinity;
  let drift = 0;
  run(world, seconds, (t, c) => {
    const v = kmh(c);
    if (t100 === Infinity && v >= 100) t100 = t;
    if (t200 === Infinity && v >= 200) t200 = t;
    drift = Math.max(drift, Math.abs(c.pos.x));
    return { throttle: throttle(t) };
  });
  return { t100, t200, top: kmh(car), drift };
}

/** Accelerates to `fromKmh`, then brakes fully. Returns the stopping distance and drift. */
export function brakeTest(
  fromKmh: number,
  aids: Partial<DriverAids> = {},
): { distance: number; drift: number; time: number } {
  const world = openWorld(aids);
  const car = world.cars[0]!;
  run(
    world,
    30,
    () => ({ throttle: 1 }),
    (_t, c) => kmh(c) >= fromKmh,
  );
  const z0 = car.pos.z;
  const x0 = car.pos.x;
  const time = run(
    world,
    15,
    () => ({ brake: 1 }),
    (_t, c) => c.forwardSpeed() < 0.05,
  );
  return { distance: z0 - car.pos.z, drift: Math.abs(car.pos.x - x0), time };
}

export interface SkidpadSample {
  /** Lateral acceleration, g. */
  g: number;
  /** Average front road-wheel angle, radians (+ = right). */
  steer: number;
  /** Distance from the circle's centre minus the target radius, metres. */
  error: number;
  speed: number;
}

/**
 * Drives a left-hand circle of `radius` with a path-following steering controller (wheel
 * mode, so the angle is exact) while the target speed rises slowly. Returns samples of the
 * steady state and the highest lateral acceleration held within 1 m of the line.
 */
export function skidpad(
  radius: number,
  aids: Partial<DriverAids> = {},
  opts: { startKmh?: number; rampKmhPerS?: number; seconds?: number } = {},
): { maxG: number; samples: SkidpadSample[]; spun: boolean } {
  const startKmh = opts.startKmh ?? 50;
  const ramp = opts.rampKmhPerS ?? 0.5;
  const seconds = opts.seconds ?? 200;
  // Start on the circle (centre at x = -radius), facing -z: a left-hand circle.
  const world = openWorld(aids, undefined, { x: 0, z: 0, yaw: 0 });
  const car = world.cars[0]!;
  const cx = -radius;
  const cz = 0;
  const ratio = car.spec.steeringRatio;
  const wheelbase = car.spec.front.offset - car.spec.rear.offset;
  let integral = 0;
  let lastError = 0;
  let maxG = 0;
  let goodTime = 0;
  let spun = false;
  const samples: SkidpadSample[] = [];
  let nextSample = 0;
  run(
    world,
    seconds,
    (t, c) => {
      const dx = c.pos.x - cx;
      const dz = c.pos.z - cz;
      const r = Math.hypot(dx, dz);
      const error = r - radius; // > 0: outside the line
      const dt = 1 / 400;
      integral = Math.max(-2, Math.min(2, integral + error * dt));
      const dError = (error - lastError) / dt;
      lastError = error;
      // Left turn = negative road-wheel angle.
      const left = wheelbase / radius + 0.08 * error + 0.03 * integral + 0.04 * dError;
      const road = -Math.max(-0.2, Math.min(car.spec.front.maxSteer, left));
      // Speed control: follow a slowly rising target (lift to settle if off the line).
      const target = startKmh + ramp * Math.max(t - 4, 0);
      const v = c.forwardSpeed() * 3.6;
      const throttle = Math.max(0, Math.min(1, (target - v) * 0.15 + 0.25));
      const speed = Math.hypot(c.vel.x, c.vel.z);
      const g = (speed * speed) / r / G;
      if (Math.abs(error) < 1 && t > 6) {
        goodTime += dt;
        if (goodTime > 1) maxG = Math.max(maxG, g);
      } else {
        goodTime = 0;
      }
      if (t >= nextSample && t > 6) {
        nextSample = t + 1;
        samples.push({ g, steer: road, error, speed });
      }
      return { steerMode: 'wheel', wheelAngle: road * ratio, throttle };
    },
    (_t, c) => {
      // Stop once the car has clearly lost the line or spun.
      const r = Math.hypot(c.pos.x - cx, c.pos.z - cz);
      const v = Math.hypot(c.vel.x, c.vel.z);
      const fx = -2 * (c.rot.x * c.rot.z + c.rot.w * c.rot.y);
      const fz = -(1 - 2 * (c.rot.x * c.rot.x + c.rot.y * c.rot.y));
      const along = v > 1 ? (c.vel.x * fx + c.vel.z * fz) / v : 1;
      if (along < Math.cos(0.6)) spun = true;
      return spun || Math.abs(r - radius) > 6;
    },
  );
  return { maxG, samples, spun };
}

/** Random driving on the given world for `seconds`; returns the highest speed seen. */
export function fuzz(world: World, seconds: number, seed: number): { maxSpeed: number } {
  const car = world.cars[0]!;
  const rand = mulberry32(seed);
  const input = neutralInput();
  let nextChange = 0;
  let maxSpeed = 0;
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    const t = i * SIM_DT;
    if (t >= nextChange) {
      input.throttle = rand() < 0.6 ? rand() : 0;
      input.brake = rand() < 0.25 ? rand() : 0;
      input.handbrake = rand() < 0.08 ? 1 : 0;
      input.clutch = rand() < 0.05 ? rand() : 0;
      const mode = rand();
      input.steerMode = mode < 0.4 ? 'pad' : mode < 0.7 ? 'keyboard' : 'wheel';
      input.steer = rand() * 2 - 1;
      input.wheelAngle = (rand() * 2 - 1) * 8;
      input.shiftUp = rand() < 0.1 ? 1 : 0;
      input.shiftDown = rand() < 0.1 ? 1 : 0;
      if (rand() < 0.02) {
        world.setAids(0, {
          ...defaultAids(),
          abs: (['off', 'low', 'high'] as const)[Math.floor(rand() * 3)]!,
          tc: (['off', 'low', 'high'] as const)[Math.floor(rand() * 3)]!,
          gearbox: rand() < 0.5 ? 'manual' : 'auto',
        });
      }
      nextChange = t + 0.2 + rand() * 1.8;
    } else {
      input.shiftUp = 0;
      input.shiftDown = 0;
    }
    world.setInputs([input]);
    world.step(SIM_DT);
    if (i % 4000 === 0 && Math.hypot(car.pos.x, car.pos.z) > 3000) car.reset();
    maxSpeed = Math.max(maxSpeed, Math.hypot(car.vel.x, car.vel.y, car.vel.z));
  }
  return { maxSpeed };
}
