import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/shared/protocol';
import { kmh, openWorld, run } from './harness';

/** One paddle press on the first step of a `run`. */
const press = (key: 'shiftUp' | 'shiftDown', extra: object = {}) => {
  let sent = false;
  return () => {
    const input = sent ? extra : { ...extra, [key]: 1 };
    sent = true;
    return input;
  };
};

describe('manual gearbox', () => {
  it('shifts up and down one gear per paddle press, with a short shift time', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    run(world, 1.5, () => ({ throttle: 1 }));
    expect(car.gear).toBe(1); // never shifts by itself
    run(world, SIM_DT * 2, press('shiftUp', { throttle: 1 }));
    expect(car.gear).toBe(2);
    expect(car.shiftTimer).toBeGreaterThan(0);
    run(world, 0.2, () => ({ throttle: 1 }));
    expect(car.shiftTimer).toBe(0);
    run(world, SIM_DT * 2, press('shiftDown'));
    expect(car.gear).toBe(1);
  });

  it('queues quick double presses instead of dropping them', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    run(
      world,
      20,
      () => ({ throttle: 1 }),
      (_t, c) => kmh(c) >= 60,
    );
    world.setInputs([{ ...car.input, throttle: 1, shiftUp: 2, shiftDown: 0 }]);
    run(world, 0.5, () => ({ throttle: 1 }));
    expect(car.gear).toBe(3);
  });

  it('refuses downshifts that would over-rev the engine, and says so', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    // Accelerate to 200 km/h, shifting up at 7500 rpm.
    run(
      world,
      30,
      (_t, c) =>
        c.engineRpm > 7500 && c.shiftTimer === 0 ? { throttle: 1, shiftUp: 1 } : { throttle: 1 },
      (_t, c) => kmh(c) >= 200,
    );
    const startGear = car.gear;
    expect(startGear).toBeGreaterThanOrEqual(4);
    // Brake hard while hammering the downshift paddle every 50 ms.
    let denied = 0;
    let maxRpm = 0;
    run(
      world,
      4,
      (t, c) => {
        maxRpm = Math.max(maxRpm, c.engineRpm);
        if (c.shiftDeniedTimer > 0) denied++;
        const pressNow = Math.round(t / SIM_DT) % 20 === 0;
        return pressNow ? { brake: 1, shiftDown: 1 } : { brake: 1 };
      },
      (_t, c) => kmh(c) < 80,
    );
    expect(denied).toBeGreaterThan(0);
    expect(car.gear).toBeLessThan(startGear);
    expect(maxRpm).toBeLessThan(car.spec.engine.limiterRpm + 400);
  });

  it('blips the throttle on a downshift so the engine matches the lower gear', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    run(
      world,
      20,
      (_t, c) => (c.engineRpm > 7000 && c.gear < 3 ? { throttle: 1, shiftUp: 1 } : { throttle: 1 }),
      (_t, c) => c.gear === 3 && c.shiftTimer === 0 && c.engineRpm > 5000,
    );
    const before = car.engineRpm;
    run(world, SIM_DT * 2, press('shiftDown'));
    run(world, car.spec.gearbox.shiftTime, () => ({}));
    expect(car.gear).toBe(2);
    expect(car.engineRpm).toBeGreaterThan(before + 1000);
  });

  it('selects reverse with a downshift from first at a standstill, and first again with an upshift', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    run(world, SIM_DT * 2, press('shiftDown'));
    expect(car.gear).toBe(-1);
    run(world, 2, () => ({ throttle: 0.6 }));
    expect(car.forwardSpeed()).toBeLessThan(-1);
    // Too fast to change direction: refused.
    run(world, SIM_DT * 2, press('shiftUp'));
    expect(car.gear).toBe(-1);
    run(
      world,
      5,
      () => ({ brake: 1 }),
      (_t, c) => Math.abs(c.forwardSpeed()) < 0.5,
    );
    run(world, SIM_DT * 2, press('shiftUp'));
    expect(car.gear).toBe(1);
  });

  it('switches to automatic mid-drive and takes over', () => {
    const world = openWorld({ gearbox: 'manual' });
    const car = world.cars[0]!;
    run(world, 2, () => ({ throttle: 1 }));
    expect(car.gear).toBe(1);
    world.setAids(0, { ...car.aids, gearbox: 'auto' });
    run(world, 3, () => ({ throttle: 1 }));
    expect(car.gear).toBeGreaterThan(1);
  });
});

describe('automatic gearbox', () => {
  it('ignores the paddles', () => {
    const world = openWorld({ gearbox: 'auto' });
    const car = world.cars[0]!;
    run(world, 0.5, press('shiftUp', { throttle: 0.2 }));
    expect(car.gear).toBe(1);
  });

  it('changes down early under braking', () => {
    const world = openWorld({ gearbox: 'auto' });
    const car = world.cars[0]!;
    run(
      world,
      30,
      () => ({ throttle: 1 }),
      (_t, c) => kmh(c) >= 180,
    );
    const shiftPoints: number[] = [];
    let lastGear = car.gear;
    let lastRpm = car.drivenRpm(car.gear);
    run(
      world,
      8,
      (_t, c) => {
        if (c.gear < lastGear) shiftPoints.push(lastRpm);
        lastGear = c.gear;
        lastRpm = c.drivenRpm(c.gear);
        return { brake: 1 };
      },
      (_t, c) => kmh(c) < 50,
    );
    expect(shiftPoints.length).toBeGreaterThanOrEqual(3);
    // Downshifts happen with the engine still high in the rev range (not at the cruising 3900).
    expect(Math.min(...shiftPoints)).toBeGreaterThan(car.spec.gearbox.brakingDownshiftRpm - 400);
    expect(car.gear).toBeLessThanOrEqual(2);
  });
});
