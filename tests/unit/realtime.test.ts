import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/shared/math';
import { MAX_FRAME_DELTA, SIM_DT, SIM_HZ, neutralInput } from '../../src/shared/protocol';
import { FixedStepClock } from '../../src/sim/clock';
import { TestGround } from '../../src/sim/track/surface';
import { World } from '../../src/sim/world';

/**
 * Drives the simulation the way the worker does (one tick per display frame, fixed steps in
 * between) at low and uneven frame rates, full throttle from a standstill.
 */
function launchAtFrameRate(fps: number, jitter: number, seconds: number, seed: number) {
  const world = new World(1, new TestGround(1e7, 1e7));
  const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
  const rand = mulberry32(seed);
  const input = { ...neutralInput(), throttle: 1 };
  let wall = 0;
  clock.advance(wall);
  while (wall < seconds) {
    wall += (1 / fps) * (1 + (rand() * 2 - 1) * jitter);
    const steps = clock.advance(wall);
    world.setInputs([input]);
    for (let i = 0; i < steps; i++) {
      if (i === steps - 1) world.storePrevious();
      world.step(SIM_DT);
    }
  }
  return { wall, simTime: clock.simTime, speed: world.cars[0]!.forwardSpeed() };
}

describe('physics stays real-time at low frame rates', () => {
  it.each([
    [20, 0.4],
    [15, 0.4],
    [10, 0.4],
    [5, 0.2],
  ])('%i fps with ±%f jitter: simulated time keeps up with wall time', (fps, jitter) => {
    const run = launchAtFrameRate(fps, jitter, 7, fps);
    expect(run.simTime / run.wall).toBeGreaterThan(0.99);
  });

  it('reaches the same speed after 7 s at 10 fps as at 144 fps', () => {
    const slow = launchAtFrameRate(10, 0.4, 7, 1);
    const fast = launchAtFrameRate(144, 0.1, 7, 2);
    // Compare at equal simulated time: both runs should be ~7 s in, so speeds match closely.
    expect(Math.abs(slow.simTime - fast.simTime)).toBeLessThan(0.15);
    expect(slow.speed * 3.6).toBeGreaterThan(150); // well past 1st gear after 7 s of throttle
    expect(Math.abs(slow.speed - fast.speed) / fast.speed).toBeLessThan(0.02);
  });
});

describe('determinism', () => {
  /** Runs `totalSteps` fixed steps grouped into frames of random size, like uneven display frames. */
  function runGrouped(totalSteps: number, seed: number) {
    const world = new World(1, new TestGround(1e7, 1e7));
    const rand = mulberry32(seed);
    const input = { ...neutralInput(), throttle: 1, steer: 0.2 };
    let done = 0;
    while (done < totalSteps) {
      const steps = Math.min(1 + Math.floor(rand() * 40), totalSteps - done);
      world.setInputs([input]);
      for (let i = 0; i < steps; i++) {
        if (i === steps - 1) world.storePrevious();
        world.step(SIM_DT);
      }
      done += steps;
    }
    const car = world.cars[0]!;
    return [car.pos.x, car.pos.y, car.pos.z, car.vel.x, car.vel.z, car.engineRpm, car.gear];
  }

  it('gives bit-identical results however the steps are split into frames', () => {
    const a = runGrouped(4000, 1);
    const b = runGrouped(4000, 99);
    expect(b).toEqual(a);
  });
});
