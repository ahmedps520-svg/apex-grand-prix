import { shapePedal, shapeSteer, type CurveKind } from './curves';

/**
 * Steering wheels and pedals. Browsers expose them as gamepads without a standard layout (axis
 * and button numbers differ per wheel, driver and operating system), so each wheel gets a
 * profile made by the setup wizard and edited in the wheel settings. Pure code: the input
 * manager reads raw gamepad values and the functions here turn them into driver controls.
 */

/** A button on the wheel, or a direction of a hat switch reported as an axis. */
export type ButtonBinding =
  { type: 'button'; index: number } | { type: 'axis'; index: number; value: number };

export type WheelAction =
  | 'shiftUp'
  | 'shiftDown'
  | 'handbrake'
  | 'camera'
  | 'reset'
  | 'telemetry'
  | 'menuNext'
  | 'menuPrev'
  | 'menuUp'
  | 'menuDown';

export const WHEEL_ACTIONS: ReadonlyArray<{ action: WheelAction; label: string }> = [
  { action: 'shiftUp', label: 'Shift up (right paddle)' },
  { action: 'shiftDown', label: 'Shift down (left paddle)' },
  { action: 'handbrake', label: 'Handbrake' },
  { action: 'camera', label: 'Change camera' },
  { action: 'reset', label: 'Reset car' },
  { action: 'telemetry', label: 'Telemetry panel' },
  { action: 'menuNext', label: 'Quick menu: next setting' },
  { action: 'menuPrev', label: 'Quick menu: previous setting' },
  { action: 'menuUp', label: 'Quick menu: increase' },
  { action: 'menuDown', label: 'Quick menu: decrease' },
];

export interface PedalBinding {
  axis: number;
  /** Raw axis value with the pedal released, and fully pressed. */
  rest: number;
  full: number;
  curve: CurveKind;
  /** Fraction of travel ignored at the start (0…0.3). */
  deadzone: number;
  /** Fraction of travel that already reads 100 % (0.5…1). */
  saturation: number;
}

export interface WheelProfile {
  version: 1;
  /** Gamepad id the profile belongs to. */
  id: string;
  name: string;
  steer: { axis: number; left: number; center: number; right: number };
  /** Lock-to-lock rotation set in the wheel's driver, degrees (G29/G923 default: 900). */
  rotation: number;
  /** Dead zone around the centre, as a fraction of half the rotation. */
  steerDeadzone: number;
  /** Centre precision: 0 = linear … 1 = much finer near the centre. */
  steerLinearity: number;
  throttle: PedalBinding | null;
  brake: PedalBinding | null;
  clutch: PedalBinding | null;
  buttons: Partial<Record<WheelAction, ButtonBinding>>;
}

export interface WheelReading {
  /** Steering-wheel angle, radians (+ = right). */
  angle: number;
  /** -1…1 fraction of half the rotation, after dead zone and linearity (for display). */
  steer: number;
  throttle: number;
  brake: number;
  clutch: number;
}

const WHEEL_ID =
  /wheel|racing|driving force|\bg2[579]\b|\bg92[03]\b|thrustmaster|fanatec|moza|simucube|simagic|\bt(150|300|248|gt|mx|500|818)\b/i;
/** USB vendor ids: Thrustmaster, Fanatec, Moza. */
const WHEEL_VENDORS = /\b(044f|0eb7|346e)\b/i;
/** Logitech wheels (the vendor also makes pads, so match product ids). */
const LOGITECH_WHEELS =
  /046d.{0,20}\b(c24f|c260|c261|c262|c266|c26d|c26e|c29a|c29b|c299|c294|c298|ca03)\b/i;

/** Best guess from the gamepad id whether this is a steering wheel. */
export function looksLikeWheel(id: string): boolean {
  return WHEEL_ID.test(id) || WHEEL_VENDORS.test(id) || LOGITECH_WHEELS.test(id);
}

/** Maps a raw steering axis value to -1…1 using the calibrated left, centre and right values. */
export function steerFraction(raw: number, steer: WheelProfile['steer']): number {
  const t = raw - steer.center;
  const toRight = steer.right - steer.center;
  const toLeft = steer.left - steer.center;
  let n: number;
  if (toRight !== 0 && Math.sign(t) === Math.sign(toRight)) n = t / toRight;
  else if (toLeft !== 0) n = -t / toLeft;
  else n = 0;
  return n > 1 ? 1 : n < -1 ? -1 : n;
}

/** Maps a raw pedal axis to 0…1 through its calibration, dead zone, saturation and curve. */
export function pedalValue(raw: number, pedal: PedalBinding): number {
  const span = pedal.full - pedal.rest;
  if (span === 0 || !Number.isFinite(raw)) return 0;
  const travel = (raw - pedal.rest) / span;
  return shapePedal(travel, pedal);
}

/** True while the bound button is held (hat directions match within ±0.15). */
export function buttonDown(binding: ButtonBinding | undefined, pad: GamepadLike): boolean {
  if (!binding) return false;
  if (binding.type === 'button') return pad.buttons[binding.index]?.pressed ?? false;
  const v = pad.axes[binding.index];
  return v !== undefined && Math.abs(v - binding.value) < 0.15;
}

/** The parts of the Gamepad API the wheel code reads (so tests can pass plain objects). */
export interface GamepadLike {
  id: string;
  axes: readonly number[];
  buttons: ReadonlyArray<{ pressed: boolean; value: number }>;
}

export function readWheel(
  pad: GamepadLike,
  profile: WheelProfile,
  out: WheelReading,
): WheelReading {
  const raw = pad.axes[profile.steer.axis] ?? profile.steer.center;
  const fraction = steerFraction(raw, profile.steer);
  const steer = shapeSteer(fraction, profile.steerDeadzone, profile.steerLinearity);
  out.steer = steer;
  out.angle = ((steer * profile.rotation) / 2) * (Math.PI / 180);
  const axis = (p: PedalBinding | null) => (p ? pedalValue(pad.axes[p.axis] ?? p.rest, p) : 0);
  out.throttle = axis(profile.throttle);
  out.brake = axis(profile.brake);
  out.clutch = axis(profile.clutch);
  return out;
}

export const wheelReading = (): WheelReading => ({
  angle: 0,
  steer: 0,
  throttle: 0,
  brake: 0,
  clutch: 0,
});

export const defaultPedal = (axis: number, rest: number, full: number): PedalBinding => ({
  axis,
  rest,
  full,
  curve: 'linear',
  deadzone: 0.02,
  saturation: 1,
});

/** Fills in anything missing or invalid in a stored profile (e.g. from an older version). */
export function sanitizeProfile(value: unknown): WheelProfile | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<WheelProfile>;
  const num = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
  const s = p.steer;
  if (typeof p.id !== 'string' || !s || typeof s !== 'object') return null;
  const pedal = (v: unknown): PedalBinding | null => {
    if (!v || typeof v !== 'object') return null;
    const b = v as Partial<PedalBinding>;
    if (typeof b.axis !== 'number' || typeof b.rest !== 'number' || typeof b.full !== 'number') {
      return null;
    }
    return {
      axis: Math.floor(num(b.axis, 0, 63, 0)),
      rest: num(b.rest, -1, 1, 1),
      full: num(b.full, -1, 1, -1),
      curve: b.curve === 'progressive' || b.curve === 'aggressive' ? b.curve : 'linear',
      deadzone: num(b.deadzone, 0, 0.3, 0.02),
      saturation: num(b.saturation, 0.5, 1, 1),
    };
  };
  const buttons: Partial<Record<WheelAction, ButtonBinding>> = {};
  const rawButtons = (p.buttons ?? {}) as Record<string, unknown>;
  for (const { action } of WHEEL_ACTIONS) {
    const b = rawButtons[action] as Partial<ButtonBinding> | undefined;
    if (!b || typeof b.index !== 'number') continue;
    if (b.type === 'button') buttons[action] = { type: 'button', index: b.index };
    else if (b.type === 'axis' && typeof b.value === 'number') {
      buttons[action] = { type: 'axis', index: b.index, value: b.value };
    }
  }
  return {
    version: 1,
    id: p.id,
    name: typeof p.name === 'string' ? p.name : p.id,
    steer: {
      axis: Math.floor(num(s.axis, 0, 63, 0)),
      left: num(s.left, -1, 1, -1),
      center: num(s.center, -1, 1, 0),
      right: num(s.right, -1, 1, 1),
    },
    rotation: num(p.rotation, 90, 1080, 900),
    steerDeadzone: num(p.steerDeadzone, 0, 0.2, 0),
    steerLinearity: num(p.steerLinearity, 0, 1, 0),
    throttle: pedal(p.throttle),
    brake: pedal(p.brake),
    clutch: pedal(p.clutch),
    buttons,
  };
}
