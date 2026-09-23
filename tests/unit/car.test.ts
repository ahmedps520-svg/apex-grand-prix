import { describe, expect, it } from 'vitest';
import { C, CAR_STRIDE, SIM_DT, W, WHEEL_STRIDE } from '../../src/shared/protocol';
import { SlopeGround, TestGround } from '../../src/sim/track/surface';
import { World } from '../../src/sim/world';
import { fuzz, heading, kmh, openWorld, run } from './harness';

const speedOf = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);

describe('car at rest', () => {
  it('settles exactly at its design ride height and does not creep', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    run(world, 10, () => ({}));
    expect(car.pos.y).toBeCloseTo(car.spec.cogHeight, 3);
    expect(Math.hypot(car.pos.x, car.pos.z)).toBeLessThan(0.01);
    expect(speedOf(car.vel)).toBeLessThan(0.001);
  });

  it.each([
    ['uphill', 0],
    ['downhill', Math.PI],
    ['across the slope', Math.PI / 2],
  ])('holds on a 15 %% slope with the handbrake, facing %s (< 1 cm in 10 s)', (_name, yaw) => {
    const world = openWorld({ gearbox: 'manual' }, new SlopeGround(0.15), { x: 0, z: 0, yaw });
    const car = world.cars[0]!;
    run(world, 3, () => ({ handbrake: 1 }));
    const start = { ...car.pos };
    run(world, 10, () => ({ handbrake: 1 }));
    const creep = Math.hypot(car.pos.x - start.x, car.pos.y - start.y, car.pos.z - start.z);
    expect(creep).toBeLessThan(0.01);
    // Sanity: the car sits on its wheels, upright on the slope.
    expect(car.wheels.every((w) => w.contact)).toBe(true);
  });

  it('rolls away down a 15 % slope when nothing holds it', () => {
    const world = openWorld({ gearbox: 'manual' }, new SlopeGround(0.15), { x: 0, z: 0, yaw: 0 });
    const car = world.cars[0]!;
    run(world, 5, () => ({}));
    expect(car.forwardSpeed()).toBeLessThan(-2); // rolling backwards, downhill
  });

  it('rolls to a stop from 30 km/h and then stays still, without jitter', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    run(
      world,
      20,
      () => ({ throttle: 0.4 }),
      (_t, c) => kmh(c) >= 30,
    );
    const stopped = run(
      world,
      90,
      () => ({}),
      (_t, c) => speedOf(c.vel) < 0.005,
    );
    expect(stopped).toBeLessThan(90);
    run(world, 1, () => ({}));
    const at = { ...car.pos };
    let worst = 0;
    let reversals = 0;
    let last = 0;
    run(world, 5, (_t, c) => {
      worst = Math.max(worst, speedOf(c.vel));
      const v = c.forwardSpeed();
      if (Math.abs(v) > 1e-4 && Math.sign(v) !== Math.sign(last)) reversals++;
      last = v;
      return {};
    });
    expect(worst).toBeLessThan(0.002);
    expect(reversals).toBeLessThanOrEqual(1);
    expect(Math.hypot(car.pos.x - at.x, car.pos.z - at.z)).toBeLessThan(0.002);
  });
});

describe('car driving', () => {
  it('turns right when steering right and left when steering left', () => {
    for (const steer of [0.5, -0.5]) {
      const world = openWorld();
      const car = world.cars[0]!;
      run(world, 4, () => ({ throttle: 0.5 }));
      const h0 = heading(car);
      run(world, 1.5, () => ({ throttle: 0.3, steer }));
      // Heading increases when turning left.
      expect(Math.sign(heading(car) - h0)).toBe(-Math.sign(steer));
    }
  });

  it('stays stable with full steering at 100 km/h', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    run(world, 16, (t, c) => ({
      throttle: Math.max(0, Math.min(1, (100 - kmh(c)) * 0.3)),
      steer: t > 8 ? 1 : 0,
    }));
    expect(car.angVel.y).toBeLessThan(-0.2); // negative yaw rate = turning right
    const v = Math.hypot(car.vel.x, car.vel.z);
    const q = car.rot;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    // Not spinning: the car still points roughly where it is going.
    expect((car.vel.x * fx + car.vel.z * fz) / v).toBeGreaterThan(Math.cos(0.35));
  });

  it('selects reverse by holding the brake at a standstill (automatic gearbox)', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    run(world, 3, () => ({ brake: 1 }));
    expect(car.gear).toBe(-1);
    expect(car.forwardSpeed()).toBeLessThan(-1);
    run(world, 4, () => ({ throttle: 1 }));
    expect(car.gear).toBeGreaterThan(0);
    expect(car.forwardSpeed()).toBeGreaterThan(1);
  });

  it('loses grip on grass', () => {
    const grip = (surface: TestGround) => {
      const world = openWorld({}, surface);
      return run(
        world,
        20,
        () => ({ throttle: 1 }),
        (_t, c) => kmh(c) >= 100,
      );
    };
    expect(grip(new TestGround(-1, -1))).toBeGreaterThan(grip(new TestGround(1e7, 1e7)) + 0.5);
  });
});

describe('snapshot', () => {
  it('writes the previous and current pose plus telemetry', () => {
    const world = openWorld({ tc: 'low', abs: 'off', gearbox: 'manual' });
    run(world, 1, () => ({ throttle: 1, steer: 0.3 }));
    world.storePrevious();
    world.step(SIM_DT);
    const buf = new Float32Array(CAR_STRIDE);
    world.writeSnapshot(buf);
    const car = world.cars[0]!;
    expect(buf[C.POS]).toBeCloseTo(car.pos.x, 4);
    expect(buf[C.POS + 2]).toBeCloseTo(car.pos.z, 3);
    expect(buf[C.PREV_POS + 2]).not.toBe(buf[C.POS + 2]);
    expect(buf[C.TC_LEVEL]).toBe(1);
    expect(buf[C.ABS_LEVEL]).toBe(0);
    expect(buf[C.GEARBOX_MANUAL]).toBe(1);
    expect(buf[C.ACCEL_LONG]).toBeGreaterThan(3); // still pulling hard after 1 s
    expect(buf[C.STEER_AUTHORITY]).toBeGreaterThan(0);
    const rearLeft = C.WHEELS + 2 * WHEEL_STRIDE;
    expect(buf[rearLeft + W.LOAD]).toBeGreaterThan(2000);
    expect(buf[rearLeft + W.SLIP_RATIO]).toBeGreaterThan(0);
  });
});

describe('robustness', () => {
  it('survives an hour of random inputs on the proving ground without invalid numbers', () => {
    const world = new World(1); // the real proving ground: pad and grass
    const { maxSpeed } = fuzz(world, 3600, 2024);
    expect(world.warnings).toEqual([]);
    expect(world.cars[0]!.isFinite()).toBe(true);
    expect(maxSpeed).toBeLessThan(150);
  });

  it('survives random inputs on a slope', () => {
    const world = new World(1, new SlopeGround(0.2), { x: 0, z: 0, yaw: 0.3 });
    fuzz(world, 300, 7);
    expect(world.warnings).toEqual([]);
    expect(world.cars[0]!.isFinite()).toBe(true);
  });
});
