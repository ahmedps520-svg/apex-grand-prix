import { WEATHERS, gripFactor, wetness, type Weather } from '../content/conditions';
import { mulberry32 } from '../shared/math';
import type { WeatherMix } from '../shared/protocol';

/**
 * Weather that moves: every few minutes the sky steps one rung along the ladder from clear to
 * heavy rain (or back), and the change comes in over a transition, the road's grip and the AI's
 * pace following it. Seeded, so a replayed session sees the same sky.
 */

/** The ladder, driest to wettest: a change is one rung. */
const LADDER: readonly Weather[] = WEATHERS.map((w) => w.value);

/** Seconds between changes (simulated), and how long a change takes to come in. */
export const WEATHER_WAIT_MIN = 150;
export const WEATHER_WAIT_MAX = 330;
export const WEATHER_TRANSITION = 45;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class MovingWeather {
  /** The weather the sky is leaving, and the one it is changing to (the same when settled). */
  from: Weather;
  to: Weather;
  /** 0 as a change starts … 1 arrived. */
  blend = 1;
  /** Seconds to the next change, once settled. */
  wait: number;
  /** The grip the session started with (the AI's lines were planned for it). */
  readonly startGrip: number;
  private readonly rand: () => number;

  constructor(start: Weather, seed: number) {
    this.from = start;
    this.to = start;
    this.startGrip = gripFactor(start);
    this.rand = mulberry32(seed ^ 0x5eed);
    this.wait = this.nextWait();
  }

  step(dt: number): void {
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / WEATHER_TRANSITION);
      if (this.blend >= 1) {
        this.from = this.to;
        this.wait = this.nextWait();
      }
      return;
    }
    this.wait -= dt;
    if (this.wait <= 0) this.change();
  }

  /** Starts the next change: one rung up or down the ladder (down more often once it rains). */
  change(): void {
    const i = LADDER.indexOf(this.from);
    const up = this.rand() < (i >= 2 ? 0.4 : 0.55);
    const j = i <= 0 ? 1 : i >= LADDER.length - 1 ? i - 1 : i + (up ? 1 : -1);
    this.to = LADDER[j]!;
    this.blend = 0;
  }

  /** A change to this weather, wherever it stands on the ladder, from `blend` along. */
  changeTo(to: Weather, blend = 0): void {
    if (to === this.from) {
      this.to = to;
      this.blend = 1;
      return;
    }
    this.to = to;
    this.blend = Math.max(0, Math.min(blend, 0.999));
  }

  /** How wet the road is now, 0 … 1. */
  get wetness(): number {
    return lerp(wetness(this.from), wetness(this.to), this.blend);
  }

  /** Tyre grip now as a fraction of dry grip. */
  get grip(): number {
    return lerp(gripFactor(this.from), gripFactor(this.to), this.blend);
  }

  /**
   * The AI's pace as a share of what their lines were planned for: cornering speed goes with
   * the square root of the grip.
   */
  get pace(): number {
    return Math.sqrt(this.grip / this.startGrip);
  }

  get status(): WeatherMix {
    return { from: this.from, to: this.to, blend: this.blend };
  }

  private nextWait(): number {
    return WEATHER_WAIT_MIN + this.rand() * (WEATHER_WAIT_MAX - WEATHER_WAIT_MIN);
  }
}
