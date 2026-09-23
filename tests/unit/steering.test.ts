import { describe, expect, it } from 'vitest';
import { SIM_DT, type SteerMode } from '../../src/shared/protocol';
import { G, kmh, openWorld, run } from './harness';

const holdSpeed = (target: number) => (c: { forwardSpeed(): number }) =>
  Math.max(0, Math.min(1, (target - c.forwardSpeed() * 3.6) * 0.3));

/** Brings a fresh car up to `speedKmh` in a straight line. */
function atSpeed(speedKmh: number, aids = {}) {
  const world = openWorld(aids);
  run(
    world,
    40,
    (_t, c) => ({ throttle: holdSpeed(speedKmh)(c) }),
    (_t, c) => kmh(c) >= speedKmh,
  );
  return world;
}

/** Average lateral g over the last second of a 3 s steady steer. */
function steadyG(speedKmh: number, stick: number, aids = {}) {
  const world = atSpeed(speedKmh, aids);
  let sum = 0;
  let n = 0;
  let spun = false;
  run(world, 3, (t, c) => {
    if (t > 2) {
      sum += Math.abs(c.accelLat) / G;
      n++;
    }
    const v = Math.hypot(c.vel.x, c.vel.z);
    const fx = -2 * (c.rot.x * c.rot.z + c.rot.w * c.rot.y);
    const fz = -(1 - 2 * (c.rot.x * c.rot.x + c.rot.y * c.rot.y));
    if ((c.vel.x * fx + c.vel.z * fz) / v < Math.cos(0.4)) spun = true;
    return { steerMode: 'pad', steer: stick, throttle: holdSpeed(speedKmh)(c) };
  });
  return { g: sum / n, spun };
}

describe('pad steering', () => {
  it('has full lock when slow and a smaller, speed-sensitive range when fast', () => {
    const car = openWorld().cars[0]!;
    const lock = car.spec.front.maxSteer;
    expect(car.padAuthority(0)).toBe(lock);
    const a60 = car.padAuthority(60 / 3.6);
    const a150 = car.padAuthority(150 / 3.6);
    const a250 = car.padAuthority(250 / 3.6);
    expect(a60).toBeLessThan(lock);
    expect(a150).toBeLessThan(a60);
    expect(a250).toBeLessThan(a150);
    // Never numb: even at 250 km/h full stick is several degrees.
    expect((a250 * 180) / Math.PI).toBeGreaterThan(3);
  });

  it.each([60, 150, 220])(
    'full stick reaches the grip limit at %i km/h without spinning',
    (speed) => {
      const full = steadyG(speed, 1);
      const half = steadyG(speed, 0.5);
      const quarter = steadyG(speed, 0.25);
      expect(full.spun).toBe(false);
      expect(full.g).toBeGreaterThan(1.3);
      // Progressive: a quarter of the stick is well short of the limit.
      expect(quarter.g).toBeLessThan(full.g * 0.85);
      expect(half.g).toBeGreaterThan(quarter.g);
    },
  );

  it('scales the range with the sensitivity setting', () => {
    const car = openWorld({ steerSensitivity: 0.6 }).cars[0]!;
    const normal = openWorld().cars[0]!;
    expect(car.padAuthority(40)).toBeCloseTo(normal.padAuthority(40) * 0.6, 5);
  });

  it('follows the stick quickly and returns to centre faster than it turns in', () => {
    const world = atSpeed(120);
    const car = world.cars[0]!;
    let reached = -1;
    run(world, 0.6, (t, c) => {
      if (reached < 0 && c.steer > 0.95) reached = t;
      return { steerMode: 'pad', steer: 1, throttle: holdSpeed(120)(c) };
    });
    expect(reached).toBeGreaterThan(0.08); // smoothed, not instant
    expect(reached).toBeLessThan(0.35);
    let centred = -1;
    run(world, 0.6, (t, c) => {
      if (centred < 0 && Math.abs(c.steer) < 0.05) centred = t;
      return { steerMode: 'pad', steer: 0, throttle: holdSpeed(120)(c) };
    });
    expect(centred).toBeGreaterThan(0);
    expect(centred).toBeLessThan(reached);
    expect(car.isFinite()).toBe(true);
  });

  it('ramps keyboard steering more slowly than a stick', () => {
    const timeTo = (steerMode: SteerMode) => {
      const world = atSpeed(80);
      return run(
        world,
        2,
        (_t, c) => ({ steerMode, steer: 1, throttle: holdSpeed(80)(c) }),
        (_t, c) => c.steer > 0.95,
      );
    };
    expect(timeTo('keyboard')).toBeGreaterThan(timeTo('pad'));
  });
});

describe('steering wheel', () => {
  it('maps the wheel 1:1 through the steering ratio, at any speed', () => {
    for (const speed of [20, 150]) {
      const world = atSpeed(speed);
      const car = world.cars[0]!;
      const wheelAngle = (45 * Math.PI) / 180; // 45° at the steering wheel
      run(world, 0.3, (_t, c) => ({
        steerMode: 'wheel',
        wheelAngle,
        throttle: holdSpeed(speed)(c),
      }));
      expect(car.roadAngle).toBeCloseTo(wheelAngle / car.spec.steeringRatio, 4);
    }
  });

  it('stops at the car’s steering lock', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    run(world, 0.3, () => ({ steerMode: 'wheel', wheelAngle: -8 }));
    expect(car.roadAngle).toBeCloseTo(-car.spec.front.maxSteer, 4);
  });

  it('responds within a few milliseconds', () => {
    const world = openWorld();
    const car = world.cars[0]!;
    const target = 0.5 / car.spec.steeringRatio;
    run(world, SIM_DT * 12, () => ({ steerMode: 'wheel', wheelAngle: 0.5 }));
    expect(car.roadAngle).toBeGreaterThan(target * 0.95);
  });
});
