/**
 * Shaping for analogue controls: dead zones, saturation and response curves. Pure functions so
 * they can be unit tested and shared by pads, wheels and (later) touch controls.
 */

export type CurveKind = 'linear' | 'progressive' | 'aggressive';

export const CURVE_KINDS: readonly CurveKind[] = ['linear', 'progressive', 'aggressive'];

const CURVE_EXPONENT = 1.8;

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : 0);

/**
 * Response curve on 0…1. Progressive is gentle at first (fine control of the first half of the
 * travel); aggressive is the opposite (most of the effect early on).
 */
export function applyCurve(value: number, kind: CurveKind): number {
  const v = clamp01(value);
  switch (kind) {
    case 'progressive':
      return Math.pow(v, CURVE_EXPONENT);
    case 'aggressive':
      return 1 - Math.pow(1 - v, CURVE_EXPONENT);
    default:
      return v;
  }
}

/**
 * Maps 0…1 so that travel below `deadzone` reads 0 and travel beyond `saturation` reads 1,
 * rescaling the part in between.
 */
export function pedalRange(value: number, deadzone: number, saturation = 1): number {
  if (!(value > deadzone)) return 0;
  const top = Math.max(saturation, deadzone + 0.01);
  return clamp01((value - deadzone) / (top - deadzone));
}

export interface TriggerShape {
  curve: CurveKind;
  deadzone: number;
  saturation: number;
}

/** A pad trigger or wheel pedal: dead zone and saturation first, then the response curve. */
export function shapePedal(value: number, shape: TriggerShape): number {
  return applyCurve(pedalRange(value, shape.deadzone, shape.saturation), shape.curve);
}

/**
 * Signed steering input (-1…1): an axial dead zone (rescaled so the output starts at 0), then
 * centre precision. `linearity` 0 is linear; towards 1 small movements do less while full lock
 * stays full lock: out = (1 − k)·x + k·x³.
 */
export function shapeSteer(value: number, deadzone: number, linearity: number): number {
  if (!Number.isFinite(value)) return 0;
  const magnitude = Math.abs(value);
  if (magnitude <= deadzone) return 0;
  const x = Math.min((magnitude - deadzone) / (1 - deadzone), 1);
  const k = clamp01(linearity);
  return Math.sign(value) * ((1 - k) * x + k * x * x * x);
}
