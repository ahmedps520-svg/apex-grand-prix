import { defaultLivery, sanitizeLivery, type Livery } from '../content/livery';
import { sanitizeBindings, defaultBindings, type Bindings } from '../input/bindings';
import { CURVE_KINDS, type CurveKind } from '../input/curves';
import {
  RUMBLE_CHANNELS,
  defaultRumbleSettings,
  type RumbleChannel,
  type RumbleSettings,
} from '../input/rumble';
import { sanitizeProfile, type WheelProfile } from '../input/wheel';
import type { CameraMode } from '../render/ChaseCamera';
import {
  defaultAids,
  type AidLevel,
  type DriverAids,
  type SteerSmoothing,
} from '../shared/protocol';
import type { Units } from '../ui/Hud';
import type { PromptSetting } from '../ui/menu/prompts';

/**
 * Player settings, saved in localStorage as versioned JSON. Loading repairs anything missing
 * or invalid and upgrades older versions: Round 1 saved version 1, Round 2 version 2. Fields keep
 * their names across versions, so an upgrade is "keep what's there, fill in the rest".
 */

export interface PadSettings {
  /** Inner dead zone of the steering stick. */
  steerDeadzone: number;
  /** Outer dead zone: stick travel that already gives full steering (0.8 … 1). */
  steerSaturation: number;
  /** Centre precision for the stick, 0 = linear … 1 = very fine near the centre. */
  steerLinearity: number;
  throttleCurve: CurveKind;
  brakeCurve: CurveKind;
  throttleDeadzone: number;
  brakeDeadzone: number;
}

export type Detail = 'auto' | 'low' | 'medium' | 'high';

export interface Settings {
  version: 3;
  resolutionScale: number;
  /** World detail (open-world draw distance, buildings, shadows); auto picks by device. */
  detail: Detail;
  units: Units;
  overlay: boolean;
  telemetry: boolean;
  /** Size of the driving HUD's panels, 1 = as designed. */
  hudScale: number;
  /** Standard colours, or a colour-safe palette (blue and orange for green and red). */
  palette: Palette;
  /** Post-processing: by the detail level (auto), none, a bloom, or a bloom with ambient occlusion. */
  effects: EffectsSetting;
  /**
   * Graphics preset: by the device (auto), a named level (its values are copied into the
   * choices below), or custom (the choices below as they are).
   */
  preset: GraphicsPreset;
  /** Screen-space ray-traced reflections on the wet road, the paint and the glass. */
  reflections: boolean;
  /** Edge smoothing with post-processing on (the plain render uses the renderer's MSAA). */
  antialiasing: AntiAliasing;
  /** Sun shadow map size and softness. */
  shadows: ShadowQuality;
  /** Road surfaces: plain textures, or detailed asphalt with the racing line rubbered in. */
  surfaces: SurfaceQuality;
  /** Tyre marks laid on the road by sliding and locked wheels. */
  skidMarks: boolean;
  camera: CameraMode;
  aids: DriverAids;
  pad: PadSettings;
  /** Volume is the engine and race sound; music and sfx are the menus'. */
  audio: { volume: number; muted: boolean; music: number; sfx: number };
  /** Time trial: show the best lap as a see-through car. */
  ghost: boolean;
  /** Driving school: finished, and offered once on the first visit. */
  schoolDone: boolean;
  schoolOffered: boolean;
  /** Free roam: the first-drive hints have been shown. */
  roamHinted: boolean;
  /** How much crashes damage the car. */
  damage: DamageLevel;
  /** Race engineer: spoken calls and subtitles. */
  radio: { voice: boolean; subtitles: boolean; volume: number };
  /** Wheel profiles by gamepad id. */
  wheels: Record<string, WheelProfile>;
  /** Wheels the setup wizard already opened for automatically (it only does that once). */
  wheelsPrompted: string[];
  /** Button prompt style in menus. */
  prompts: PromptSetting;
  /** Touch screens: steer by dragging on the left half, or by tilting the device. */
  touchSteering: 'drag' | 'tilt';
  /** Player's car colour (hex): the livery's primary colour, kept for older saves. */
  paint: number;
  /** Player's livery: colours, pattern, race number and finish. */
  livery: Livery;
  rumble: RumbleSettings;
  bindings: Bindings;
}

export type Palette = 'standard' | 'colourSafe';
export type EffectsSetting = 'auto' | 'off' | 'bloom' | 'full';
const EFFECTS: readonly EffectsSetting[] = ['auto', 'off', 'bloom', 'full'];
export type GraphicsPreset = 'auto' | 'low' | 'medium' | 'high' | 'ultra' | 'custom';
export const GRAPHICS_PRESET_NAMES: readonly GraphicsPreset[] = [
  'auto',
  'low',
  'medium',
  'high',
  'ultra',
  'custom',
];
export type AntiAliasing = 'off' | 'fxaa' | 'smaa';
const ANTIALIASING: readonly AntiAliasing[] = ['off', 'fxaa', 'smaa'];
export type ShadowQuality = 'low' | 'medium' | 'high' | 'ultra';
const SHADOWS: readonly ShadowQuality[] = ['low', 'medium', 'high', 'ultra'];
export type SurfaceQuality = 'standard' | 'detailed';
const SURFACES: readonly SurfaceQuality[] = ['standard', 'detailed'];
export type DamageLevel = 'off' | 'light' | 'full';
const DAMAGE_LEVELS: readonly DamageLevel[] = ['off', 'light', 'full'];
/** Damage setting → how much impacts hurt (see Car.damageScale). */
export const DAMAGE_SCALE: Record<DamageLevel, number> = { off: 0, light: 0.5, full: 1 };

export const SETTINGS_VERSION = 3;

const KEY = 'apex-gp.settings';

export const defaultPadSettings = (): PadSettings => ({
  steerDeadzone: 0.06,
  steerSaturation: 0.98,
  steerLinearity: 0.35,
  throttleCurve: 'linear',
  brakeCurve: 'linear',
  throttleDeadzone: 0.03,
  brakeDeadzone: 0.03,
});

export const defaultSettings = (): Settings => ({
  version: 3,
  resolutionScale: 1,
  detail: 'auto',
  units: 'metric',
  overlay: false,
  telemetry: false,
  hudScale: 1,
  palette: 'standard',
  effects: 'auto',
  preset: 'auto',
  reflections: false,
  antialiasing: 'smaa',
  shadows: 'medium',
  surfaces: 'detailed',
  skidMarks: true,
  camera: 'chase',
  aids: defaultAids(),
  pad: defaultPadSettings(),
  audio: { volume: 0.7, muted: false, music: 0.6, sfx: 0.7 },
  ghost: true,
  schoolDone: false,
  schoolOffered: false,
  roamHinted: false,
  damage: 'light',
  radio: { voice: true, subtitles: true, volume: 0.9 },
  wheels: {},
  wheelsPrompted: [],
  prompts: 'auto',
  touchSteering: 'drag',
  paint: 0xa3101f,
  livery: defaultLivery(),
  rumble: defaultRumbleSettings(),
  bindings: defaultBindings(),
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
const PROMPTS: readonly PromptSetting[] = [
  'auto',
  'playstation',
  'xbox',
  'generic',
  'keyboard',
  'touch',
];

/** Turns whatever was stored (any version, possibly corrupt) into valid current settings. */
export function parseSettings(raw: unknown): Settings {
  const d = defaultSettings();
  if (!isObject(raw)) return d;
  const aids = isObject(raw.aids) ? raw.aids : {};
  const pad = isObject(raw.pad) ? raw.pad : {};
  const audio = isObject(raw.audio) ? raw.audio : {};
  const radio = isObject(raw.radio) ? raw.radio : {};
  const paint =
    typeof raw.paint === 'number' && Number.isInteger(raw.paint) && raw.paint >= 0
      ? Math.min(raw.paint, 0xffffff)
      : d.paint;
  const rumble = isObject(raw.rumble) ? raw.rumble : {};
  const channels = isObject(rumble.channels) ? rumble.channels : {};
  const rumbleChannels = { ...d.rumble.channels };
  for (const { channel } of RUMBLE_CHANNELS) {
    const v = channels[channel];
    if (typeof v === 'boolean') rumbleChannels[channel as RumbleChannel] = v;
  }
  const wheels: Record<string, WheelProfile> = {};
  if (isObject(raw.wheels)) {
    for (const value of Object.values(raw.wheels)) {
      const profile = sanitizeProfile(value);
      if (profile) wheels[profile.id] = profile;
    }
  }
  return {
    version: SETTINGS_VERSION,
    // Version 1 fields keep their names, so they carry over as they are.
    resolutionScale: num(raw.resolutionScale, 0.25, 1.5, d.resolutionScale),
    detail:
      raw.detail === 'low' || raw.detail === 'medium' || raw.detail === 'high'
        ? raw.detail
        : 'auto',
    units: raw.units === 'imperial' ? 'imperial' : 'metric',
    overlay: typeof raw.overlay === 'boolean' ? raw.overlay : d.overlay,
    telemetry: typeof raw.telemetry === 'boolean' ? raw.telemetry : d.telemetry,
    hudScale: num(raw.hudScale, 0.7, 1.5, d.hudScale),
    palette: raw.palette === 'colourSafe' ? 'colourSafe' : 'standard',
    effects: oneOf(raw.effects, EFFECTS, d.effects),
    preset: oneOf(raw.preset, GRAPHICS_PRESET_NAMES, d.preset),
    reflections: typeof raw.reflections === 'boolean' ? raw.reflections : d.reflections,
    antialiasing: oneOf(raw.antialiasing, ANTIALIASING, d.antialiasing),
    shadows: oneOf(raw.shadows, SHADOWS, d.shadows),
    surfaces: oneOf(raw.surfaces, SURFACES, d.surfaces),
    skidMarks: typeof raw.skidMarks === 'boolean' ? raw.skidMarks : d.skidMarks,
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
      steerSaturation: num(pad.steerSaturation, 0.8, 1, d.pad.steerSaturation),
      steerLinearity: num(pad.steerLinearity, 0, 1, d.pad.steerLinearity),
      throttleCurve: oneOf(pad.throttleCurve, CURVE_KINDS, d.pad.throttleCurve),
      brakeCurve: oneOf(pad.brakeCurve, CURVE_KINDS, d.pad.brakeCurve),
      throttleDeadzone: num(pad.throttleDeadzone, 0, 0.3, d.pad.throttleDeadzone),
      brakeDeadzone: num(pad.brakeDeadzone, 0, 0.3, d.pad.brakeDeadzone),
    },
    audio: {
      volume: num(audio.volume, 0, 1, d.audio.volume),
      muted: typeof audio.muted === 'boolean' ? audio.muted : d.audio.muted,
      music: num(audio.music, 0, 1, d.audio.music),
      sfx: num(audio.sfx, 0, 1, d.audio.sfx),
    },
    ghost: typeof raw.ghost === 'boolean' ? raw.ghost : d.ghost,
    schoolDone: raw.schoolDone === true,
    schoolOffered: raw.schoolOffered === true,
    roamHinted: raw.roamHinted === true,
    damage: oneOf(raw.damage, DAMAGE_LEVELS, d.damage),
    radio: {
      voice: typeof radio.voice === 'boolean' ? radio.voice : d.radio.voice,
      subtitles: typeof radio.subtitles === 'boolean' ? radio.subtitles : d.radio.subtitles,
      volume: num(radio.volume, 0, 1, d.radio.volume),
    },
    wheels,
    wheelsPrompted: Array.isArray(raw.wheelsPrompted)
      ? raw.wheelsPrompted.filter((id): id is string => typeof id === 'string').slice(0, 32)
      : [],
    prompts: oneOf(raw.prompts, PROMPTS, d.prompts),
    touchSteering: raw.touchSteering === 'tilt' ? 'tilt' : 'drag',
    paint,
    // Saves from before liveries had only a paint colour: it becomes the livery's colour.
    livery: raw.livery !== undefined ? sanitizeLivery(raw.livery) : { ...d.livery, primary: paint },
    rumble: {
      enabled: typeof rumble.enabled === 'boolean' ? rumble.enabled : d.rumble.enabled,
      strength: num(rumble.strength, 0, 1, d.rumble.strength),
      channels: rumbleChannels,
    },
    bindings: sanitizeBindings(raw.bindings),
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

/** The settings as a downloadable file (pretty-printed JSON with a marker). */
export function exportSettings(settings: Settings): string {
  return JSON.stringify({ game: 'apex-grand-prix', ...settings }, null, 2);
}

/**
 * Reads an exported settings file. Returns null if it isn't one of ours; anything inside is
 * repaired like stored settings, so an old or hand-edited file still loads.
 */
export function importSettings(text: string): Settings | null {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw) || raw.game !== 'apex-grand-prix') return null;
    return parseSettings(raw);
  } catch {
    return null;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings just won't persist.
  }
}
