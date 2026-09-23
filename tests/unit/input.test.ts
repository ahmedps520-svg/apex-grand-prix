import { describe, expect, it } from 'vitest';
import { cleanPadName, padFamily, shapeStick, shapeTrigger } from '../../src/input/InputManager';

describe('input shaping', () => {
  it('ignores stick noise inside the dead zone and reaches ±1 at full lock', () => {
    expect(shapeStick(0.05)).toBe(0);
    expect(shapeStick(-0.07)).toBe(0);
    expect(shapeStick(1)).toBeCloseTo(1);
    expect(shapeStick(-1)).toBeCloseTo(-1);
  });

  it('is monotonic and finer near the centre', () => {
    let last = 0;
    for (let v = 0.09; v <= 1; v += 0.01) {
      const s = shapeStick(v);
      expect(s).toBeGreaterThan(last);
      last = s;
    }
    expect(shapeStick(0.5)).toBeLessThan(0.5);
  });

  it('rescales triggers after their dead zone', () => {
    expect(shapeTrigger(0.02)).toBe(0);
    expect(shapeTrigger(1)).toBe(1);
    expect(shapeTrigger(0.5)).toBeGreaterThan(0.45);
  });
});

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
