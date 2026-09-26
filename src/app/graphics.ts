import type {
  AntiAliasing,
  GraphicsPreset,
  Settings,
  ShadowQuality,
  SurfaceQuality,
} from './settings';

/** A device's (or a preset's) level of world detail. */
export type Level = 'low' | 'medium' | 'high';
export type NamedPreset = Exclude<GraphicsPreset, 'auto' | 'custom'>;

/** Everything the graphics settings decide, resolved (no "auto" left). */
export interface Graphics {
  detail: Level;
  /** Post-processing: none, a bloom, or a bloom with ambient occlusion and a colour grade. */
  effects: 'off' | 'bloom' | 'full';
  reflections: boolean;
  antialiasing: AntiAliasing;
  shadows: ShadowQuality;
  surfaces: SurfaceQuality;
  skidMarks: boolean;
}

/**
 * The presets. Low is the plain render with the renderer's MSAA; medium adds a bloom, detailed
 * asphalt and FXAA; high the ambient occlusion, the colour grade, soft shadows and SMAA; ultra
 * the screen-space ray-traced reflections and the largest shadow map on top.
 */
export const GRAPHICS_PRESETS: Readonly<Record<NamedPreset, Readonly<Graphics>>> = {
  low: {
    detail: 'low',
    effects: 'off',
    reflections: false,
    antialiasing: 'off',
    shadows: 'low',
    surfaces: 'standard',
    skidMarks: true,
  },
  medium: {
    detail: 'medium',
    effects: 'bloom',
    reflections: false,
    antialiasing: 'fxaa',
    shadows: 'medium',
    surfaces: 'detailed',
    skidMarks: true,
  },
  high: {
    detail: 'high',
    effects: 'full',
    reflections: false,
    antialiasing: 'smaa',
    shadows: 'high',
    surfaces: 'detailed',
    skidMarks: true,
  },
  ultra: {
    detail: 'high',
    effects: 'full',
    reflections: true,
    antialiasing: 'smaa',
    shadows: 'ultra',
    surfaces: 'detailed',
    skidMarks: true,
  },
};

/** The preset "auto" picks on a device of this level (ultra is only ever chosen). */
export const presetFor = (device: Level): NamedPreset => device;

/** The graphics in force: the preset's, or (custom) the choices as they are. */
export function effectiveGraphics(s: Settings, device: Level): Graphics {
  if (s.preset === 'auto') return { ...GRAPHICS_PRESETS[presetFor(device)] };
  if (s.preset !== 'custom') return { ...GRAPHICS_PRESETS[s.preset] };
  const detail = s.detail === 'auto' ? device : s.detail;
  const effects =
    s.effects !== 'auto'
      ? s.effects
      : detail === 'high'
        ? 'full'
        : detail === 'medium'
          ? 'bloom'
          : 'off';
  return {
    detail,
    effects,
    reflections: s.reflections,
    antialiasing: s.antialiasing,
    shadows: s.shadows,
    surfaces: s.surfaces,
    skidMarks: s.skidMarks,
  };
}

/**
 * Picks a preset: its values are written into the individual choices (so switching to custom
 * starts from them); custom keeps the choices as they are.
 */
export function applyPreset(s: Settings, preset: GraphicsPreset, device: Level): void {
  s.preset = preset;
  if (preset === 'custom') return;
  const g = GRAPHICS_PRESETS[preset === 'auto' ? presetFor(device) : preset];
  s.detail = g.detail;
  s.effects = g.effects;
  s.reflections = g.reflections;
  s.antialiasing = g.antialiasing;
  s.shadows = g.shadows;
  s.surfaces = g.surfaces;
  s.skidMarks = g.skidMarks;
}

/** Shadow map size and PCF softness (radius in texels) per shadow quality. */
export const SHADOW_SETTINGS: Readonly<Record<ShadowQuality, { size: number; radius: number }>> = {
  low: { size: 1024, radius: 1 },
  medium: { size: 2048, radius: 1.5 },
  high: { size: 2048, radius: 3 },
  ultra: { size: 4096, radius: 4 },
};
