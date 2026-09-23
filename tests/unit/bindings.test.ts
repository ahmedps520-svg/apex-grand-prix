import { describe, expect, it } from 'vitest';
import {
  KEY_ACTIONS,
  PAD_ACTIONS,
  defaultBindings,
  keyName,
  padButtonName,
  rebindKey,
  rebindPad,
  sanitizeBindings,
} from '../../src/input/bindings';

describe('bindings', () => {
  it('has a default for every action and no duplicate controller buttons', () => {
    const b = defaultBindings();
    const buttons = PAD_ACTIONS.map(({ action }) => b.pad[action]);
    expect(new Set(buttons).size).toBe(buttons.length);
    for (const { action } of KEY_ACTIONS) expect(b.keys[action].length).toBeGreaterThan(0);
  });

  it('swaps controller buttons when one is taken', () => {
    const b = rebindPad(defaultBindings(), 'shiftUp', 3); // △ was "reset"
    expect(b.pad.shiftUp).toBe(3);
    expect(b.pad.reset).toBe(5); // gets shift-up's old button
  });

  it('moves a key from its old action and keeps a second key', () => {
    const b = rebindKey(defaultBindings(), 'throttle', 'KeyE'); // E was "shift up"
    expect(b.keys.throttle).toEqual(['KeyE', 'ArrowUp']);
    expect(b.keys.shiftUp).toEqual([]);
  });

  it('survives saving and loading unchanged', () => {
    const b = rebindKey(rebindPad(defaultBindings(), 'pause', 16), 'reset', 'KeyT');
    expect(sanitizeBindings(JSON.parse(JSON.stringify(b)))).toEqual(b);
  });

  it('repairs corrupt stored bindings', () => {
    const b = sanitizeBindings({
      pad: { shiftUp: 'x', reset: 99, pause: 12, bogus: 3 },
      keys: { throttle: [1, 'KeyI'], brake: 'KeyK' },
    });
    const d = defaultBindings();
    expect(b.pad.shiftUp).toBe(d.pad.shiftUp);
    expect(b.pad.reset).toBe(d.pad.reset);
    expect(b.pad.pause).toBe(12);
    expect(b.keys.throttle).toEqual(['KeyI']);
    expect(b.keys.brake).toEqual(d.keys.brake);
    expect(sanitizeBindings(null)).toEqual(d);
  });

  it('names buttons and keys for the player', () => {
    expect(padButtonName(0, 'playstation')).toBe('✕');
    expect(padButtonName(5, 'xbox')).toBe('RB');
    expect(padButtonName(17, 'playstation')).toBe('Touchpad');
    expect(padButtonName(23, 'generic')).toBe('Button 23');
    expect(keyName('KeyW')).toBe('W');
    expect(keyName('ArrowLeft')).toBe('←');
    expect(keyName('Digit3')).toBe('3');
    expect(keyName('F3')).toBe('F3');
  });
});
