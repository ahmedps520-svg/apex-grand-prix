import { describe, expect, it } from 'vitest';
import { SETTINGS_VERSION, defaultSettings, parseSettings } from '../../src/app/settings';

describe('settings', () => {
  it('upgrades Round 1 settings (version 1), keeping what the player chose', () => {
    const v1 = {
      version: 1,
      resolutionScale: 0.8,
      units: 'imperial',
      overlay: false,
      camera: 'bonnet',
    };
    const s = parseSettings(v1);
    expect(s.version).toBe(SETTINGS_VERSION);
    expect(s.resolutionScale).toBe(0.8);
    expect(s.units).toBe('imperial');
    expect(s.overlay).toBe(false);
    expect(s.camera).toBe('bonnet');
    // New in version 2: defaults.
    expect(s.aids).toEqual(defaultSettings().aids);
    expect(s.pad).toEqual(defaultSettings().pad);
    expect(s.telemetry).toBe(false);
  });

  it('repairs corrupt or out-of-range values instead of failing', () => {
    const s = parseSettings({
      resolutionScale: 99,
      camera: 'orbit',
      aids: { tc: 'ultra', abs: 'low', gearbox: 'manual', steerSensitivity: -4 },
      pad: { throttleCurve: 'progressive', steerDeadzone: 'x' },
      audio: { volume: 3, muted: 'yes' },
      wheels: { a: { nonsense: true } },
      wheelsPrompted: ['G29', 5],
    });
    expect(s.resolutionScale).toBe(1.5);
    expect(s.camera).toBe('chase');
    expect(s.aids.tc).toBe('high');
    expect(s.aids.abs).toBe('low');
    expect(s.aids.gearbox).toBe('manual');
    expect(s.aids.steerSensitivity).toBe(0.5);
    expect(s.pad.throttleCurve).toBe('progressive');
    expect(s.pad.steerDeadzone).toBe(defaultSettings().pad.steerDeadzone);
    expect(s.audio).toEqual({ volume: 1, muted: false, music: 0.6, sfx: 0.7 });
    expect(s.wheels).toEqual({});
    expect(s.wheelsPrompted).toEqual(['G29']);
  });

  it('falls back to defaults for garbage', () => {
    expect(parseSettings('nope')).toEqual(defaultSettings());
    expect(parseSettings(null)).toEqual(defaultSettings());
  });

  it('round-trips through JSON unchanged', () => {
    const s = defaultSettings();
    s.aids.gearbox = 'manual';
    s.pad.brakeCurve = 'aggressive';
    expect(parseSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('free roam hints flag', () => {
  it('is off by default and repairs a bad value', () => {
    expect(defaultSettings().roamHinted).toBe(false);
    expect(parseSettings({ ...defaultSettings(), roamHinted: true }).roamHinted).toBe(true);
    expect(parseSettings({ ...defaultSettings(), roamHinted: 'yes' }).roamHinted).toBe(false);
  });
});
