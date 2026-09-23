import type { CameraMode } from '../render/ChaseCamera';
import type { Units } from '../ui/Hud';

/**
 * The few settings Round 1 has, saved in localStorage. Round 3 replaces this with the full,
 * versioned settings system and migrates these values.
 */
export interface QuickSettings {
  version: 1;
  resolutionScale: number;
  units: Units;
  overlay: boolean;
  camera: CameraMode;
}

const KEY = 'apex-gp.settings';

export const defaultSettings = (): QuickSettings => ({
  version: 1,
  resolutionScale: 1,
  units: 'metric',
  overlay: true,
  camera: 'chase',
});

export function loadSettings(): QuickSettings {
  const defaults = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<QuickSettings>;
    return {
      version: 1,
      resolutionScale:
        typeof parsed.resolutionScale === 'number' && Number.isFinite(parsed.resolutionScale)
          ? Math.min(Math.max(parsed.resolutionScale, 0.25), 1.5)
          : defaults.resolutionScale,
      units: parsed.units === 'imperial' ? 'imperial' : 'metric',
      overlay: typeof parsed.overlay === 'boolean' ? parsed.overlay : defaults.overlay,
      camera: parsed.camera === 'chase-far' || parsed.camera === 'bonnet' ? parsed.camera : 'chase',
    };
  } catch {
    // Private mode, blocked storage or corrupt data: fall back to defaults.
    return defaults;
  }
}

export function saveSettings(settings: QuickSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: settings just won't persist.
  }
}
