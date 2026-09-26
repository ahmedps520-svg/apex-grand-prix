import { describe, expect, it } from 'vitest';
import {
  GRAPHICS_PRESETS,
  SHADOW_SETTINGS,
  applyPreset,
  effectiveGraphics,
} from '../../src/app/graphics';
import { defaultSettings, parseSettings } from '../../src/app/settings';
import { effectsKey, noEffects } from '../../src/render/Effects';

describe('graphics presets', () => {
  it('go up from the plain render to reflections and the largest shadows', () => {
    expect(GRAPHICS_PRESETS.low).toMatchObject({ effects: 'off', reflections: false });
    expect(GRAPHICS_PRESETS.low.surfaces).toBe('standard');
    expect(GRAPHICS_PRESETS.medium).toMatchObject({ effects: 'bloom', surfaces: 'detailed' });
    expect(GRAPHICS_PRESETS.high).toMatchObject({ effects: 'full', antialiasing: 'smaa' });
    expect(GRAPHICS_PRESETS.high.reflections).toBe(false);
    expect(GRAPHICS_PRESETS.ultra).toMatchObject({ reflections: true, shadows: 'ultra' });
    expect(SHADOW_SETTINGS.ultra.size).toBeGreaterThan(SHADOW_SETTINGS.high.size);
    expect(SHADOW_SETTINGS.high.radius).toBeGreaterThan(SHADOW_SETTINGS.medium.radius);
  });

  it('auto follows the device, a named preset is itself, custom is the choices', () => {
    const s = defaultSettings();
    expect(s.preset).toBe('auto');
    expect(effectiveGraphics(s, 'low')).toEqual(GRAPHICS_PRESETS.low);
    expect(effectiveGraphics(s, 'high')).toEqual(GRAPHICS_PRESETS.high);
    s.preset = 'ultra';
    expect(effectiveGraphics(s, 'low')).toEqual(GRAPHICS_PRESETS.ultra);
    s.preset = 'custom';
    s.detail = 'auto';
    s.effects = 'auto';
    s.reflections = true;
    s.antialiasing = 'fxaa';
    s.shadows = 'low';
    s.surfaces = 'standard';
    s.skidMarks = false;
    expect(effectiveGraphics(s, 'medium')).toEqual({
      detail: 'medium',
      effects: 'bloom',
      reflections: true,
      antialiasing: 'fxaa',
      shadows: 'low',
      surfaces: 'standard',
      skidMarks: false,
    });
    s.effects = 'off';
    expect(effectiveGraphics(s, 'high').effects).toBe('off');
  });

  it('picking a preset writes its values into the choices; custom leaves them', () => {
    const s = defaultSettings();
    applyPreset(s, 'ultra', 'low');
    expect(s.preset).toBe('ultra');
    expect(s).toMatchObject({
      detail: 'high',
      effects: 'full',
      reflections: true,
      shadows: 'ultra',
    });
    applyPreset(s, 'custom', 'low');
    expect(s.preset).toBe('custom');
    expect(s.reflections).toBe(true);
    applyPreset(s, 'auto', 'medium');
    expect(s).toMatchObject({
      preset: 'auto',
      detail: 'medium',
      effects: 'bloom',
      reflections: false,
    });
  });

  it('are saved and repaired like every other setting', () => {
    expect(parseSettings({})).toMatchObject({
      preset: 'auto',
      reflections: false,
      antialiasing: 'smaa',
      shadows: 'medium',
      surfaces: 'detailed',
      skidMarks: true,
    });
    expect(
      parseSettings({
        preset: 'ultra',
        reflections: true,
        antialiasing: 'fxaa',
        shadows: 'high',
        surfaces: 'standard',
        skidMarks: false,
      }),
    ).toMatchObject({
      preset: 'ultra',
      reflections: true,
      antialiasing: 'fxaa',
      shadows: 'high',
      surfaces: 'standard',
      skidMarks: false,
    });
    expect(
      parseSettings({ preset: 'insane', antialiasing: 'msaa16', shadows: 9, surfaces: 'glass' }),
    ).toMatchObject({
      preset: 'auto',
      antialiasing: 'smaa',
      shadows: 'medium',
      surfaces: 'detailed',
    });
  });

  it('the post-processing is off only when nothing is added over the plain render', () => {
    const none = { bloom: false, ao: false, ssr: false, aa: 'smaa' as const, grade: false };
    expect(noEffects(none)).toBe(true);
    expect(noEffects({ ...none, ssr: true })).toBe(false);
    expect(effectsKey({ ...none, bloom: true, ssr: true })).not.toBe(
      effectsKey({ ...none, bloom: true }),
    );
  });
});

describe('reflection requests', () => {
  it('are attached to the surfaces only while a pipeline traces reflections', async () => {
    const THREE = await import('three/webgpu');
    const { reflective, reflectionRequestsAttached, startTracing, stopTracing } =
      await import('../../src/render/Effects');
    const paint = new THREE.MeshStandardNodeMaterial();
    reflective(paint, 0.3, 0.1);
    // The plain render draws into the renderer's own frame buffer: no MRT output there.
    expect(paint.mrtNode).toBeNull();
    startTracing();
    expect(paint.mrtNode).not.toBeNull();
    const glass = new THREE.MeshStandardNodeMaterial();
    reflective(glass, 0.35, 0.08);
    expect(glass.mrtNode).not.toBeNull();
    expect(reflectionRequestsAttached()).toBeGreaterThanOrEqual(2);
    stopTracing();
    expect(paint.mrtNode).toBeNull();
    expect(glass.mrtNode).toBeNull();
    stopTracing();
    expect(reflectionRequestsAttached()).toBe(0);
  });
});
