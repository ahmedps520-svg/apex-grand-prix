import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../src/shared/math';
import { MAX_FRAME_DELTA, SIM_HZ } from '../../src/shared/protocol';
import { FixedStepClock } from '../../src/sim/clock';

describe('FixedStepClock', () => {
  it('runs exactly 400 steps per second over 60 s of uneven frames (4–100 ms)', () => {
    const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
    const rand = mulberry32(1234);
    let time = 10; // arbitrary start: only differences matter
    let steps = clock.advance(time);
    while (time < 70) {
      time += 0.004 + rand() * 0.096;
      steps += clock.advance(time);
    }
    const expected = (time - 10) * SIM_HZ;
    expect(Math.abs(steps - expected)).toBeLessThanOrEqual(1);
    expect(clock.droppedTime).toBe(0);
  });

  it('keeps exact step counts at common display rates', () => {
    for (const hz of [30, 60, 90, 120, 144, 165, 240]) {
      const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
      let steps = clock.advance(0);
      const frames = hz * 30;
      for (let i = 1; i <= frames; i++) steps += clock.advance(i / hz);
      expect(Math.abs(steps - 30 * SIM_HZ)).toBeLessThanOrEqual(1);
    }
  });

  it('caps catch-up after a long stall instead of simulating it', () => {
    const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
    clock.advance(0);
    const steps = clock.advance(5); // a 5-second hitch
    expect(steps).toBe(Math.round(MAX_FRAME_DELTA * SIM_HZ));
    expect(clock.droppedTime).toBeCloseTo(5 - MAX_FRAME_DELTA, 9);
  });

  it('never steps when time goes backwards or is invalid', () => {
    const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
    clock.advance(1);
    expect(clock.advance(0.5)).toBe(0);
    expect(clock.advance(Number.NaN)).toBe(0);
  });

  it('keeps alpha in [0, 1)', () => {
    const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
    const rand = mulberry32(7);
    let time = 0;
    clock.advance(time);
    for (let i = 0; i < 20_000; i++) {
      time += rand() * 0.02;
      clock.advance(time);
      expect(clock.alpha).toBeGreaterThanOrEqual(0);
      expect(clock.alpha).toBeLessThan(1);
    }
  });

  it('does not catch up time spent paused', () => {
    const clock = new FixedStepClock(SIM_HZ, MAX_FRAME_DELTA);
    clock.advance(0);
    clock.advance(1);
    const before = clock.totalSteps;
    clock.resetBaseline(); // pause…
    expect(clock.advance(31)).toBe(0); // …resume 30 s later: first tick only sets the baseline
    expect(clock.advance(31 + 1 / 60)).toBeLessThanOrEqual(7);
    expect(clock.totalSteps - before).toBeLessThanOrEqual(7);
  });
});
