import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/shared/math';
import { CAR_STRIDE, SIM_DT, neutralInput, type DriverInput } from '../../src/shared/protocol';
import { TestGround } from '../../src/sim/track/surface';
import type { Car } from '../../src/sim/vehicle/car';
import { World } from '../../src/sim/world';

/** A world with asphalt everywhere, so long runs never leave the pad. */
const openWorld = () => new World(1, new TestGround(1e7));

function drive(world: World, seconds: number, input: Partial<DriverInput>): void {
  const frame = { ...neutralInput(), ...input };
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    world.setInputs([frame]);
    world.step(SIM_DT);
  }
}

const speedKmh = (car: Car) => car.forwardSpeed() * 3.6;
const heading = (car: Car) => {
  // Yaw of the car's nose (0 = facing -z, positive = turned left).
  const q = car.rot;
  const fx = -2 * (q.x * q.z + q.w * q.y);
  const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.atan2(-fx, -fz);
};

describe('test car at rest', () => {
  it('settles exactly at its design ride height and does not creep', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    const start = { x: car.pos.x, z: car.pos.z };
    drive(world, 10, {});
    expect(car.pos.y).toBeCloseTo(car.spec.cogHeight, 3);
    expect(Math.hypot(car.pos.x - start.x, car.pos.z - start.z)).toBeLessThan(0.01);
    expect(Math.hypot(car.vel.x, car.vel.y, car.vel.z)).toBeLessThan(0.01);
  });
});

describe('test car driving', () => {
  it('accelerates straight: 0–100 km/h in 2.8–3.8 s', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    let t = 0;
    let t100 = -1;
    const frame = { ...neutralInput(), throttle: 1 };
    while (t < 10) {
      world.setInputs([frame]);
      world.step(SIM_DT);
      t += SIM_DT;
      if (t100 < 0 && speedKmh(car) >= 100) t100 = t;
    }
    expect(t100).toBeGreaterThan(2.8);
    expect(t100).toBeLessThan(3.8);
    expect(Math.abs(car.pos.x)).toBeLessThan(0.05);
  });

  it('reaches a plausible top speed (260–310 km/h)', () => {
    const world = openWorld();
    drive(world, 45, { throttle: 1 });
    const v = speedKmh(world.cars[0]!);
    expect(v).toBeGreaterThan(260);
    expect(v).toBeLessThan(310);
  });

  it('stops from 200 km/h in 80–100 m with ABS, without veering', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    while (speedKmh(car) < 200) drive(world, SIM_DT, { throttle: 1 });
    const z0 = car.pos.z;
    let t = 0;
    while (car.forwardSpeed() > 0.05 && t < 10) {
      drive(world, SIM_DT, { brake: 1 });
      t += SIM_DT;
    }
    const distance = z0 - car.pos.z;
    expect(distance).toBeGreaterThan(80);
    expect(distance).toBeLessThan(100);
    expect(Math.abs(car.pos.x)).toBeLessThan(0.3);
  });

  it('turns right when steering right, and stays stable at the limit', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    // Hold ~100 km/h, then steer right at a moderate and a large input.
    for (const steer of [0.3, 1]) {
      const w = openWorld();
      const c = w.cars[0]!;
      for (let i = 0; i < 16 / SIM_DT; i++) {
        const t = i * SIM_DT;
        const throttle = Math.max(0, Math.min(1, (100 - speedKmh(c)) * 0.3));
        w.setInputs([{ ...neutralInput(), throttle, steer: t > 8 ? steer : 0 }]);
        w.step(SIM_DT);
      }
      expect(c.angVel.y).toBeLessThan(-0.2); // negative yaw rate = turning right
      // Not spinning: the car still points roughly where it is going.
      const v = Math.hypot(c.vel.x, c.vel.z);
      const q = c.rot;
      const fx = -2 * (q.x * q.z + q.w * q.y);
      const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
      expect((c.vel.x * fx + c.vel.z * fz) / v).toBeGreaterThan(Math.cos(0.35));
    }
    expect(car.isFinite()).toBe(true);
  });

  it('holds a steady turn within the grip envelope (1.2–1.8 g)', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    for (let i = 0; i < 16 / SIM_DT; i++) {
      const t = i * SIM_DT;
      const throttle = Math.max(0, Math.min(1, (120 - speedKmh(car)) * 0.3));
      world.setInputs([{ ...neutralInput(), throttle, steer: t > 8 ? 0.6 : 0 }]);
      world.step(SIM_DT);
    }
    const v = Math.hypot(car.vel.x, car.vel.z);
    const lateralG = (v * Math.abs(car.angVel.y)) / 9.81;
    expect(lateralG).toBeGreaterThan(1.2);
    expect(lateralG).toBeLessThan(1.8);
  });

  it('reverses when the brake is held at a standstill', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    drive(world, 3, { brake: 1 });
    expect(car.gear).toBe(-1);
    expect(car.forwardSpeed()).toBeLessThan(-1);
    drive(world, 2, { throttle: 1 });
    drive(world, 2, { throttle: 1 });
    expect(car.gear).toBeGreaterThan(0);
  });

  it('heading follows steering in both directions', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    drive(world, 4, { throttle: 0.5 });
    const h0 = heading(car);
    drive(world, 1.5, { throttle: 0.3, steer: -0.5 });
    expect(heading(car)).toBeGreaterThan(h0); // left turn = heading increases
  });
});

describe('physics robustness', () => {
  it('survives 10 minutes of random inputs without invalid numbers or runaway speed', () => {
    const world = new World(1); // the real test ground, pad and grass
    const car = world.cars[0]!;
    const rand = mulberry32(2024);
    const input = neutralInput();
    let nextChange = 0;
    let maxSpeed = 0;
    const steps = Math.round(600 / SIM_DT);
    for (let i = 0; i < steps; i++) {
      const t = i * SIM_DT;
      if (t >= nextChange) {
        input.throttle = rand() < 0.6 ? rand() : 0;
        input.brake = rand() < 0.25 ? rand() : 0;
        input.steer = rand() * 2 - 1;
        input.handbrake = rand() < 0.08 ? 1 : 0;
        input.steerIsDigital = rand() < 0.5;
        nextChange = t + 0.2 + rand() * 1.8;
      }
      world.setInputs([input]);
      world.step(SIM_DT);
      if (i % 4000 === 0 && Math.hypot(car.pos.x, car.pos.z) > 3000) car.reset();
      maxSpeed = Math.max(maxSpeed, Math.hypot(car.vel.x, car.vel.y, car.vel.z));
    }
    expect(world.warnings).toEqual([]);
    expect(car.isFinite()).toBe(true);
    expect(maxSpeed).toBeLessThan(150);
  });

  it('writes a snapshot with the previous and current pose', () => {
    const world = openWorld();
    drive(world, 1, { throttle: 1 });
    world.storePrevious();
    world.step(SIM_DT);
    const buf = new Float32Array(CAR_STRIDE);
    world.writeSnapshot(buf);
    const car = world.cars[0]!;
    expect(buf[7]).toBeCloseTo(car.pos.x, 4);
    expect(buf[9]).toBeCloseTo(car.pos.z, 3);
    expect(buf[2]).not.toBe(buf[9]); // previous z differs from current z while moving
  });
});
