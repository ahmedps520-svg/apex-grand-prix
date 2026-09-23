import { describe, expect, it } from 'vitest';
import { applyCurve, pedalRange, shapePedal, shapeSteer } from '../../src/input/curves';
import {
  buttonDown,
  looksLikeWheel,
  readWheel,
  sanitizeProfile,
  steerFraction,
  wheelReading,
  type GamepadLike,
  type WheelProfile,
} from '../../src/input/wheel';
import { WheelCalibration } from '../../src/input/wheelCalibration';

/**
 * Simulated wheels with the axis layouts browsers report for them. Axis and button numbers
 * differ between wheels, drivers and systems, which is why the setup wizard exists.
 */
interface SimWheel {
  id: string;
  axisCount: number;
  steerAxis: number;
  /** Value at full right lock (+1, or -1 for an inverted axis). */
  steerRightSign: number;
  pedals: Record<'throttle' | 'brake' | 'clutch', { axis: number; rest: number; full: number }>;
  /** Axis a hat switch reports on (neutral value), if any. */
  hat?: { axis: number; neutral: number };
  paddles: { up: number; down: number };
  /** Some browsers report 0 for a pedal axis until the pedal is first moved. */
  zeroUntilMoved?: boolean;
}

const G29_WINDOWS: SimWheel = {
  id: 'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
  axisCount: 10,
  steerAxis: 0,
  steerRightSign: 1,
  pedals: {
    throttle: { axis: 2, rest: 1, full: -1 },
    brake: { axis: 5, rest: 1, full: -1 },
    clutch: { axis: 1, rest: 1, full: -1 },
  },
  hat: { axis: 9, neutral: 1.2857 },
  paddles: { up: 4, down: 5 },
};

/** A G923 (Xbox version) set to combined pedals, with an inverted steering axis. */
const G923_COMBINED: SimWheel = {
  id: 'Logitech G923 Racing Wheel for Xbox One and PC (Vendor: 046d Product: c26e)',
  axisCount: 6,
  steerAxis: 0,
  steerRightSign: -1,
  pedals: {
    throttle: { axis: 1, rest: 0, full: -1 },
    brake: { axis: 1, rest: 0, full: 1 },
    clutch: { axis: 3, rest: 0, full: 1 },
  },
  paddles: { up: 13, down: 12 },
};

class FakeWheel implements GamepadLike {
  readonly id: string;
  axes: number[];
  buttons: Array<{ pressed: boolean; value: number }>;
  private readonly moved = new Set<string>();

  constructor(readonly spec: SimWheel) {
    this.id = spec.id;
    this.axes = new Array(spec.axisCount).fill(0);
    this.buttons = Array.from({ length: 24 }, () => ({ pressed: false, value: 0 }));
    this.release();
  }

  /** Everything released and centred (pedal axes at their rest values). */
  release(): void {
    this.axes.fill(0);
    for (const [name, p] of Object.entries(this.spec.pedals)) {
      const reported = this.moved.has(name) || !this.spec.zeroUntilMoved;
      if (reported || this.axes[p.axis] === 0) this.axes[p.axis] = reported ? p.rest : 0;
    }
    if (this.spec.hat) this.axes[this.spec.hat.axis] = this.spec.hat.neutral;
    this.buttons.forEach((b) => ((b.pressed = false), (b.value = 0)));
  }

  steer(fraction: number): void {
    this.axes[this.spec.steerAxis] = fraction * this.spec.steerRightSign;
  }

  pedal(name: 'throttle' | 'brake' | 'clutch', amount: number): void {
    this.moved.add(name);
    const p = this.spec.pedals[name];
    this.axes[p.axis] = p.rest + (p.full - p.rest) * amount;
  }

  press(button: number, down = true): void {
    this.buttons[button] = { pressed: down, value: down ? 1 : 0 };
  }
}

/** Runs the whole wizard the way a player would: move each control, release it, press Next. */
function calibrate(wheel: FakeWheel): WheelProfile {
  const cal = new WheelCalibration(wheel.id, 'Test wheel');
  const feed = (frames = 5) => {
    for (let i = 0; i < frames; i++) cal.sample(wheel);
  };
  const confirm = () => expect(cal.next(), cal.problem).toBe(true);
  wheel.release();
  feed();
  confirm(); // centre
  for (const side of [-1, 1]) {
    for (let f = 0; f <= 10; f++) {
      wheel.steer((side * f) / 10);
      feed(1);
    }
    wheel.steer(0);
    feed();
    confirm();
  }
  for (const pedal of ['throttle', 'brake', 'clutch'] as const) {
    for (let f = 0; f <= 10; f++) {
      wheel.pedal(pedal, f / 10);
      feed(1);
    }
    wheel.release();
    feed();
    confirm();
  }
  while (cal.step.kind === 'button') {
    const action = cal.step.action;
    feed(); // the player sees the prompt for a few frames before pressing
    if (action === 'shiftUp' || action === 'shiftDown') {
      const button = action === 'shiftUp' ? wheel.spec.paddles.up : wheel.spec.paddles.down;
      wheel.press(button);
      feed();
      wheel.press(button, false);
      feed();
      confirm();
    } else if (action === 'menuUp' && wheel.spec.hat) {
      wheel.axes[wheel.spec.hat.axis] = -1; // hat "up"
      feed();
      wheel.release();
      feed();
      confirm();
    } else {
      cal.skip();
    }
  }
  expect(cal.done).toBe(true);
  return cal.profile();
}

describe('response curves', () => {
  it('keep 0 and 1 fixed and order the three shapes', () => {
    for (const kind of ['linear', 'progressive', 'aggressive'] as const) {
      expect(applyCurve(0, kind)).toBe(0);
      expect(applyCurve(1, kind)).toBe(1);
    }
    expect(applyCurve(0.5, 'progressive')).toBeLessThan(applyCurve(0.5, 'linear'));
    expect(applyCurve(0.5, 'aggressive')).toBeGreaterThan(applyCurve(0.5, 'linear'));
  });

  it('apply dead zone and saturation before the curve', () => {
    expect(pedalRange(0.04, 0.05)).toBe(0);
    expect(pedalRange(0.9, 0, 0.9)).toBe(1);
    expect(pedalRange(0.5, 0, 1)).toBeCloseTo(0.5);
    expect(shapePedal(0.02, { curve: 'linear', deadzone: 0.03, saturation: 1 })).toBe(0);
    expect(shapePedal(Number.NaN, { curve: 'linear', deadzone: 0.03, saturation: 1 })).toBe(0);
  });

  it('shapes steering with a dead zone and centre precision, keeping full lock', () => {
    expect(shapeSteer(0.05, 0.08, 0)).toBe(0);
    expect(shapeSteer(1, 0.08, 0.5)).toBe(1);
    expect(shapeSteer(-1, 0.08, 0.5)).toBe(-1);
    // Right after the dead zone the output starts from 0, not with a jump.
    expect(shapeSteer(0.09, 0.08, 0)).toBeLessThan(0.02);
    // Centre precision: small inputs do less than linear.
    expect(shapeSteer(0.3, 0, 0.5)).toBeLessThan(0.3);
    expect(shapeSteer(Number.NaN, 0.08, 0)).toBe(0);
  });
});

describe('wheel detection', () => {
  it.each([
    'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
    'Logitech G923 Racing Wheel for Xbox One and PC (Vendor: 046d Product: c26e)',
    '046d-c262-Logitech G920 Driving Force Racing Wheel',
    'Thrustmaster T300RS Racing wheel (Vendor: 044f Product: b66e)',
    'FANATEC CSL Elite Wheel Base',
  ])('recognises %s', (id) => {
    expect(looksLikeWheel(id)).toBe(true);
  });

  it.each([
    'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    'Logitech Gamepad F310 (STANDARD GAMEPAD Vendor: 046d Product: c216)',
  ])('does not mistake %s for a wheel', (id) => {
    expect(looksLikeWheel(id)).toBe(false);
  });
});

describe('wheel setup wizard', () => {
  it.each([
    ['G29 (separate pedals resting at +1)', G29_WINDOWS],
    ['G923 (combined pedals, inverted steering)', G923_COMBINED],
    ['G29 whose pedals read 0 until first pressed', { ...G29_WINDOWS, zeroUntilMoved: true }],
  ])('calibrates a simulated %s', (_name, spec) => {
    const wheel = new FakeWheel(spec);
    const profile = calibrate(wheel);
    expect(profile.steer.axis).toBe(spec.steerAxis);
    expect(profile.throttle?.axis).toBe(spec.pedals.throttle.axis);
    expect(profile.brake?.axis).toBe(spec.pedals.brake.axis);
    expect(profile.clutch?.axis).toBe(spec.pedals.clutch.axis);

    const out = wheelReading();
    // Centred and released: nothing happens.
    wheel.release();
    readWheel(wheel, profile, out);
    expect(out.angle).toBeCloseTo(0, 5);
    expect(out.throttle).toBe(0);
    expect(out.brake).toBe(0);
    expect(out.clutch).toBe(0);

    // A quarter turn right on a 900° wheel is +112.5°.
    wheel.steer(0.25);
    readWheel(wheel, profile, out);
    expect((out.angle * 180) / Math.PI).toBeCloseTo(112.5, 1);
    wheel.steer(-1);
    readWheel(wheel, profile, out);
    expect((out.angle * 180) / Math.PI).toBeCloseTo(-450, 1);

    // Pedals map to 0…1, independently even when they share an axis.
    wheel.release();
    wheel.pedal('throttle', 0.5);
    readWheel(wheel, profile, out);
    expect(out.throttle).toBeCloseTo(0.5 - 0.02, 1);
    expect(out.brake).toBe(0);
    wheel.release();
    wheel.pedal('brake', 1);
    readWheel(wheel, profile, out);
    expect(out.brake).toBeCloseTo(1, 5);
    expect(out.throttle).toBe(0);

    // Paddles are bound.
    wheel.release();
    wheel.press(spec.paddles.up);
    expect(buttonDown(profile.buttons.shiftUp, wheel)).toBe(true);
    expect(buttonDown(profile.buttons.shiftDown, wheel)).toBe(false);
  });

  it('binds a hat switch that reports as an axis', () => {
    const wheel = new FakeWheel(G29_WINDOWS);
    const profile = calibrate(wheel);
    expect(profile.buttons.menuUp).toEqual({ type: 'axis', index: 9, value: -1 });
    wheel.release();
    expect(buttonDown(profile.buttons.menuUp, wheel)).toBe(false);
    wheel.axes[9] = -1;
    expect(buttonDown(profile.buttons.menuUp, wheel)).toBe(true);
  });

  it('refuses to continue until something moved, and allows skipping only optional steps', () => {
    const wheel = new FakeWheel(G29_WINDOWS);
    const cal = new WheelCalibration(wheel.id, 'G29');
    cal.sample(wheel);
    expect(cal.next()).toBe(true); // centre
    cal.sample(wheel);
    expect(cal.canSkip).toBe(false);
    expect(cal.next()).toBe(false); // steering left: nothing moved
    expect(cal.problem).not.toBe('');
  });

  it('does not bind a button that was already held when the step started', () => {
    const wheel = new FakeWheel(G29_WINDOWS);
    const cal = new WheelCalibration(wheel.id, 'G29', ['shiftUp']);
    cal.sample(wheel);
    cal.next();
    wheel.press(4);
    cal.sample(wheel); // held from before: ignored until released
    expect(cal.next()).toBe(false);
    wheel.press(4, false);
    cal.sample(wheel);
    wheel.press(4);
    cal.sample(wheel);
    expect(cal.next()).toBe(true);
  });
});

describe('wheel profiles', () => {
  it('maps steering through left, centre and right calibration points', () => {
    const steer = { axis: 0, left: -0.9, center: 0.1, right: 0.8 };
    expect(steerFraction(0.1, steer)).toBeCloseTo(0);
    expect(steerFraction(0.8, steer)).toBeCloseTo(1);
    expect(steerFraction(-0.9, steer)).toBeCloseTo(-1);
    expect(steerFraction(0.45, steer)).toBeCloseTo(0.5);
    expect(steerFraction(5, steer)).toBe(1);
  });

  it('repairs or rejects corrupt stored profiles', () => {
    expect(sanitizeProfile(null)).toBeNull();
    expect(sanitizeProfile({ id: 'x' })).toBeNull();
    const repaired = sanitizeProfile({
      id: 'wheel',
      steer: { axis: 0, left: -1, center: 0, right: 1 },
      rotation: 99999,
      throttle: { axis: 2, rest: 1, full: -1, curve: 'weird', deadzone: 5 },
      buttons: { shiftUp: { type: 'button', index: 4 }, bogus: { type: 'button', index: 1 } },
    });
    expect(repaired?.rotation).toBe(1080);
    expect(repaired?.throttle?.curve).toBe('linear');
    expect(repaired?.throttle?.deadzone).toBe(0.3);
    expect(repaired?.buttons).toEqual({ shiftUp: { type: 'button', index: 4 } });
  });
});
