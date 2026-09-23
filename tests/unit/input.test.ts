import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultPadSettings } from '../../src/app/settings';
import { InputManager, cleanPadName, padFamily } from '../../src/input/InputManager';
import type { WheelProfile } from '../../src/input/wheel';

describe('controller identification', () => {
  it('recognises PlayStation controllers as reported by Chrome and Safari', () => {
    expect(
      padFamily('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
    ).toBe('playstation');
    expect(padFamily('054c-0ce6-DualSense Wireless Controller')).toBe('playstation');
    expect(padFamily('Wireless Controller Extended Gamepad')).toBe('playstation');
  });

  it('recognises Xbox controllers', () => {
    expect(
      padFamily('Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)'),
    ).toBe('xbox');
    expect(padFamily('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe('xbox');
  });

  it('falls back to generic', () => {
    expect(padFamily('8BitDo Pro 2 (Vendor: 2dc8 Product: 6006)')).toBe('generic');
  });

  it('cleans up names for display', () => {
    expect(
      cleanPadName('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)'),
    ).toBe('DualSense Wireless Controller');
    expect(cleanPadName('054c-0ce6-DualSense Wireless Controller')).toBe(
      'DualSense Wireless Controller',
    );
  });
});

/** A fake Gamepad API object, enough for the input manager. */
function fakePad(id: string, mapping: string, axes = 4, buttons = 18) {
  return {
    id,
    index: 0,
    connected: true,
    mapping,
    timestamp: 1,
    axes: new Array<number>(axes).fill(0),
    buttons: Array.from({ length: buttons }, () => ({ pressed: false, touched: false, value: 0 })),
    press(i: number, down = true, value = down ? 1 : 0) {
      this.buttons[i] = { pressed: down, touched: down, value };
      this.timestamp++;
    },
  };
}

describe('input manager', () => {
  let pads: Array<ReturnType<typeof fakePad>> = [];
  let target: EventTarget;
  const saved = { window: globalThis.window };

  beforeEach(() => {
    pads = [];
    target = new EventTarget();
    (globalThis as { window?: unknown }).window = target;
    Object.defineProperty(globalThis.navigator, 'getGamepads', {
      value: () => pads,
      configurable: true,
    });
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = saved.window;
  });

  const key = (type: 'keydown' | 'keyup', code: string, shiftKey = false) =>
    target.dispatchEvent(Object.assign(new Event(type), { code, repeat: false, shiftKey }));

  it('counts paddle presses once per press (R1 up, L1 down)', () => {
    const pad = fakePad('DualSense Wireless Controller (STANDARD GAMEPAD)', 'standard');
    pads.push(pad);
    const input = new InputManager();
    pad.press(5);
    input.update();
    expect(input.driver.shiftUp).toBe(1);
    input.update(); // still held: no new press
    expect(input.driver.shiftUp).toBe(0);
    pad.press(5, false);
    pad.press(4);
    input.update();
    expect(input.driver.shiftDown).toBe(1);
    input.dispose();
  });

  it('toggles the telemetry with the touchpad or L3 + R3, and drives the quick menu with the D-pad', () => {
    const pad = fakePad('DualSense Wireless Controller (STANDARD GAMEPAD)', 'standard');
    pads.push(pad);
    const input = new InputManager();
    pad.press(17);
    input.update();
    expect(input.actions.includes('telemetry')).toBe(true);
    pad.press(17, false);
    pad.press(10);
    input.update();
    expect(input.actions.includes('telemetry')).toBe(false);
    pad.press(11);
    input.update();
    expect(input.actions.includes('telemetry')).toBe(true);
    pad.press(10, false);
    pad.press(11, false);
    pad.press(15);
    pad.press(12);
    input.update();
    expect(input.actions.includes('menuNext')).toBe(true);
    expect(input.actions.includes('menuUp')).toBe(true);
    input.dispose();
  });

  it('shapes the triggers with the chosen curve', () => {
    const pad = fakePad('Xbox Wireless Controller (STANDARD GAMEPAD)', 'standard');
    pads.push(pad);
    const input = new InputManager();
    input.padSettings = { ...defaultPadSettings(), throttleCurve: 'progressive', brakeDeadzone: 0 };
    pad.press(7, true, 0.5);
    pad.press(6, true, 0.5);
    input.update();
    expect(input.driver.throttle).toBeLessThan(0.4);
    expect(input.driver.brake).toBeCloseTo(0.5, 5);
    input.dispose();
  });

  it('steers with the stick in pad mode after the dead zone', () => {
    const pad = fakePad('DualSense Wireless Controller (STANDARD GAMEPAD)', 'standard');
    pads.push(pad);
    const input = new InputManager();
    input.padSettings = defaultPadSettings();
    pad.axes[0] = 0.03;
    pad.press(7, true, 0.5);
    input.update();
    expect(input.driver.steerMode).toBe('pad');
    expect(input.driver.steer).toBe(0);
    pad.axes[0] = -1;
    input.update();
    expect(input.driver.steer).toBe(-1);
    input.dispose();
  });

  it('keeps every key press, even several in one frame', () => {
    const input = new InputManager();
    key('keydown', 'Tab');
    key('keyup', 'Tab');
    key('keydown', 'Tab');
    key('keyup', 'Tab');
    key('keydown', 'KeyE');
    key('keyup', 'KeyE');
    key('keydown', 'KeyE');
    input.update();
    expect(input.actions.filter((a) => a === 'menuNext')).toHaveLength(2);
    expect(input.driver.shiftUp).toBe(2);
    input.dispose();
  });

  it('uses the keyboard: E/Q shift, Tab walks the quick menu, keys steer digitally', () => {
    const input = new InputManager();
    key('keydown', 'KeyE');
    key('keydown', 'Tab', true);
    key('keydown', 'KeyD');
    input.update();
    expect(input.driver.shiftUp).toBe(1);
    expect(input.actions.includes('menuPrev')).toBe(true);
    expect(input.driver.steerMode).toBe('keyboard');
    expect(input.driver.steer).toBe(1);
    key('keyup', 'KeyD');
    input.update();
    expect(input.driver.steer).toBe(0);
    input.dispose();
  });

  it('drives with a calibrated wheel, 1:1 in radians, and ignores an uncalibrated one', () => {
    const wheel = fakePad(
      'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
      '',
      10,
      24,
    );
    wheel.axes[2] = 1; // throttle at rest
    wheel.axes[5] = 1; // brake at rest
    pads.push(wheel);
    const input = new InputManager();
    input.update();
    expect(input.wheelPad).not.toBeNull();
    expect(input.wheelProfile).toBeNull();
    expect(input.driver.steerMode).not.toBe('wheel');

    const profile: WheelProfile = {
      version: 1,
      id: wheel.id,
      name: 'G29',
      steer: { axis: 0, left: -1, center: 0, right: 1 },
      rotation: 900,
      steerDeadzone: 0,
      steerLinearity: 0,
      throttle: { axis: 2, rest: 1, full: -1, curve: 'linear', deadzone: 0, saturation: 1 },
      brake: { axis: 5, rest: 1, full: -1, curve: 'linear', deadzone: 0, saturation: 1 },
      clutch: null,
      buttons: { shiftUp: { type: 'button', index: 4 } },
    };
    input.wheelProfiles = { [wheel.id]: profile };
    wheel.axes[0] = 0.1; // 45° right
    wheel.axes[2] = 0; // half throttle
    input.update();
    expect(input.driver.steerMode).toBe('wheel');
    expect(input.driver.wheelAngle).toBeCloseTo((45 * Math.PI) / 180, 5);
    expect(input.driver.throttle).toBeCloseTo(0.5, 5);
    wheel.press(4);
    input.update();
    expect(input.driver.shiftUp).toBe(1);
    input.dispose();
  });
});
