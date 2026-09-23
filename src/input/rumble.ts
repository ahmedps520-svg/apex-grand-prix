import type { CarRenderState } from '../render/interpolate';
import { mulberry32 } from '../shared/math';
import {
  FLAG_ABS,
  FLAG_LIMITER,
  FLAG_SHIFT_DENIED,
  FLAG_TC,
  FLAG_UPSIDE_DOWN,
} from '../shared/protocol';
import { SURFACE } from '../sim/track/surface';
import { TEST_MULE } from '../sim/vehicle/spec';

/**
 * Controller rumble: turns driving events into the strengths of a gamepad's two motors (strong =
 * low-frequency, weak = high-frequency) and plays them with the Gamepad API's 'dual-rumble'
 * effect. Chrome and Edge drive Xbox and PlayStation pads; Safari on iPad has no gamepad
 * vibration, so `canRumble` is false there and nothing is sent.
 *
 * Each channel gives a level per motor. Per motor the channels combine as 1 − Π(1 − level), so
 * several effects add up without exceeding 1, and the master strength scales the result. The
 * channel functions are pure; the mixer keeps the state (previous frame, pulse timers) and calls
 * the pad at most every 50 ms. Each effect lasts a little longer than that and the next call
 * replaces it, so the motors run on without gaps.
 */

export type RumbleChannel = 'wheelspin' | 'lockup' | 'shift' | 'limiter' | 'offroad' | 'impact';

/** The channels in settings-screen order, with their labels. */
export const RUMBLE_CHANNELS: ReadonlyArray<{ channel: RumbleChannel; label: string }> = [
  { channel: 'wheelspin', label: 'Wheelspin' },
  { channel: 'lockup', label: 'Lock-ups and ABS' },
  { channel: 'shift', label: 'Gear shifts' },
  { channel: 'limiter', label: 'Rev limiter' },
  { channel: 'offroad', label: 'Off track' },
  { channel: 'impact', label: 'Impacts' },
];

export interface RumbleSettings {
  enabled: boolean;
  /** Master strength 0..1. */
  strength: number;
  channels: Record<RumbleChannel, boolean>;
}

export const defaultRumbleSettings = (): RumbleSettings => ({
  enabled: true,
  strength: 0.7,
  channels: {
    wheelspin: true,
    lockup: true,
    shift: true,
    limiter: true,
    offroad: true,
    impact: true,
  },
});

/** Two motor magnitudes 0..1. */
export interface RumbleOutput {
  strong: number;
  weak: number;
}

/** The parts of the Gamepad API used here (so tests can pass plain objects). */
export interface RumblePad {
  vibrationActuator?: {
    effects?: readonly string[];
    playEffect?(
      type: string,
      params: {
        duration: number;
        startDelay?: number;
        strongMagnitude: number;
        weakMagnitude: number;
      },
    ): Promise<unknown>;
    reset?(): Promise<unknown>;
  } | null;
}

type Actuator = NonNullable<RumblePad['vibrationActuator']>;
type EffectParams = Parameters<NonNullable<Actuator['playEffect']>>[1];

const DUAL_RUMBLE = 'dual-rumble';

/** The pad's actuator if it can play 'dual-rumble' in this browser, else null. */
function actuatorOf(pad: RumblePad | null | undefined): Actuator | null {
  const actuator = pad?.vibrationActuator;
  if (!actuator || typeof actuator.playEffect !== 'function') return null;
  // Browsers that list the effects say whether this pad has two motors. Older Chrome has no
  // list, but only gives an actuator to pads it can rumble.
  const effects = actuator.effects;
  return !effects || effects.includes(DUAL_RUMBLE) ? actuator : null;
}

/** True if this pad can rumble in this browser ('dual-rumble' supported). */
export function canRumble(pad: RumblePad | null | undefined): boolean {
  return actuatorOf(pad) !== null;
}

// ---------------------------------------------------------------- channels

/** Wheelspin: slip ratio just past the tyre's peak (~0.1) → full, and what's left under TC. */
const SPIN_FROM = 0.12;
const SPIN_FULL = 0.35;
const SPIN_UNDER_TC = 0.25;
/** Lock-ups: slip ratio (locking) → full, faded in with speed (m/s). */
const LOCK_FROM = 0.15;
const LOCK_FULL = 0.5;
const LOCK_SPEED_FROM = 1.5;
const LOCK_SPEED_FULL = 5;
/** Pedal travel that counts as being on the throttle or the brake. */
const PEDAL_ON = 0.05;
/** Speed (m/s) for the full grass rumble. */
const GRASS_FULL_SPEED = 25;
/** Rev limiter: the build-up starts this far below the limiter and reaches this level. */
const LIMITER_BUILD_RPM = 500;
const LIMITER_BUILD = 0.35;
/**
 * Impacts: jerk (m/s³) where a knock starts to count, and where it is full. The simulation
 * smooths the felt acceleration over 50 ms, so gear shifts and stamping on the brake stay below
 * ~250 (~350 when the worker's snapshots arrive unevenly), while a sudden 3 g knock reads ~500
 * and a crash several thousand.
 */
const IMPACT_JERK = 500;
const IMPACT_JERK_FULL = 4000;
/** Smallest impact pulse, so every knock that counts is felt. */
const IMPACT_MIN = 0.35;
/** Below this speed (m/s) the car counts as standing still. */
const STANDSTILL = 2;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);
/** 0 at `from`, 1 at `to`, linear in between (NaN gives 0). */
const ramp = (x: number, from: number, to: number): number => clamp01((x - from) / (to - from));

/**
 * Wheelspin 0…1 while on the throttle: the fastest-spinning wheel in contact, from a slip ratio
 * of 0.12 to full at 0.35. Free-rolling wheels read ~0, so only driven wheels count (the rear
 * pair on the test car). Reverse gear spins the wheels backwards, which flips the sign. With
 * `tc` (traction control catching it) a quarter is left.
 */
export function wheelspinLevel(car: CarRenderState, tc = (car.flags & FLAG_TC) !== 0): number {
  if (!(car.throttle > PEDAL_ON)) return 0;
  const dir = car.gear < 0 ? -1 : 1;
  let spin = 0;
  for (const w of car.wheels) {
    const s = dir * w.slipRatio;
    if (w.contact && s > spin) spin = s;
  }
  return ramp(spin, SPIN_FROM, SPIN_FULL) * (tc ? SPIN_UNDER_TC : 1);
}

/**
 * Lock-ups 0…1 while braking (pedal or handbrake): the most-locked wheel in contact, from a slip
 * ratio of −0.15 to full at −0.5, faded in between 1.5 and 5 m/s (at walking pace every stop ends
 * with still wheels). Moving backwards flips the sign.
 */
export function lockupLevel(car: CarRenderState): number {
  if (!(car.brake > PEDAL_ON || car.handbrake > PEDAL_ON)) return 0;
  const dir = car.speed < 0 ? -1 : 1;
  let lock = 0;
  for (const w of car.wheels) {
    const s = -dir * w.slipRatio;
    if (w.contact && s > lock) lock = s;
  }
  const speed = ramp(Math.abs(car.speed), LOCK_SPEED_FROM, LOCK_SPEED_FULL);
  return ramp(lock, LOCK_FROM, LOCK_FULL) * speed;
}

/**
 * Off track 0…1: the share of the four wheels touching grass or gravel, times speed (full by
 * 25 m/s). Kerbs are part of the track.
 */
export function offroadLevel(car: CarRenderState): number {
  const wheels = car.wheels;
  if (wheels.length === 0) return 0;
  let off = 0;
  for (const w of wheels) {
    if (w.contact && (w.surface === SURFACE.GRASS || w.surface === SURFACE.GRAVEL)) off++;
  }
  return (off / wheels.length) * ramp(Math.abs(car.speed), 0, GRASS_FULL_SPEED);
}

/**
 * Rev limiter 0…1: full while it cuts in, and a faint build-up (to 0.35) over the last 500 rpm
 * below it while a gear is engaged.
 */
export function limiterLevel(
  car: CarRenderState,
  limiterRpm = TEST_MULE.engine.limiterRpm,
): number {
  if ((car.flags & FLAG_LIMITER) !== 0) return 1;
  if (car.gear === 0) return 0;
  return LIMITER_BUILD * ramp(car.rpm, limiterRpm - LIMITER_BUILD_RPM, limiterRpm);
}

/**
 * True for a gear change worth a thump. At a standstill only a single step between forward gears
 * counts: selecting reverse or neutral isn't a shift, and neither is a reset back to first.
 */
export function isGearShift(prevGear: number, gear: number, speed: number): boolean {
  if (gear === prevGear) return false;
  if (Math.abs(speed) >= STANDSTILL) return true;
  return prevGear >= 1 && gear >= 1 && Math.abs(gear - prevGear) === 1;
}

/**
 * Impact pulse 0…1 for a jerk (m/s³, how fast the felt acceleration changes): nothing up to 500,
 * then from 0.35 up to full at 4000.
 */
export function impactLevel(jerk: number): number {
  if (!(jerk > IMPACT_JERK)) return 0;
  return IMPACT_MIN + (1 - IMPACT_MIN) * ramp(jerk, IMPACT_JERK, IMPACT_JERK_FULL);
}

/**
 * Mixes channel levels into the two motors: per motor 1 − Π(1 − level) over the enabled
 * channels, so effects add up without exceeding 1, times the master strength (0 when off).
 */
export function mixMotors(
  levels: Readonly<Record<RumbleChannel, RumbleOutput>>,
  settings: RumbleSettings,
  out: RumbleOutput,
): RumbleOutput {
  let strong = 1;
  let weak = 1;
  for (const { channel } of RUMBLE_CHANNELS) {
    if (settings.channels[channel] === false) continue;
    const level = levels[channel];
    strong *= 1 - clamp01(level.strong);
    weak *= 1 - clamp01(level.weak);
  }
  const k = settings.enabled ? clamp01(settings.strength) : 0;
  out.strong = (1 - strong) * k;
  out.weak = (1 - weak) * k;
  return out;
}

// ---------------------------------------------------------------- mixer

/** Share of each effect on the strong and the weak motor. */
const MOTORS = {
  wheelspin: { strong: 0.35, weak: 0.85 },
  lockup: { strong: 0.8, weak: 0.35 },
  abs: { strong: 0.3, weak: 0.75 },
  shift: { strong: 0.8, weak: 0.1 },
  denied: { strong: 0.25, weak: 0.8 },
  limiter: { strong: 0.05, weak: 0.45 },
  offroad: { strong: 0.75, weak: 0.3 },
  impact: { strong: 1, weak: 0.6 },
} as const;

/** Shortest time between two calls to the pad (less a little slack for frame timing). */
const SEND_INTERVAL = 0.05;
const SLACK = 0.001;
/** A normal effect's length: longer than the send interval, so the next call takes over. */
const EFFECT_TIME = 0.1;
/** An unchanged effect is renewed once it has less than this left to run. */
const RENEW_BEFORE = 0.03;
/** Output change (0…1) worth a new call. */
const CHANGE = 0.03;
/** Output below which running motors are stopped, and above which they start again. */
const OFF_LEVEL = 0.01;
const ON_LEVEL = 0.02;
/** An effect ending within this anyway isn't stopped early. */
const STOP_MARGIN = 0.02;
/** Shortest effect sent, and the silent one that stops pads without reset(). */
const MIN_EFFECT = 0.02;
/** Steady channels rise at once and fade out with this time constant (s). */
const RELEASE = 0.08;
/** The TC and ABS flags come from the last physics step of each frame and flicker: hold them. */
const FLAG_HOLD = 0.12;
/** ABS: every effect is cut to this, so the motors pulse at the call rate (15–20 Hz). */
const ABS_ON = 0.028;
/** Gear-change thump, and the two taps (with a pause) for a refused downshift. */
const SHIFT_TIME = 0.08;
const TAP_TIME = 0.045;
const TAP_GAP = 0.06;
/** Impact pulse length: short for a knock, longer for a crash. */
const IMPACT_TIME = 0.1;
const IMPACT_TIME_EXTRA = 0.1;
/** Rolling over, or landing back on the wheels. */
const ROLL_LEVEL = 0.8;
const ROLL_COOLDOWN = 0.5;
/** Grass: a new random bump level this often, between this and 1. */
const TEXTURE_STEP = 0.07;
const TEXTURE_MIN = 0.6;
/** Shortest time the jerk is measured over (guards against zero frame times). */
const MIN_JERK_TIME = 1 / 240;
/** After stop(), jumps in gear, flags and acceleration are only recorded for this long. */
const SETTLE_TIME = 0.3;
/** Longest frame counted, so a hitch can't skip whole pulses. */
const MAX_DT = 0.1;
/** Test pattern: thump, pause, buzz (0.6 s), and how long it may keep the pad at most. */
const TEST_THUMP = 0.2;
const TEST_GAP = 0.1;
const TEST_BUZZ = 0.3;
const TEST_TIMEOUT = 1;

const ms = (seconds: number): number => Math.round(seconds * 1000);
const ignore = (): void => {};

/** Rises at once; falls towards `target` keeping `keep` of the difference, and ends at 0. */
function fade(level: number, target: number, keep: number): number {
  if (target >= level) return target;
  const next = target + (level - target) * keep;
  return next < 1e-4 ? 0 : next;
}

/** Two effects on one motor: they add up without exceeding 1. */
const combine = (a: number, b: number): number => 1 - (1 - a) * (1 - b);

/** Time left of a pulse starting at `at` and lasting `length`, 0 outside it. */
const timeLeft = (now: number, at: number, length: number): number =>
  now >= at && now < at + length ? at + length - now : 0;

/** Time left of the current tap of a refused-downshift double tap starting at `at`. */
const tapLeft = (now: number, at: number): number =>
  Math.max(timeLeft(now, at, TAP_TIME), timeLeft(now, at + TAP_TIME + TAP_GAP, TAP_TIME));

function set(out: RumbleOutput, strong: number, weak: number): void {
  out.strong = strong;
  out.weak = weak;
}

/** Plays one effect and always returns a promise (old implementations throw instead). */
function playOnce(actuator: Actuator, params: EffectParams): Promise<unknown> {
  try {
    return Promise.resolve(actuator.playEffect?.(DUAL_RUMBLE, params));
  } catch (error) {
    return Promise.reject(error);
  }
}

/**
 * Mixes the rumble channels from the car state each frame and plays the result on a gamepad.
 * All timing runs on the sum of the frame times passed to update().
 */
export class RumbleMixer {
  settings: RumbleSettings;
  /** Latest mixed output (after strength), for tests and a debug readout. */
  readonly output: RumbleOutput = { strong: 0, weak: 0 };
  /** Rev limiter of the car being driven, rpm (the build-up starts 500 rpm below). */
  limiterRpm = TEST_MULE.engine.limiterRpm;

  private readonly levels: Record<RumbleChannel, RumbleOutput> = {
    wheelspin: { strong: 0, weak: 0 },
    lockup: { strong: 0, weak: 0 },
    shift: { strong: 0, weak: 0 },
    limiter: { strong: 0, weak: 0 },
    offroad: { strong: 0, weak: 0 },
    impact: { strong: 0, weak: 0 },
  };
  /** Reused for every call: browsers copy the parameters when playEffect is called. */
  private readonly params: EffectParams = {
    duration: 0,
    startDelay: 0,
    strongMagnitude: 0,
    weakMagnitude: 0,
  };
  private readonly random = mulberry32(0x6a7e);
  private clock = 0;

  // Steady channels, and the held TC / ABS flags.
  private spin = 0;
  private lock = 0;
  private limiter = 0;
  private grass = 0;
  private texture = 1;
  private textureAt = 0;
  private tcUntil = -Infinity;
  private absUntil = -Infinity;
  /** Largest motor output of the steady channels alone (after strength). */
  private steady = 0;

  // Recent frames, for edges (one frame back) and the jerk (two frames back). Nothing fires
  // before they are recorded, nor while settling.
  private history = 0;
  private settleUntil = -Infinity;
  private prevGear = 0;
  private prevFlags = 0;
  private prevDt = 0;
  private prevAccelLong = 0;
  private prevAccelLat = 0;
  private olderAccelLong = 0;
  private olderAccelLat = 0;

  // Pulses: when each starts on the clock (-Infinity = none).
  private shiftAt = -Infinity;
  private deniedAt = -Infinity;
  private impactAt = -Infinity;
  private impactSize = 0;
  private impactTime = 0;
  private rollAt = -Infinity;

  // The pad: when the next call is allowed, and the effect it is playing.
  private nextSendAt = -Infinity;
  private effectEnd = -Infinity;
  private sentStrong = 0;
  private sentWeak = 0;
  // The test pattern has the pad to itself until it ends (or times out, if its promises hang).
  private testToken = 0;
  private testUntil = -Infinity;

  constructor(settings: RumbleSettings = defaultRumbleSettings()) {
    this.settings = settings;
  }

  /**
   * Call once per rendered frame while driving. Computes the channels from the car state and
   * (at most ~20 times a second) sends a 'dual-rumble' effect lasting a bit longer than the
   * send interval, so consecutive effects overlap without gaps. Sends nothing (and stops the
   * motors once) when disabled, when the output is ~0 for a while, or without a capable pad.
   * While ABS works each effect is cut short instead, so the motors pulse at 15–20 Hz.
   */
  update(dt: number, car: CarRenderState, pad: RumblePad | null): void {
    try {
      const step = dt > 0 ? Math.min(dt, MAX_DT) : 0;
      this.clock += step;
      this.follow(step, car);
      this.detect(step, car);
      this.mix();
      const actuator = actuatorOf(pad);
      if (actuator && this.clock >= this.testUntil) this.send(actuator, step);
    } catch {
      // Rumble must never take the game loop down with it.
    }
  }

  /**
   * Stop the motors now (pause menu, tab hidden, reset). Also call it on a teleport: jumps in
   * gear and acceleration are ignored for the next 0.3 s, so the car landing in its new place
   * a frame or two later doesn't read as a shift or a crash.
   */
  stop(pad: RumblePad | null): void {
    this.testToken++;
    this.testUntil = -Infinity;
    this.spin = 0;
    this.lock = 0;
    this.limiter = 0;
    this.grass = 0;
    this.tcUntil = -Infinity;
    this.absUntil = -Infinity;
    this.shiftAt = -Infinity;
    this.deniedAt = -Infinity;
    this.impactAt = -Infinity;
    this.history = 0;
    this.settleUntil = this.clock + SETTLE_TIME;
    set(this.output, 0, 0);
    const actuator = actuatorOf(pad);
    if (actuator) {
      this.halt(actuator);
    } else {
      this.sentStrong = 0;
      this.sentWeak = 0;
      this.effectEnd = this.clock;
    }
  }

  /** A short test pattern for the settings screen (~0.6 s: a strong thump then a weak buzz). */
  test(pad: RumblePad | null): void {
    const actuator = actuatorOf(pad);
    const k = this.settings.enabled ? clamp01(this.settings.strength) : 0;
    if (!actuator || k === 0) return;
    const token = ++this.testToken;
    this.testUntil = this.clock + TEST_TIMEOUT;
    this.sentStrong = 0;
    this.sentWeak = 0;
    this.effectEnd = this.clock;
    const finish = (): void => {
      if (this.testToken === token) this.testUntil = -Infinity;
    };
    // Browsers play one effect at a time, so the buzz starts when the thump has finished.
    const buzz = (result: unknown): void => {
      if (this.testToken !== token || result === 'preempted') {
        finish();
        return;
      }
      playOnce(actuator, {
        duration: ms(TEST_BUZZ),
        startDelay: ms(TEST_GAP),
        strongMagnitude: 0.1 * k,
        weakMagnitude: k,
      }).then(finish, finish);
    };
    playOnce(actuator, {
      duration: ms(TEST_THUMP),
      startDelay: 0,
      strongMagnitude: k,
      weakMagnitude: 0.15 * k,
    }).then(buzz, finish);
  }

  /** Adds an impact pulse (0…1), e.g. from a collision event reported by the simulation. */
  impact(strength: number): void {
    const level = clamp01(strength);
    if (level > 0) this.hit(level);
  }

  /** Steady channels: follow the car state, rising at once and fading out over ~0.1 s. */
  private follow(dt: number, car: CarRenderState): void {
    const now = this.clock;
    if ((car.flags & FLAG_TC) !== 0) this.tcUntil = now + FLAG_HOLD;
    if ((car.flags & FLAG_ABS) !== 0) this.absUntil = now + FLAG_HOLD;
    const keep = Math.exp(-dt / RELEASE);
    this.spin = fade(this.spin, wheelspinLevel(car, now < this.tcUntil), keep);
    this.lock = fade(this.lock, lockupLevel(car), keep);
    this.limiter = fade(this.limiter, limiterLevel(car, this.limiterRpm), keep);
    this.grass = fade(this.grass, offroadLevel(car), keep);
    if (now >= this.textureAt) {
      // Grass is lumpy: a new random bump level several times a second.
      this.texture = TEXTURE_MIN + (1 - TEXTURE_MIN) * this.random();
      this.textureAt = now + TEXTURE_STEP;
    }
  }

  /** Edges against recent frames: gear changes, refused shifts, knocks, rolling over. */
  private detect(dt: number, car: CarRenderState): void {
    const now = this.clock;
    const flags = car.flags;
    const settled = now >= this.settleUntil;
    if (this.history >= 1 && settled) {
      if (isGearShift(this.prevGear, car.gear, car.speed)) this.shiftAt = this.nextSlot();
      if ((flags & FLAG_SHIFT_DENIED) !== 0 && (this.prevFlags & FLAG_SHIFT_DENIED) === 0) {
        this.deniedAt = this.nextSlot();
      }
      if (
        ((flags ^ this.prevFlags) & FLAG_UPSIDE_DOWN) !== 0 &&
        now >= this.rollAt + ROLL_COOLDOWN
      ) {
        this.rollAt = now;
        this.hit(ROLL_LEVEL);
      }
    }
    if (this.history >= 2 && settled) {
      // Over two frames: when the worker misses a frame, the next snapshot catches up, and a
      // one-frame measure would read that as a jump twice as sharp.
      const jump = Math.hypot(
        car.accelLong - this.olderAccelLong,
        car.accelLat - this.olderAccelLat,
      );
      const knock = impactLevel(jump / Math.max(dt + this.prevDt, MIN_JERK_TIME));
      if (knock > 0) this.hit(knock);
    }
    this.history = Math.min(this.history + 1, 2);
    this.prevGear = car.gear;
    this.prevFlags = flags;
    this.prevDt = dt;
    this.olderAccelLong = this.prevAccelLong;
    this.olderAccelLat = this.prevAccelLat;
    this.prevAccelLong = car.accelLong;
    this.prevAccelLat = car.accelLat;
  }

  /** Channel levels per motor, then the mix: once without the pulses, once with them. */
  private mix(): void {
    const now = this.clock;
    const l = this.levels;
    const spin = this.spin;
    const lock = this.lock;
    const abs = now < this.absUntil ? 1 : 0;
    const grass = this.grass * this.texture;
    set(l.wheelspin, spin * MOTORS.wheelspin.strong, spin * MOTORS.wheelspin.weak);
    set(
      l.lockup,
      combine(lock * MOTORS.lockup.strong, abs * MOTORS.abs.strong),
      combine(lock * MOTORS.lockup.weak, abs * MOTORS.abs.weak),
    );
    set(l.limiter, this.limiter * MOTORS.limiter.strong, this.limiter * MOTORS.limiter.weak);
    set(l.offroad, grass * MOTORS.offroad.strong, grass * MOTORS.offroad.weak);
    set(l.shift, 0, 0);
    set(l.impact, 0, 0);
    mixMotors(l, this.settings, this.output);
    this.steady = Math.max(this.output.strong, this.output.weak);

    const thump = timeLeft(now, this.shiftAt, SHIFT_TIME) > 0 ? 1 : 0;
    const tap = tapLeft(now, this.deniedAt) > 0 ? 1 : 0;
    set(
      l.shift,
      combine(thump * MOTORS.shift.strong, tap * MOTORS.denied.strong),
      combine(thump * MOTORS.shift.weak, tap * MOTORS.denied.weak),
    );
    const knock = timeLeft(now, this.impactAt, this.impactTime) > 0 ? this.impactSize : 0;
    set(l.impact, knock * MOTORS.impact.strong, knock * MOTORS.impact.weak);
    mixMotors(l, this.settings, this.output);
  }

  /** Decides whether this frame needs a call to the pad, and which. */
  private send(actuator: Actuator, dt: number): void {
    const now = this.clock;
    const out = this.output;
    const remaining = this.effectEnd - now;
    const running = remaining > 0 && (this.sentStrong > 0 || this.sentWeak > 0);
    const slotOpen = now >= this.nextSendAt;
    if (Math.max(out.strong, out.weak) < (running ? OFF_LEVEL : ON_LEVEL)) {
      // Nothing to feel: stop a running effect once, unless it ends by itself soon anyway.
      if (running && remaining > STOP_MARGIN && slotOpen) this.halt(actuator);
      return;
    }
    if (!slotOpen) return;
    const pulse = this.pulseLeft();
    const changed =
      Math.abs(out.strong - this.sentStrong) > CHANGE ||
      Math.abs(out.weak - this.sentWeak) > CHANGE;
    const covered =
      pulse > 0 ? remaining >= pulse - SLACK : remaining > Math.max(RENEW_BEFORE, 1.2 * dt);
    if (!changed && covered) return;
    let duration: number;
    if (pulse > 0) {
      // A pulse over nothing ends with the pulse; over a steady rumble a later call restores it.
      duration = this.steady < OFF_LEVEL ? Math.max(pulse, MIN_EFFECT) : EFFECT_TIME;
    } else if (now < this.absUntil && this.settings.channels.lockup !== false) {
      duration = ABS_ON;
    } else {
      duration = Math.max(EFFECT_TIME, 2 * dt);
    }
    this.sentStrong = out.strong;
    this.sentWeak = out.weak;
    this.effectEnd = now + duration;
    this.nextSendAt = now + SEND_INTERVAL - SLACK;
    this.call(actuator, out.strong, out.weak, duration);
  }

  /** Stops the motors: reset() where there is one, else a silent effect replacing the last. */
  private halt(actuator: Actuator): void {
    this.sentStrong = 0;
    this.sentWeak = 0;
    this.effectEnd = this.clock;
    this.nextSendAt = this.clock + SEND_INTERVAL - SLACK;
    if (!actuator.reset) {
      this.call(actuator, 0, 0, MIN_EFFECT);
      return;
    }
    try {
      actuator.reset()?.catch(ignore);
    } catch {
      // Old implementations throw instead of rejecting.
    }
  }

  private call(actuator: Actuator, strong: number, weak: number, duration: number): void {
    const p = this.params;
    p.duration = ms(duration);
    p.startDelay = 0;
    p.strongMagnitude = strong;
    p.weakMagnitude = weak;
    try {
      // Rejects with "preempted" when the next effect replaces this one, which is the plan.
      actuator.playEffect?.(DUAL_RUMBLE, p)?.catch(ignore);
    } catch {
      // Old implementations throw instead of rejecting.
    }
  }

  /** Time left of the pulse playing now (0 if none), for channels that are on. */
  private pulseLeft(): number {
    const now = this.clock;
    const on = this.settings.channels;
    let left = 0;
    if (on.shift !== false) {
      left = Math.max(timeLeft(now, this.shiftAt, SHIFT_TIME), tapLeft(now, this.deniedAt));
    }
    if (on.impact !== false) {
      left = Math.max(left, timeLeft(now, this.impactAt, this.impactTime));
    }
    return left;
  }

  /** When a pulse starting now can first be sent, so it's never cut short by the rate limit. */
  private nextSlot(): number {
    return Math.max(this.clock, this.nextSendAt);
  }

  private hit(level: number): void {
    const now = this.clock;
    const length = IMPACT_TIME + IMPACT_TIME_EXTRA * level;
    if (now < this.impactAt + this.impactTime) {
      // Already knocking: a bigger knock raises and lengthens that pulse (restarting it could
      // leave a gap until the next call), a smaller one is lost in it.
      if (level <= this.impactSize) return;
      this.impactSize = level;
      this.impactTime = Math.max(this.impactTime, Math.max(now - this.impactAt, 0) + length);
      return;
    }
    this.impactAt = this.nextSlot();
    this.impactSize = level;
    this.impactTime = length;
  }
}
