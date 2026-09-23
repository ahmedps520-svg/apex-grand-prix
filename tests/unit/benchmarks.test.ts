import { describe, expect, it } from 'vitest';
import { TestGround } from '../../src/sim/track/surface';
import { brakeTest, kmh, launch, openWorld, run, skidpad } from './harness';

/** The GT car's physics targets from PLAN.md, Round 2. */

describe('GT benchmarks (TC and ABS on High, automatic gearbox)', () => {
  const standing = launch();

  it('0–100 km/h in 3.0–3.6 s', () => {
    expect(standing.t100).toBeGreaterThan(3.0);
    expect(standing.t100).toBeLessThan(3.6);
  });

  it('0–200 km/h in 9–11.5 s', () => {
    expect(standing.t200).toBeGreaterThan(9);
    expect(standing.t200).toBeLessThan(11.5);
  });

  it('top speed 270–295 km/h, running straight', () => {
    expect(standing.top).toBeGreaterThan(270);
    expect(standing.top).toBeLessThan(295);
    expect(standing.drift).toBeLessThan(0.05);
  });

  it('brakes from 200 km/h to a stop in 80–100 m without veering', () => {
    const stop = brakeTest(200);
    expect(stop.distance).toBeGreaterThan(80);
    expect(stop.distance).toBeLessThan(100);
    expect(stop.drift).toBeLessThan(0.3);
  });

  it('holds 1.40–1.65 g on a 60 m skidpad and understeers gently at the limit', () => {
    const pad = skidpad(60);
    expect(pad.spun).toBe(false);
    expect(pad.maxG).toBeGreaterThan(1.4);
    expect(pad.maxG).toBeLessThan(1.65);
    // Understeer gradient: at a fixed radius, more lateral g needs more steering.
    const at = (g: number) =>
      pad.samples.reduce((a, b) => (Math.abs(b.g - g) < Math.abs(a.g - g) ? b : a));
    const low = at(0.4);
    const high = at(1.2);
    const gradient = (Math.abs(high.steer) - Math.abs(low.steer)) / (high.g - low.g); // rad per g
    const degPerG = (gradient * 180) / Math.PI;
    expect(degPerG).toBeGreaterThan(0.1);
    expect(degPerG).toBeLessThan(2);
  });
});

describe('traction control', () => {
  it('launches within 6 % of the best hand-controlled launch (TC off)', () => {
    // "By hand": TC off, with the best constant throttle or throttle ramp from a sweep.
    let best = Infinity;
    for (const level of [0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1]) {
      best = Math.min(best, launch({ tc: 'off' }, () => level, 5).t100);
      for (const ramp of [0.3, 0.6, 1]) {
        best = Math.min(best, launch({ tc: 'off' }, (t) => Math.min(level + t / ramp, 1), 5).t100);
      }
    }
    const high = launch({ tc: 'high' }, () => 1, 5).t100;
    const low = launch({ tc: 'low' }, () => 1, 5).t100;
    expect(best).toBeLessThan(3.6);
    expect(high / best).toBeLessThan(1.06);
    expect(low / best).toBeLessThan(1.06);
  });

  it('never cuts power on a clean launch on dry asphalt', () => {
    const world = openWorld({ tc: 'high' });
    let cut = 0;
    run(world, 4, (_t, car) => {
      if (car.tcActive) cut++;
      return { throttle: 1 };
    });
    expect(cut).toBe(0);
  });

  it('lets the rear tyres slip more on Low than on High, and most with TC off (on grass)', () => {
    const peakSlip = (tc: 'off' | 'low' | 'high') => {
      const world = openWorld({ tc }, new TestGround(-1, -1));
      let peak = 0;
      let cut = 0;
      run(world, 3, (t, car) => {
        if (t > 0.5) peak = Math.max(peak, car.wheels[2]!.slipRatio, car.wheels[3]!.slipRatio);
        if (car.tcActive) cut++;
        return { throttle: 1 };
      });
      return { peak, cut };
    };
    const high = peakSlip('high');
    const low = peakSlip('low');
    const off = peakSlip('off');
    expect(high.cut).toBeGreaterThan(0);
    expect(off.cut).toBe(0);
    expect(high.peak).toBeLessThan(low.peak);
    expect(low.peak).toBeLessThan(off.peak);
  });
});

describe('ABS', () => {
  /** Deepest wheel slip ratio during a full stop from 150 km/h (-1 = locked). */
  const deepestSlip = (abs: 'off' | 'low' | 'high') => {
    const world = openWorld({ abs });
    run(
      world,
      30,
      () => ({ throttle: 1 }),
      (_t, c) => kmh(c) >= 150,
    );
    let worst = 0;
    run(
      world,
      8,
      (_t, c) => {
        for (const w of c.wheels) worst = Math.min(worst, w.slipRatio);
        return { brake: 1 };
      },
      (_t, c) => c.forwardSpeed() < 5,
    );
    return worst;
  };

  it('keeps the wheels turning on High, allows more slip on Low, and lets them lock when Off', () => {
    const high = deepestSlip('high');
    const low = deepestSlip('low');
    const off = deepestSlip('off');
    expect(high).toBeGreaterThan(-0.15);
    expect(low).toBeLessThan(high);
    expect(off).toBeLessThan(-0.9); // locked: the wheel stops while the car still moves
  });

  it('stops shorter with ABS than with locked wheels', () => {
    expect(brakeTest(200, { abs: 'high' }).distance).toBeLessThan(
      brakeTest(200, { abs: 'off' }).distance,
    );
  });
});
