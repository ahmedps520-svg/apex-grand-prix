import { describe, expect, it } from 'vitest';
import { choiceItem, percentItem } from '../../src/ui/QuickMenu';

describe('quick menu items', () => {
  it('steps through choices and stops at the ends unless wrapping', () => {
    let tc = 'high';
    const options = [
      { value: 'off', text: 'Off' },
      { value: 'low', text: 'Low' },
      { value: 'high', text: 'High' },
    ];
    const item = choiceItem(
      'TC',
      options,
      () => tc,
      (v) => (tc = v),
    );
    expect(item.value()).toBe('High');
    item.change(1);
    expect(tc).toBe('high');
    item.change(-1);
    expect(item.value()).toBe('Low');
    item.change(-1);
    item.change(-1);
    expect(tc).toBe('off');

    let place = 'loop';
    const wrapped = choiceItem(
      'Location',
      [
        { value: 'loop', text: 'Loop' },
        { value: 'drag', text: 'Drag' },
      ],
      () => place,
      (v) => (place = v),
      true,
    );
    wrapped.change(-1);
    expect(place).toBe('drag');
    wrapped.change(1);
    expect(place).toBe('loop');
  });

  it('steps percentages without floating-point drift and clamps them', () => {
    let v = 1;
    const item = percentItem(
      'Sensitivity',
      0.5,
      1.5,
      0.1,
      () => v,
      (x) => (v = x),
    );
    for (let i = 0; i < 3; i++) item.change(1);
    expect(item.value()).toBe('130%');
    for (let i = 0; i < 20; i++) item.change(-1);
    expect(v).toBe(0.5);
    expect(item.value()).toBe('50%');
  });
});
