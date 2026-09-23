import { describe, expect, it } from 'vitest';
import {
  canRumble,
  defaultRumbleSettings,
  impactLevel,
  isGearShift,
  limiterLevel,
  lockupLevel,
  mixMotors,
  offroadLevel,
  RUMBLE_CHANNELS,
  RumbleMixer,
  wheelspinLevel,
  type RumbleChannel,
  type RumbleOutput,
  type RumblePad,
  type RumbleSettings,
} from '../../src/input/rumble';
import { createCarRenderState, type CarRenderState } from '../../src/render/interpolate';
import {
  FLAG_ABS,
  FLAG_LIMITER,
  FLAG_SHIFT_DENIED,
  FLAG_TC,
  FLAG_UPSIDE_DOWN,
} from '../../src/shared/protocol';
import { SURFACE } from '../../src/sim/track/surface';

const FPS = 144;
const SILENT: RumbleOutput = { strong: 0, weak: 0 };

/** A car standing on its four wheels on asphalt, in first gear at idle. */
function carAtRest(): CarRenderState {
  const car = createCarRenderState();
  car.gear = 1;
  car.rpm = 900;
  for (const w of car.wheels) {
    w.contact = true;
    w.load = 3200;
  }
  return car;
}

/** Slip ratio of the rear (driven) wheels. */
function rearSlip(car: CarRenderState, slipRatio: number): void {
  car.wheels[2]!.slipRatio = slipRatio;
  car.wheels[3]!.slipRatio = slipRatio;
}

function expectRising(values: number[]): void {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]!);
}

const isSilent = (o: RumbleOutput): boolean => o.strong === 0 && o.weak === 0;
const peakStrong = (frames: RumbleOutput[]): number => Math.max(...frames.map((o) => o.strong));
/** Lets pending promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface Call {
  /** Rig time of the frame that made the call, seconds. */
  at: number;
  type: string;
  duration: number;
  startDelay: number;
  strong: number;
  weak: number;
}

interface PadOptions {
  /** The actuator's list of effects; null leaves the list out (older Chrome). */
  effects?: readonly string[] | null;
  noReset?: boolean;
  /** Make every call reject, or throw like old implementations. */
  fail?: 'reject' | 'throw';
}

/** Drives a mixer frame by frame against a fake pad that records every call. */
class Rig {
  readonly car = carAtRest();
  readonly mixer: RumbleMixer;
  readonly pad: RumblePad;
  readonly calls: Call[] = [];
  resets = 0;
  time = 0;

  constructor(settings: Partial<RumbleSettings> = {}, options: PadOptions = {}) {
    this.mixer = new RumbleMixer({ ...defaultRumbleSettings(), ...settings });
    const result = (): Promise<unknown> => {
      if (options.fail === 'throw') throw new Error('NotSupportedError');
      if (options.fail === 'reject') return Promise.reject(new Error('preempted'));
      return Promise.resolve('complete');
    };
    const actuator: NonNullable<RumblePad['vibrationActuator']> = {
      playEffect: (type, params) => {
        // Copied: the mixer reuses its parameter object.
        this.calls.push({
          at: this.time,
          type,
          duration: params.duration,
          startDelay: params.startDelay ?? 0,
          strong: params.strongMagnitude,
          weak: params.weakMagnitude,
        });
        return result();
      },
    };
    if (options.effects !== null) {
      actuator.effects = options.effects ?? ['dual-rumble', 'trigger-rumble'];
    }
    if (!options.noReset) {
      actuator.reset = () => {
        this.resets++;
        return result();
      };
    }
    this.pad = { vibrationActuator: actuator };
  }

  /** Runs frames for `seconds` and returns each frame's output. */
  run(seconds: number, fps = FPS): RumbleOutput[] {
    const frames: RumbleOutput[] = [];
    const count = Math.round(seconds * fps);
    for (let i = 0; i < count; i++) {
      this.time += 1 / fps;
      this.mixer.update(1 / fps, this.car, this.pad);
      frames.push({ ...this.mixer.output });
    }
    return frames;
  }
}

/** Full rear wheelspin on the throttle. */
function spinning(rig: Rig): Rig {
  rig.car.throttle = 1;
  rig.car.speed = 5;
  rearSlip(rig.car, 0.5);
  return rig;
}

describe('rumble settings', () => {
  it('lists every channel once with a label, all on by default at 70 %', () => {
    const channels = RUMBLE_CHANNELS.map((c) => c.channel);
    expect(new Set(channels).size).toBe(6);
    for (const { label } of RUMBLE_CHANNELS) expect(label.length).toBeGreaterThan(0);
    const settings = defaultRumbleSettings();
    expect(settings.enabled).toBe(true);
    expect(settings.strength).toBe(0.7);
    for (const channel of channels) expect(settings.channels[channel]).toBe(true);
  });
});

describe('at rest', () => {
  it('is silent on asphalt and never calls the pad', () => {
    const rig = new Rig();
    const frames = rig.run(1);
    expect(frames.every(isSilent)).toBe(true);
    expect(rig.calls).toHaveLength(0);
    expect(rig.resets).toBe(0);
  });
});

describe('wheelspin', () => {
  it('fades in from a rear slip ratio of 0.12 to full at 0.35, on the throttle only', () => {
    const car = carAtRest();
    car.throttle = 1;
    car.speed = 12;
    const at = (slip: number): number => {
      rearSlip(car, slip);
      return wheelspinLevel(car, false);
    };
    expect(at(0)).toBe(0);
    expect(at(0.1)).toBe(0); // the tyre's useful range
    expect(at(0.12)).toBe(0);
    expectRising([0.15, 0.2, 0.25, 0.3, 0.35].map(at));
    expect(at(0.35)).toBe(1);
    expect(at(4)).toBe(1);
    car.throttle = 0;
    expect(at(0.3)).toBe(0);
  });

  it('is scaled down a lot while traction control catches it', () => {
    const car = carAtRest();
    car.throttle = 1;
    rearSlip(car, 0.3);
    const free = wheelspinLevel(car);
    car.flags = FLAG_TC;
    expect(wheelspinLevel(car)).toBeGreaterThan(0);
    expect(wheelspinLevel(car)).toBeLessThanOrEqual(free * 0.3);
  });

  it('ignores wheels in the air, and spins backwards in reverse', () => {
    const car = carAtRest();
    car.throttle = 1;
    rearSlip(car, 0.3);
    for (const w of car.wheels) w.contact = false;
    expect(wheelspinLevel(car, false)).toBe(0);
    for (const w of car.wheels) w.contact = true;
    car.gear = -1;
    expect(wheelspinLevel(car, false)).toBe(0);
    rearSlip(car, -0.3);
    expect(wheelspinLevel(car, false)).toBeGreaterThan(0.5);
  });

  it('is mostly on the weak motor, and much weaker under TC', () => {
    const free = spinning(new Rig());
    rearSlip(free.car, 0.3);
    free.run(0.1);
    const out = free.mixer.output;
    expect(out.weak).toBeGreaterThan(0.4);
    expect(out.strong).toBeGreaterThan(0);
    expect(out.strong).toBeLessThan(out.weak * 0.6);

    const tc = spinning(new Rig());
    rearSlip(tc.car, 0.3);
    tc.car.flags = FLAG_TC;
    tc.run(0.1);
    expect(tc.mixer.output.weak).toBeGreaterThan(0);
    expect(tc.mixer.output.weak).toBeLessThan(out.weak * 0.4);
  });
});

describe('lock-ups and ABS', () => {
  it('fades in from a slip ratio of −0.15 to full at −0.5 while braking', () => {
    const car = carAtRest();
    car.brake = 1;
    car.speed = 25;
    const at = (slip: number): number => {
      car.wheels[0]!.slipRatio = slip;
      return lockupLevel(car);
    };
    expect(at(-0.1)).toBe(0); // where ABS holds the tyre
    expect(at(-0.15)).toBe(0);
    expectRising([-0.2, -0.3, -0.4, -0.5].map(at));
    expect(at(-1)).toBe(1);
    car.brake = 0;
    expect(at(-1)).toBe(0);
    // The handbrake locks the rear wheels.
    car.handbrake = 1;
    car.wheels[0]!.slipRatio = 0;
    rearSlip(car, -1);
    expect(lockupLevel(car)).toBe(1);
  });

  it('fades out at walking pace and follows the direction of travel', () => {
    const car = carAtRest();
    car.brake = 1;
    rearSlip(car, -1);
    car.speed = 1;
    expect(lockupLevel(car)).toBe(0);
    car.speed = 3;
    expect(lockupLevel(car)).toBeGreaterThan(0);
    expect(lockupLevel(car)).toBeLessThan(1);
    car.speed = -20; // rolling backwards: a locked wheel turns slower backwards than the road
    expect(lockupLevel(car)).toBe(0);
    rearSlip(car, 1);
    expect(lockupLevel(car)).toBe(1);
  });

  it('is mostly on the strong motor', () => {
    const rig = new Rig();
    Object.assign(rig.car, { brake: 1, speed: 25, gear: 3 });
    for (const w of rig.car.wheels) w.slipRatio = -0.6;
    rig.run(0.1);
    const out = rig.mixer.output;
    expect(out.strong).toBeGreaterThan(0.4);
    expect(out.strong).toBeGreaterThan(out.weak);
  });

  it.each([60, 144])('pulses the weak motor at 15–20 Hz while ABS works (%i fps)', (fps) => {
    const rig = new Rig();
    Object.assign(rig.car, { brake: 1, speed: 25, gear: 3, flags: FLAG_ABS });
    for (const w of rig.car.wheels) w.slipRatio = -0.09; // held at the tyre's peak
    rig.run(0.6, fps);
    const calls = rig.calls;
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(call.weak).toBeGreaterThan(call.strong * 2);
    for (let i = 1; i < calls.length; i++) {
      const period = calls[i]!.at - calls[i - 1]!.at;
      expect(1 / period).toBeGreaterThanOrEqual(15);
      expect(1 / period).toBeLessThanOrEqual(20.5);
      // Each pulse ends well before the next starts, so the motor drops in between.
      expect(calls[i - 1]!.duration / 1000).toBeLessThan(period * 0.7);
    }
  });

  it('leaves ABS out when lock-ups are switched off', () => {
    const rig = new Rig({ channels: { ...defaultRumbleSettings().channels, lockup: false } });
    Object.assign(rig.car, { brake: 1, speed: 25, gear: 3, flags: FLAG_ABS });
    expect(rig.run(0.5).every(isSilent)).toBe(true);
    expect(rig.calls).toHaveLength(0);
  });
});

describe('gear shifts', () => {
  it('counts real gear changes, not selecting reverse or a reset at a standstill', () => {
    expect(isGearShift(2, 3, 20)).toBe(true);
    expect(isGearShift(4, 3, 20)).toBe(true);
    expect(isGearShift(3, 3, 20)).toBe(false);
    expect(isGearShift(1, -1, 0.3)).toBe(false);
    expect(isGearShift(-1, 1, 0)).toBe(false);
    expect(isGearShift(0, 1, 0)).toBe(false);
    expect(isGearShift(1, 2, 0)).toBe(true); // manual gearbox, standing still
    expect(isGearShift(4, 1, 0)).toBe(false); // the car was reset
  });

  it('gives a 70–90 ms thump on the strong motor, sent as one effect', () => {
    const rig = new Rig();
    Object.assign(rig.car, { gear: 2, speed: 20, rpm: 6000, throttle: 1 });
    rig.run(0.2);
    expect(rig.calls).toHaveLength(0);
    rig.car.gear = 3;
    const frames = rig.run(0.3);
    const thump = frames.filter((o) => o.strong > 0.3).length / FPS;
    expect(thump).toBeGreaterThanOrEqual(0.07);
    expect(thump).toBeLessThanOrEqual(0.09);
    expect(frames[0]!.strong).toBeGreaterThan(frames[0]!.weak * 3);
    expect(frames.at(-1)).toEqual(SILENT);
    // The effect ends with the thump, so nothing has to stop it.
    expect(rig.calls).toHaveLength(1);
    expect(rig.calls[0]!.type).toBe('dual-rumble');
    expect(rig.calls[0]!.duration).toBeGreaterThanOrEqual(70);
    expect(rig.calls[0]!.duration).toBeLessThanOrEqual(90);
    expect(rig.resets).toBe(0);
  });

  it('stays quiet when selecting reverse at a standstill and back', () => {
    const rig = new Rig();
    rig.car.brake = 1;
    rig.run(0.2);
    rig.car.gear = -1;
    const frames = rig.run(0.2);
    rig.car.gear = 1;
    frames.push(...rig.run(0.2));
    expect(frames.every(isSilent)).toBe(true);
    expect(rig.calls).toHaveLength(0);
  });

  it('gives a double tap when a downshift is refused', () => {
    const rig = new Rig();
    Object.assign(rig.car, { gear: 2, speed: 40, rpm: 7000, brake: 0.3 });
    rig.run(0.2);
    rig.car.flags = FLAG_SHIFT_DENIED; // the simulation holds it for 0.4 s
    rig.run(0.4);
    rig.car.flags = 0;
    rig.run(0.2);
    expect(rig.calls).toHaveLength(2);
    const [first, second] = rig.calls;
    expect(second!.at - first!.at).toBeGreaterThan(0.09);
    expect(second!.at - first!.at).toBeLessThan(0.13);
    for (const tap of rig.calls) {
      expect(tap.duration).toBeLessThanOrEqual(50);
      expect(tap.weak).toBeGreaterThan(tap.strong);
    }
  });
});

describe('rev limiter', () => {
  it('is full while the limiter cuts in, with a faint build-up over the last 500 rpm', () => {
    const car = carAtRest();
    car.gear = 3;
    const at = (rpm: number): number => {
      car.rpm = rpm;
      return limiterLevel(car);
    };
    expect(at(7000)).toBe(0);
    expect(at(7500)).toBe(0);
    expectRising([7600, 7750, 7900].map(at));
    expect(at(7990)).toBeLessThanOrEqual(0.35);
    car.flags = FLAG_LIMITER;
    expect(at(7800)).toBe(1);
    car.flags = 0;
    car.gear = 0;
    expect(at(7900)).toBe(0); // revving in neutral
    car.gear = 2;
    car.rpm = 5800;
    expect(limiterLevel(car, 6000)).toBeGreaterThan(0); // another car's limiter
  });

  it('is a light buzz on the weak motor', () => {
    const rig = new Rig();
    Object.assign(rig.car, { gear: 3, speed: 55, rpm: 8000, throttle: 1, flags: FLAG_LIMITER });
    rig.run(0.2);
    const out = rig.mixer.output;
    expect(out.weak).toBeGreaterThan(0.2);
    expect(out.weak).toBeLessThan(0.5);
    expect(out.strong).toBeLessThan(out.weak / 4);
  });
});

describe('off track', () => {
  it('grows with speed and with the share of wheels on grass', () => {
    const car = carAtRest();
    car.speed = 25;
    const onGrass = (count: number): number => {
      car.wheels.forEach((w, i) => (w.surface = i < count ? 1 : 0));
      return offroadLevel(car);
    };
    expect(onGrass(0)).toBe(0);
    expectRising([1, 2, 3, 4].map(onGrass));
    expect(onGrass(2)).toBeCloseTo(0.5);
    expect(onGrass(4)).toBe(1);
    const at = (speed: number): number => {
      car.speed = speed;
      return offroadLevel(car);
    };
    expect(at(0)).toBe(0);
    expectRising([2, 8, 15, 25].map(at));
    expect(at(10)).toBeCloseTo(0.4);
    expect(at(60)).toBe(1);
    expect(at(-25)).toBe(1); // reversing across the grass
    car.wheels[0]!.contact = false; // a wheel in the air doesn't rumble
    expect(at(25)).toBeCloseTo(0.75);
  });

  it('counts gravel as off track too, but not kerbs', () => {
    const car = carAtRest();
    car.speed = 25;
    car.wheels.forEach((w, i) => (w.surface = i < 2 ? SURFACE.GRAVEL : SURFACE.GRASS));
    expect(offroadLevel(car)).toBe(1);
    for (const w of car.wheels) w.surface = SURFACE.KERB;
    expect(offroadLevel(car)).toBe(0);
  });

  it('rumbles mostly on the strong motor, with an uneven texture', () => {
    const grass = (wheels: number, speed: number): RumbleOutput[] => {
      const rig = new Rig();
      Object.assign(rig.car, { gear: 3, speed, rpm: 5000 });
      rig.car.wheels.forEach((w, i) => (w.surface = i < wheels ? 1 : 0));
      return rig.run(1);
    };
    const full = grass(4, 25);
    const strong = full.map((o) => o.strong);
    for (const o of full) expect(o.strong).toBeGreaterThan(o.weak);
    expect(Math.min(...strong)).toBeGreaterThan(0.2);
    expect(Math.max(...strong) - Math.min(...strong)).toBeGreaterThan(0.05);
    const mean = (frames: RumbleOutput[]) =>
      frames.reduce((sum, o) => sum + o.strong, 0) / frames.length;
    expect(mean(grass(2, 12.5))).toBeLessThan(mean(full) * 0.4);
  });
});

describe('impacts', () => {
  it('ignores the jerk of normal driving and scales with the size of a knock', () => {
    expect(impactLevel(0)).toBe(0);
    expect(impactLevel(250)).toBe(0); // gear shifts and stamping on the brake
    expect(impactLevel(500)).toBe(0);
    expect(impactLevel(600)).toBeGreaterThanOrEqual(0.35);
    expectRising([600, 1000, 2000, 3000, 4000].map(impactLevel));
    expect(impactLevel(4000)).toBe(1);
    expect(impactLevel(1e6)).toBe(1);
    expect(impactLevel(Number.NaN)).toBe(0);
  });

  it('turns a sudden jump in acceleration into a short strong pulse', () => {
    const rig = new Rig();
    Object.assign(rig.car, { gear: 3, speed: 20, rpm: 5000, accelLong: -2 });
    rig.run(0.2);
    rig.car.accelLong = -45; // hit something: over 4 g within one frame
    const frames = rig.run(0.4);
    expect(frames[0]!.strong).toBeGreaterThan(0.5);
    expect(frames[0]!.strong).toBeGreaterThan(frames[0]!.weak);
    const pulse = frames.filter((o) => o.strong > 0.3).length / FPS;
    expect(pulse).toBeGreaterThan(0.1);
    expect(pulse).toBeLessThan(0.25);
    expect(frames.at(-1)).toEqual(SILENT);
    expect(rig.calls[0]!.strong).toBeGreaterThan(0.5);
  });

  it('lets a bigger knock raise a pulse that is already playing, without a gap', () => {
    const rig = new Rig();
    rig.run(0.1);
    rig.mixer.impact(0.4);
    const frames = rig.run(2 / FPS);
    rig.mixer.impact(0.9);
    frames.push(...rig.run(0.2));
    const pulse = frames.slice(0, 20);
    expect(pulse.every((o) => o.strong > 0)).toBe(true);
    expect(pulse[0]!.strong).toBeCloseTo(0.4 * 0.7);
    expect(peakStrong(pulse)).toBeCloseTo(0.9 * 0.7);
  });

  it('does not fire on hard braking, which builds up over a fifth of a second', () => {
    const rig = new Rig();
    Object.assign(rig.car, { gear: 4, speed: 50, rpm: 6000 });
    rig.run(0.1);
    rig.car.brake = 1;
    for (let i = 1; i <= 30; i++) {
      rig.car.accelLong = -20 * Math.min(i / 29, 1);
      rig.run(1 / FPS);
    }
    rig.run(0.2);
    expect(rig.calls).toHaveLength(0);
  });

  it('pulses when the car rolls over, and again when it lands back on its wheels', () => {
    const rig = new Rig();
    rig.run(0.1);
    rig.car.flags = FLAG_UPSIDE_DOWN;
    const over = rig.run(0.3);
    expect(peakStrong(over)).toBeGreaterThan(0.4);
    expect(over.at(-1)).toEqual(SILENT);
    rig.car.flags = 0; // teetering on its side: no second pulse straight away
    expect(rig.run(0.1).every(isSilent)).toBe(true);
    rig.car.flags = FLAG_UPSIDE_DOWN;
    rig.run(0.5);
    rig.car.flags = 0;
    expect(peakStrong(rig.run(0.2))).toBeGreaterThan(0.4);
  });

  it('takes impacts from collision events too', () => {
    const rig = new Rig();
    rig.run(0.1);
    rig.mixer.impact(0.5);
    const frames = rig.run(0.3);
    expect(frames[0]!.strong).toBeCloseTo(0.5 * 0.7);
    expect(frames.at(-1)).toEqual(SILENT);
  });

  it('does not read a reset as a crash once stop() was called', () => {
    const drive = (rig: Rig): void => {
      // Cornering hard: 1.6 g.
      Object.assign(rig.car, { gear: 4, speed: 30, rpm: 6000, throttle: 1, accelLat: 16 });
      rig.run(0.2);
    };
    const reset = (rig: Rig): RumbleOutput[] => {
      Object.assign(rig.car, { gear: 1, speed: 0, rpm: 900, throttle: 0, accelLat: 0 });
      return rig.run(0.5);
    };
    const plain = new Rig();
    drive(plain);
    expect(peakStrong(reset(plain))).toBeGreaterThan(0.2); // the jump looks like a knock
    const stopped = new Rig();
    drive(stopped);
    stopped.mixer.stop(stopped.pad);
    stopped.run(2 / FPS); // the reset arrives from the worker a couple of frames later
    expect(reset(stopped).every(isSilent)).toBe(true);
  });
});

describe('mixing', () => {
  const levels = (
    values: Partial<Record<RumbleChannel, RumbleOutput>>,
  ): Record<RumbleChannel, RumbleOutput> => {
    const all = {} as Record<RumbleChannel, RumbleOutput>;
    for (const { channel } of RUMBLE_CHANNELS) all[channel] = values[channel] ?? { ...SILENT };
    return all;
  };
  const fullStrength = (): RumbleSettings => ({ ...defaultRumbleSettings(), strength: 1 });

  it('adds effects up per motor without exceeding 1', () => {
    const out = mixMotors(
      levels({ wheelspin: { strong: 0.6, weak: 0.2 }, offroad: { strong: 0.6, weak: 0 } }),
      fullStrength(),
      { ...SILENT },
    );
    expect(out.strong).toBeCloseTo(0.84);
    expect(out.weak).toBeCloseTo(0.2);
    const everything = levels({});
    for (const { channel } of RUMBLE_CHANNELS) everything[channel] = { strong: 1, weak: 1 };
    expect(mixMotors(everything, fullStrength(), { ...SILENT })).toEqual({ strong: 1, weak: 1 });
  });

  it('leaves out disabled channels', () => {
    const settings = fullStrength();
    settings.channels.wheelspin = false;
    const out = mixMotors(levels({ wheelspin: { strong: 0.5, weak: 0.9 } }), settings, {
      strong: 1,
      weak: 1,
    });
    expect(out).toEqual(SILENT);
  });

  it('scales with the master strength and is silent when off', () => {
    const lockup = levels({ lockup: { strong: 0.8, weak: 0.4 } });
    const out = mixMotors(lockup, { ...fullStrength(), strength: 0.5 }, { ...SILENT });
    expect(out.strong).toBeCloseTo(0.4);
    expect(out.weak).toBeCloseTo(0.2);
    const off = mixMotors(lockup, { ...fullStrength(), enabled: false }, { strong: 1, weak: 1 });
    expect(off).toEqual(SILENT);
  });

  it('silences a disabled channel while it happens', () => {
    const rig = spinning(
      new Rig({ channels: { ...defaultRumbleSettings().channels, wheelspin: false } }),
    );
    expect(rig.run(0.3).every(isSilent)).toBe(true);
    expect(rig.calls).toHaveLength(0);
  });

  it('follows the master strength', () => {
    const spin = (strength: number): RumbleOutput => {
      const rig = spinning(new Rig({ strength }));
      rig.run(0.1);
      return { ...rig.mixer.output };
    };
    const half = spin(0.35);
    const full = spin(0.7);
    expect(full.weak).toBeGreaterThan(0.3);
    expect(half.weak).toBeCloseTo(full.weak / 2);
    expect(half.strong).toBeCloseTo(full.strong / 2);
    expect(spin(0)).toEqual(SILENT);
  });
});

describe('talking to the pad', () => {
  it('knows which pads can rumble', () => {
    const play = (): Promise<unknown> => Promise.resolve('complete');
    const pad = (actuator: RumblePad['vibrationActuator']): RumblePad => ({
      vibrationActuator: actuator,
    });
    expect(canRumble(pad({ effects: ['dual-rumble', 'trigger-rumble'], playEffect: play }))).toBe(
      true,
    );
    expect(canRumble(pad({ playEffect: play }))).toBe(true); // no effect list: older Chrome
    expect(canRumble(pad({ effects: [], playEffect: play }))).toBe(false);
    expect(canRumble(pad({ effects: ['trigger-rumble'], playEffect: play }))).toBe(false);
    expect(canRumble(pad({ effects: ['dual-rumble'] }))).toBe(false); // nothing to call
    expect(canRumble(pad(null))).toBe(false);
    expect(canRumble({})).toBe(false);
    expect(canRumble(null)).toBe(false);
    expect(canRumble(undefined)).toBe(false);
  });

  it('accepts a real Gamepad', () => {
    // Checked by the compiler: the DOM's Gamepad fits RumblePad.
    const asPad = (gamepad: Gamepad): RumblePad => gamepad;
    expect(asPad).toBeTypeOf('function');
  });

  it('sends nothing when rumble is off or the pad has no dual-rumble', () => {
    const off = spinning(new Rig({ enabled: false }));
    off.run(0.5);
    expect(off.calls).toHaveLength(0);
    expect(off.mixer.output).toEqual(SILENT);

    const triggersOnly = spinning(new Rig({}, { effects: ['trigger-rumble'] }));
    triggersOnly.run(0.5);
    triggersOnly.mixer.stop(triggersOnly.pad);
    triggersOnly.mixer.test(triggersOnly.pad);
    expect(triggersOnly.calls).toHaveLength(0);
    expect(triggersOnly.resets).toBe(0);

    const noPad = spinning(new Rig());
    expect(() => {
      noPad.mixer.update(1 / 60, noPad.car, null);
      noPad.mixer.update(1 / 60, noPad.car, { vibrationActuator: null });
      noPad.mixer.update(1 / 60, noPad.car, {});
    }).not.toThrow();
    // Still mixed, for the debug readout.
    expect(noPad.mixer.output.weak).toBeGreaterThan(0);
    expect(() => {
      noPad.mixer.stop(null);
      noPad.mixer.test(null);
    }).not.toThrow();
  });

  it('calls the pad at most every 50 ms (60 frames at 144 Hz: at most 9 calls)', () => {
    const rig = new Rig();
    rig.car.throttle = 1;
    for (let i = 1; i <= 60; i++) {
      rearSlip(rig.car, 0.12 + (0.23 * i) / 60); // a different output every frame
      rig.run(1 / FPS);
    }
    expect(rig.calls.length).toBeGreaterThanOrEqual(5);
    expect(rig.calls.length).toBeLessThanOrEqual(9);
    for (let i = 1; i < rig.calls.length; i++) {
      expect(rig.calls[i]!.at - rig.calls[i - 1]!.at).toBeGreaterThanOrEqual(0.049);
    }
  });

  it('renews a steady rumble before it runs out, and no more often than that', () => {
    const rig = spinning(new Rig());
    rig.run(1);
    const calls = rig.calls;
    expect(calls.length).toBeGreaterThanOrEqual(10);
    expect(calls.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < calls.length; i++) {
      const previous = calls[i - 1]!;
      // Each effect still runs when the next one replaces it: no gaps.
      expect(previous.at + previous.duration / 1000).toBeGreaterThan(calls[i]!.at);
    }
  });

  it('goes quiet when the effect ends, without calling while nothing happens', () => {
    const rig = spinning(new Rig());
    rig.run(0.3);
    rearSlip(rig.car, 0); // grip again
    const frames = rig.run(1);
    expect(frames.at(-1)).toEqual(SILENT);
    const quietFrom = rig.calls.length;
    rig.run(1);
    expect(rig.calls).toHaveLength(quietFrom);
    expect(rig.resets).toBeLessThanOrEqual(1);
  });

  it('stops the motors once when rumble is switched off mid-effect', () => {
    const rig = spinning(new Rig());
    rig.run(0.3);
    const sent = rig.calls.length;
    expect(sent).toBeGreaterThan(0);
    rig.mixer.settings.enabled = false;
    rig.run(0.5);
    expect(rig.resets).toBe(1);
    expect(rig.calls).toHaveLength(sent);
  });

  it('stop() calls reset(), or plays a silent effect on pads without it', () => {
    const rig = spinning(new Rig());
    rig.run(0.2);
    rig.mixer.stop(rig.pad);
    expect(rig.resets).toBe(1);
    expect(rig.mixer.output).toEqual(SILENT);

    const old = spinning(new Rig({}, { noReset: true }));
    old.run(0.2);
    const sent = old.calls.length;
    old.mixer.stop(old.pad);
    expect(old.calls).toHaveLength(sent + 1);
    expect(old.calls.at(-1)).toMatchObject({ strong: 0, weak: 0 });
  });

  it('never throws when playEffect rejects or throws', async () => {
    for (const fail of ['reject', 'throw'] as const) {
      const rig = spinning(new Rig({}, { fail }));
      expect(() => {
        rig.run(0.5);
        rig.mixer.stop(rig.pad);
        rig.mixer.test(rig.pad);
        rig.run(0.2);
      }).not.toThrow();
      expect(rig.calls.length).toBeGreaterThan(0);
      await flush(); // an unhandled rejection would fail the run
    }
  });
});

describe('test pattern', () => {
  it('plays a strong thump, then a weak buzz, about 0.6 s in all', async () => {
    const rig = new Rig();
    rig.mixer.test(rig.pad);
    expect(rig.calls).toHaveLength(1);
    await flush();
    expect(rig.calls).toHaveLength(2);
    const [thump, buzz] = rig.calls;
    expect(thump!.strong).toBeCloseTo(0.7); // at the master strength
    expect(thump!.strong).toBeGreaterThan(thump!.weak);
    expect(buzz!.weak).toBeCloseTo(0.7);
    expect(buzz!.weak).toBeGreaterThan(buzz!.strong);
    const total = thump!.duration + buzz!.startDelay + buzz!.duration;
    expect(total).toBeGreaterThanOrEqual(500);
    expect(total).toBeLessThanOrEqual(700);
  });

  it('keeps the pad until it finishes, and plays nothing while rumble is off', async () => {
    const rig = spinning(new Rig());
    rig.mixer.test(rig.pad);
    rig.run(0.1); // the pattern's promises haven't settled yet
    expect(rig.calls).toHaveLength(1);
    await flush();
    rig.run(0.1);
    expect(rig.calls.length).toBeGreaterThan(2);

    const off = new Rig({ enabled: false });
    off.mixer.test(off.pad);
    await flush();
    expect(off.calls).toHaveLength(0);
  });
});
