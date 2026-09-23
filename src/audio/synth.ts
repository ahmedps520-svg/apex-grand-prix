/**
 * Pure maths for the placeholder engine and tyre sound: how car state maps to sound settings, plus
 * the waveforms, saturation curves and noise the synthesiser plays. No Web Audio in here, so all of
 * it runs (and is tested) in Node.
 */
import { clamp, mulberry32 } from '../shared/math';

/** GT3-style test car V8. */
export const IDLE_RPM = 900;
export const LIMITER_RPM = 8000;
/** Playable rpm range: keeps the oscillators out of sub-audio and silly pitches. */
const MIN_RPM = 400;
const MAX_RPM = 9000;
/** Speeds above this don't change the sound any more, m/s. */
const MAX_SPEED = 120;

/** Clamps to [0, 1]; NaN (or a missing value) gives 0. */
export const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Engine speed clamped to the playable range; NaN gives idle. */
export function engineRpm(rpm: number): number {
  if (rpm > MAX_RPM) return MAX_RPM;
  if (rpm >= MIN_RPM) return rpm;
  return rpm < MIN_RPM ? MIN_RPM : IDLE_RPM;
}

/** Road speed magnitude, clamped; NaN gives 0. */
function speedOf(speed: number): number {
  const v = Math.abs(speed);
  return v > MAX_SPEED ? MAX_SPEED : v >= 0 ? v : 0;
}

/** 0 at idle … 1 at the rev limiter. */
export const rpmFraction = (rpm: number): number =>
  clamp01((engineRpm(rpm) - IDLE_RPM) / (LIMITER_RPM - IDLE_RPM));

/** Firing frequency of a four-stroke V8 (four firings per crank revolution), Hz. */
export const firingFrequency = (rpm: number): number => (engineRpm(rpm) / 60) * 4;

/**
 * One full four-stroke cycle (two crank revolutions), Hz: the fundamental of the exhaust wave. Its
 * 8th harmonic is the firing frequency; the lower ones are the V8 burble.
 */
export const cycleFrequency = (rpm: number): number => engineRpm(rpm) / 120;

/** Engine loudness 0…1: louder with rpm, and on load than on overrun. */
export function engineGain(rpm: number, throttle: number): number {
  return (0.45 + 0.55 * rpmFraction(rpm)) * (0.4 + 0.6 * clamp01(throttle));
}

/** Engine lowpass cutoff, Hz: opens with rpm and much more on load; muffled on overrun. */
export function engineCutoff(rpm: number, throttle: number): number {
  const t = clamp01(throttle);
  return 450 + 450 * t + firingFrequency(rpm) * (2.5 + 4 * t);
}

/** Pre-gain into the saturator: harder on load for a harsher, more mechanical tone. */
export function engineDrive(rpm: number, throttle: number): number {
  return 1 + 2.2 * clamp01(throttle) * (0.4 + 0.6 * rpmFraction(rpm));
}

/** Level of the combustion noise ("rasp") pulsed onto the exhaust note, 0…1. */
export function raspGain(rpm: number, throttle: number): number {
  return 0.15 + 0.85 * clamp01(throttle) * (0.35 + 0.65 * rpmFraction(rpm));
}

/** Centre of the combustion-noise band, Hz. */
export const raspFrequency = (rpm: number): number => 500 + 3.5 * firingFrequency(rpm);

/** Depth of the random amplitude wobble: lumpy at idle, smooth at high rpm on load. */
export function engineRoughness(rpm: number, throttle: number): number {
  return 0.08 + 0.22 * (1 - rpmFraction(rpm)) * (1 - 0.5 * clamp01(throttle));
}

/** Depth of the random pitch wander, cents. */
export const engineJitter = (rpm: number): number => 14 - 9 * rpmFraction(rpm);

/**
 * Tyre squeal loudness 0…1: starts near the grip limit (slip 0.8), full by slip 1.3, needs some
 * rolling speed, and fades out on grass.
 */
export function squealGain(slip: number, speed: number, offRoad: number): number {
  return smoothstep(0.8, 1.3, slip) * smoothstep(3, 10, speedOf(speed)) * (1 - clamp01(offRoad));
}

/** Squeal pitch, Hz: rises a little with speed and with how hard the tyre slides. */
export function squealFrequency(speed: number, slip: number): number {
  return 1100 + 11 * Math.min(speedOf(speed), 80) + 350 * clamp01(slip - 1);
}

/** Wind and road noise 0…1, rising with the square of speed (full at ~270 km/h). */
export function windGain(speed: number): number {
  const v = speedOf(speed) / 75;
  return clamp01(v * v);
}

/** Wind noise lowpass cutoff, Hz. */
export const windCutoff = (speed: number): number => 250 + 20 * speedOf(speed);

/** Soft rumble while rolling on grass, 0…1. */
export const grassGain = (offRoad: number, speed: number): number =>
  clamp01(offRoad) * smoothstep(1, 12, speedOf(speed));

/** Fourier terms for `createPeriodicWave` (index 0, the DC term, is unused). */
export interface Waveform {
  real: Float32Array<ArrayBuffer>;
  imag: Float32Array<ArrayBuffer>;
  /** Lowest value of the waveform; its peak is normalised to 1. */
  min: number;
}

export interface ExhaustShape {
  /** Pulse decay time as a fraction of the cycle: longer is rounder and darker. */
  decay: number;
  /** Pulse rise time as a fraction of the cycle: shorter is sharper and brighter. */
  rise: number;
  /** Strength of the far bank's pulses; below 1 gives the cross-plane burble. */
  farBank: number;
  /** Random cylinder-to-cylinder strength variation, 0…1. */
  spread: number;
  seed: number;
}

/** Bank of each 90° firing slot for firing order 1-8-4-3-6-5-7-2 (0 = the bank we hear most). */
const CROSS_PLANE_BANKS = [0, 1, 1, 0, 1, 0, 0, 1];
const WAVE_SAMPLES = 1024;

/**
 * One cycle of a cross-plane V8's exhaust pressure as heard from one side, as Fourier terms for a
 * PeriodicWave played at `cycleFrequency`. Each bank fires at uneven intervals, which puts energy
 * below the firing frequency: the burble.
 */
export function v8ExhaustWave(shape: ExhaustShape, harmonics = 128): Waveform {
  const rand = mulberry32(shape.seed);
  const pulses = CROSS_PLANE_BANKS.map((bank, slot) => ({
    start: slot / 8,
    strength: (bank === 0 ? 1 : shape.farBank) * (1 + shape.spread * (2 * rand() - 1)),
  }));
  const samples = new Float64Array(WAVE_SAMPLES);
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    let sum = 0;
    for (const { start, strength } of pulses) {
      let x = i / WAVE_SAMPLES - start;
      if (x < 0) x += 1;
      sum += strength * (1 - Math.exp(-x / shape.rise)) * Math.exp(-x / shape.decay);
    }
    samples[i] = sum;
  }
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let h = 1; h < harmonics; h++) {
    let a = 0;
    let b = 0;
    samples.forEach((s, i) => {
      const phase = (2 * Math.PI * h * i) / WAVE_SAMPLES;
      a += s * Math.cos(phase);
      b += s * Math.sin(phase);
    });
    real[h] = (2 * a) / WAVE_SAMPLES;
    imag[h] = (2 * b) / WAVE_SAMPLES;
  }
  return normalise(real, imag);
}

/** A square wave with softened edges (odd harmonics, Lanczos-smoothed) so gating it can't click. */
export function softSquareWave(harmonics = 8): Waveform {
  const real = new Float32Array(harmonics);
  const imag = new Float32Array(harmonics);
  for (let h = 1; h < harmonics; h += 2) {
    const x = (Math.PI * h) / harmonics;
    imag[h] = (4 / (Math.PI * h)) * (Math.sin(x) / x);
  }
  return normalise(real, imag);
}

/** Scales the terms so the band-limited waveform peaks at exactly 1, and reports its minimum. */
function normalise(real: Float32Array<ArrayBuffer>, imag: Float32Array<ArrayBuffer>): Waveform {
  let peak = 0;
  let min = 0;
  for (let i = 0; i < WAVE_SAMPLES; i++) {
    let v = 0;
    for (let h = 1; h < real.length; h++) {
      const phase = (2 * Math.PI * h * i) / WAVE_SAMPLES;
      v += (real[h] ?? 0) * Math.cos(phase) + (imag[h] ?? 0) * Math.sin(phase);
    }
    peak = Math.max(peak, Math.abs(v));
    min = Math.min(min, v);
  }
  const scale = peak > 0 ? 1 / peak : 0;
  for (let h = 0; h < real.length; h++) {
    real[h] = (real[h] ?? 0) * scale;
    imag[h] = (imag[h] ?? 0) * scale;
  }
  return { real, imag, min: min * scale };
}

/** WaveShaper curve: tanh saturation normalised to ±1. Odd length, so silence maps to silence. */
export function saturationCurve(drive: number, length = 1025): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  const norm = Math.tanh(drive);
  for (let i = 0; i < length; i++) {
    curve[i] = Math.tanh(drive * ((2 * i) / (length - 1) - 1)) / norm;
  }
  return curve;
}

/**
 * Last-resort clip guard: exactly linear below `knee`, then bends smoothly towards `ceiling`, so
 * the output can never reach full scale.
 */
export function softClipCurve(
  knee = 0.75,
  ceiling = 0.98,
  length = 2049,
): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(length);
  const room = ceiling - knee;
  for (let i = 0; i < length; i++) {
    const x = (2 * i) / (length - 1) - 1;
    const a = Math.abs(x);
    curve[i] = Math.sign(x) * (a <= knee ? a : knee + room * Math.tanh((a - knee) / room));
  }
  return curve;
}

/** Fills `out` with uniform white noise in [-1, 1). */
export function fillWhiteNoise(out: Float32Array, seed: number): void {
  const rand = mulberry32(seed);
  for (let i = 0; i < out.length; i++) out[i] = rand() * 2 - 1;
}

/**
 * Fills `out` with a smooth random wander peaking at ±1: random points, `rate` per second,
 * joined by cosine curves. The end joins the start, so it loops without a seam.
 */
export function fillWander(
  out: Float32Array,
  sampleRate: number,
  rate: number,
  seed: number,
): void {
  const rand = mulberry32(seed);
  const count = Math.max(2, Math.round((out.length / sampleRate) * rate));
  const points = Array.from({ length: count }, () => rand() * 2 - 1);
  const peak = Math.max(...points.map(Math.abs));
  const perPoint = out.length / count;
  for (let i = 0; i < out.length; i++) {
    const u = i / perPoint;
    const k = Math.floor(u);
    const a = points[k % count] ?? 0;
    const b = points[(k + 1) % count] ?? 0;
    const w = (1 - Math.cos(Math.PI * (u - k))) / 2;
    out[i] = (a + (b - a) * w) / peak;
  }
}

/** Frame-rate-aware smoothing time constant: at low frame rates, glide over more of a frame. */
export const glideTime = (dt: number, min: number, max: number): number =>
  clamp(dt > 0 ? dt * 0.5 : 0, min, max);
