import { CURVE_KINDS, type CurveKind } from '../input/curves';
import { sanitizeProfile, type WheelProfile } from '../input/wheel';
import type { CameraMode } from '../render/ChaseCamera';
import {
  defaultAids,
  type AidLevel,
  type DriverAids,
  type SteerSmoothing,
} from '../shared/protocol';
import type { Units } from '../ui/Hud';

/**
 * Player settings, saved in localStorage as versioned JSON. Loading repairs anything missing
 * or invalid and upgrades older versions (Round 1 saved version 1). Round 3 moves this into
 * the full settings system with export/import.
 */

export interface PadSettings {
  steerDeadzone: number;
  /** Centre precision for the stick, 0 = linear … 1 = very fine near the centre. */
  steerLinearity: number;
  throttleCurve: CurveKind;
  brakeCurve: CurveKind;
  throttleDeadzone: number;
  brakeDeadzone: number;
}

export interface Settings {
  version: 2;
  resolutionScale: number;
  units: Units;
  overlay: boolean;
  telemetry: boolean;
  camera: CameraMode;
  aids: DriverAids;
  pad: PadSettings;
  audio: { volume: number; muted: boolean };
  /** Wheel profiles by gamepad id. */
  wheels: Record<string, WheelProfile>;
  /** Wheels the setup wizard already opened for automatically (it only does that once). */
  wheelsPrompted: string[];
}

const KEY = 'apex-gp.settings';

export const defaultPadSettings = (): PadSettings => ({
  steerDeadzone: 0.06,
  steerLinearity: 0.35,
  throttleCurve: 'linear',
  brakeCurve: 'linear',
  throttleDeadzone: 0.03,
  brakeDeadzone: 0.03,
});

export const defaultSettings = (): Settings => ({
  version: 2,
  resolutionScale: 1,
  units: 'metric',
  overlay: true,
  telemetry: false,
  camera: 'chase',
  aids: defaultAids(),
  pad: defaultPadSettings(),
  audio: { volume: 0.7, muted: false },
  wheels: {},
  wheelsPrompted: [],
});

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;
const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : fallback;
const oneOf = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

const AID_LEVELS: readonly AidLevel[] = ['off', 'low', 'high'];
const SMOOTHING: readonly SteerSmoothing[] = ['low', 'medium', 'high'];
const CAMERAS: readonly CameraMode[] = ['chase', 'chase-far', 'bonnet'];

/** Turns whatever was stored (any version, possibly corrupt) into valid current settings. */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObject(raw)) return d;
  const aids = isObject(raw.aids) ? raw.aids : {};
  const pad = isObject(raw.pad) ? raw.pad : {};
  const audio = isObject(raw.audio) ? raw.audio : {};
  const wheels: Record<string, WheelProfile> = {};
  if (isObject(raw.wheels)) {
    for (const value of Object.values(raw.wheels)) {
      const profile = sanitizeProfile(value);
      if (profile) wheels[profile.id] = profile;
    }
  }
  return {
    version: 2,
    // Version 1 fields keep their names, so they carry over as they are.
    resolutionScale: num(raw.resolutionScale, 0.25, 1.5, d.resolutionScale),
    units: raw.units === 'imperial' ? 'imperial' : 'metric',
    overlay: typeof raw.overlay === 'boolean' ? raw.overlay : d.overlay,
    telemetry: typeof raw.telemetry === 'boolean' ? raw.telemetry : d.telemetry,
    camera: oneOf(raw.camera, CAMERAS, d.camera),
    aids: {
      abs: oneOf(aids.abs, AID_LEVELS, d.aids.abs),
      tc: oneOf(aids.tc, AID_LEVELS, d.aids.tc),
      gearbox: aids.gearbox === 'manual' ? 'manual' : 'auto',
      steerSensitivity: num(aids.steerSensitivity, 0.5, 1.5, d.aids.steerSensitivity),
      steerSmoothing: oneOf(aids.steerSmoothing, SMOOTHING, d.aids.steerSmoothing),
    },
    pad: {
      steerDeadzone: num(pad.steerDeadzone, 0, 0.3, d.pad.steerDeadzone),
      steerLinearity: num(pad.steerLinearity, 0, 1, d.pad.steerLinearity),
      throttleCurve: oneOf(pad.throttleCurve, CURVE_KINDS, d.pad.throttleCurve),
      brakeCurve: oneOf(pad.brakeCurve, CURVE_KINDS, d.pad.brakeCurve),
      throttleDeadzone: num(pad.throttleDeadzone, 0, 0.3, d.pad.throttleDeadzone),
      brakeDeadzone: num(pad.brakeDeadzone, 0, 0.3, d.pad.brakeDeadzone),
    },
    audio: {
      volume: num(audio.volume, 0, 1, d.audio.volume),
      muted: typeof audio.muted === 'boolean' ? audio.muted : d.audio.muted,
    },
    wheels,
    wheelsPrompted: Array.isArray(raw.wheelsPrompted)
      ? raw.wheelsPrompted.filter((id): id is string => typeof id === 'string').slice(0, 32)
      : [],
  };
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? parseSettings(JSON.parse(raw)) : defaultSettings();
  } catch {
    // Private mode, blocked storage or corrupt data: fall back to defaults.
    return defaultSettings();
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings just won't persist.
  }
}
