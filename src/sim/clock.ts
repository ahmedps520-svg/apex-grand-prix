/**
 * Fixed-timestep clock ("fix your timestep"). The main thread sends a target time every display
 * frame; the clock turns elapsed time into a whole number of fixed steps and keeps the remainder
 * for the next frame. Only differences between target times matter, so the main thread's clock
 * doesn't have to match the worker's.
 */
export class FixedStepClock {
  readonly dt: number;
  readonly maxFrameDelta: number;
  /** Simulated time in seconds (totalSteps × dt, kept exact by counting steps). */
  simTime = 0;
  totalSteps = 0;
  /** Seconds of wall time dropped because a frame took longer than maxFrameDelta. */
  droppedTime = 0;

  private lastTarget: number | null = null;
  private accumulator = 0;

  constructor(hz: number, maxFrameDelta: number) {
    this.dt = 1 / hz;
    this.maxFrameDelta = maxFrameDelta;
  }

  /** Returns how many fixed steps to run to catch up with `targetTime` (seconds). */
  advance(targetTime: number): number {
    if (this.lastTarget === null) {
      this.lastTarget = targetTime;
      return 0;
    }
    let delta = targetTime - this.lastTarget;
    this.lastTarget = targetTime;
    // Time going backwards (or NaN) never produces steps.
    if (!(delta > 0)) return 0;
    if (delta > this.maxFrameDelta) {
      this.droppedTime += delta - this.maxFrameDelta;
      delta = this.maxFrameDelta;
    }
    this.accumulator += delta;
    // A tiny epsilon keeps accumulated floating-point error from delaying a step by a frame.
    const steps = Math.floor(this.accumulator / this.dt + 1e-7);
    if (steps > 0) {
      this.accumulator -= steps * this.dt;
      if (this.accumulator < 0) this.accumulator = 0;
      this.totalSteps += steps;
      this.simTime = this.totalSteps * this.dt;
    }
    return steps;
  }

  /** Blend factor between the previous and the current step, always in [0, 1). */
  get alpha(): number {
    const a = this.accumulator / this.dt;
    return a < 0 ? 0 : a >= 1 ? 0.999999 : a;
  }

  /** Forget the last target time, e.g. after a pause, so no time is caught up. */
  resetBaseline(): void {
    this.lastTarget = null;
  }
}
