import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineAudio, type AudioFrame } from '../../src/audio/EngineAudio';
import {
  cycleFrequency,
  engineCutoff,
  engineGain,
  fillWander,
  fillWhiteNoise,
  firingFrequency,
  grassGain,
  saturationCurve,
  softClipCurve,
  softSquareWave,
  squealFrequency,
  squealGain,
  v8ExhaustWave,
  windGain,
  type Waveform,
} from '../../src/audio/synth';
import { mulberry32 } from '../../src/shared/math';

const WEIRD = [Number.NaN, -1, -1e9, 0, 1e9, Infinity, -Infinity];

/** Strictly increasing over the given inputs. */
function expectRising(values: number[]): void {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]!);
}

const rpms = [900, 2000, 3500, 5000, 6500, 8000];

describe('engine mappings', () => {
  it('fires a V8 four times per crank revolution', () => {
    expect(firingFrequency(900)).toBeCloseTo(60);
    expect(firingFrequency(8000)).toBeCloseTo(533.3, 1);
    expect(cycleFrequency(6000)).toBeCloseTo(firingFrequency(6000) / 8);
    expectRising(rpms.map(firingFrequency));
  });

  it('gets brighter with rpm and with throttle', () => {
    for (const throttle of [0, 0.5, 1])
      expectRising(rpms.map((rpm) => engineCutoff(rpm, throttle)));
    for (const rpm of rpms) expectRising([0, 0.3, 0.7, 1].map((t) => engineCutoff(rpm, t)));
  });

  it('gets louder with rpm and with throttle; overrun is quieter than load', () => {
    for (const throttle of [0, 0.5, 1]) expectRising(rpms.map((rpm) => engineGain(rpm, throttle)));
    for (const rpm of rpms) expectRising([0, 0.3, 0.7, 1].map((t) => engineGain(rpm, t)));
    expect(engineGain(7000, 0)).toBeLessThan(engineGain(7000, 1) * 0.5);
    expect(engineCutoff(7000, 0)).toBeLessThan(engineCutoff(7000, 1) * 0.5);
    expect(engineGain(8000, 1)).toBeLessThanOrEqual(1);
    expect(engineGain(900, 0)).toBeGreaterThan(0.1); // idle stays audible
  });

  it('stays finite and bounded for NaN, negative and huge inputs', () => {
    for (const a of WEIRD) {
      for (const b of WEIRD) {
        for (const v of [firingFrequency(a), engineCutoff(a, b)]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThan(20);
          expect(v).toBeLessThan(20_000);
        }
        for (const v of [engineGain(a, b), squealGain(a, b, 0), windGain(a), grassGain(a, b)]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
        expect(Number.isFinite(squealFrequency(a, b))).toBe(true);
      }
    }
  });
});

describe('tyre and road mappings', () => {
  it('is silent below the grip limit and at standstill', () => {
    for (const slip of [0, 0.3, 0.6, 0.7]) expect(squealGain(slip, 30, 0)).toBe(0);
    for (const slip of [0.9, 1.2, 2]) {
      expect(squealGain(slip, 0, 0)).toBe(0);
      expect(squealGain(slip, 2, 0)).toBe(0);
    }
  });

  it('rises through the grip limit to full squeal when sliding', () => {
    expectRising([0.85, 0.95, 1.05, 1.15, 1.25].map((slip) => squealGain(slip, 30, 0)));
    expect(squealGain(1.3, 30, 0)).toBe(1);
    expect(squealGain(3, 30, 0)).toBe(1);
  });

  it('does not squeal on grass, which rumbles instead', () => {
    expect(squealGain(1.5, 30, 1)).toBe(0);
    expect(squealGain(1.5, 30, 0.5)).toBeCloseTo(0.5);
    expect(grassGain(1, 20)).toBe(1);
    expect(grassGain(0, 20)).toBe(0);
    expect(grassGain(1, 0)).toBe(0);
  });

  it('keeps the squeal pitch around a kilohertz (0.8–2 kHz), rising with speed', () => {
    expectRising([5, 20, 40, 60].map((v) => squealFrequency(v, 1.2)));
    for (const v of [0, 30, 100, 1e6]) {
      expect(squealFrequency(v, 5)).toBeGreaterThanOrEqual(800);
      expect(squealFrequency(v, 5)).toBeLessThanOrEqual(2000);
    }
  });

  it('adds wind noise with speed', () => {
    expect(windGain(0)).toBe(0);
    expectRising([10, 30, 50, 70].map(windGain));
    expect(windGain(-40)).toBe(windGain(40));
  });
});

/** Rebuilds one cycle of a waveform from its Fourier terms. */
function render(wave: Waveform, samples = 512): number[] {
  return Array.from({ length: samples }, (_, i) => {
    let v = 0;
    for (let h = 1; h < wave.real.length; h++) {
      const phase = (2 * Math.PI * h * i) / samples;
      v += wave.real[h]! * Math.cos(phase) + wave.imag[h]! * Math.sin(phase);
    }
    return v;
  });
}

const magnitude = (wave: Waveform, h: number): number => Math.hypot(wave.real[h]!, wave.imag[h]!);

describe('waveforms', () => {
  const load = v8ExhaustWave({ decay: 0.018, rise: 0.0025, farBank: 0.75, spread: 0.06, seed: 1 });
  const idle = v8ExhaustWave({ decay: 0.03, rise: 0.006, farBank: 0.45, spread: 0.12, seed: 2 });

  it('normalises the V8 exhaust wave to a peak of 1 and reports its floor', () => {
    for (const wave of [load, idle]) {
      const values = render(wave);
      expect(Math.max(...values.map(Math.abs))).toBeCloseTo(1, 1);
      expect(Math.min(...values)).toBeCloseTo(wave.min, 1);
      expect(wave.min).toBeLessThan(0);
    }
  });

  it('puts the firing frequency (8th harmonic) on top, with burble below it', () => {
    for (let h = 1; h < 8; h++) expect(magnitude(load, 8)).toBeGreaterThan(magnitude(load, h));
    const burble = (w: Waveform) => [1, 2, 3, 4, 5, 6, 7].reduce((s, h) => s + magnitude(w, h), 0);
    expect(burble(load)).toBeGreaterThan(0.05 * magnitude(load, 8));
    // The idle/overrun wave is lumpier than the on-load wave.
    expect(burble(idle) / magnitude(idle, 8)).toBeGreaterThan(burble(load) / magnitude(load, 8));
  });

  it('builds a soft square from odd harmonics only', () => {
    const square = softSquareWave();
    for (let h = 2; h < square.imag.length; h += 2) expect(square.imag[h]).toBe(0);
    expect(Math.max(...render(square).map(Math.abs))).toBeCloseTo(1, 2);
  });

  it('saturates symmetrically, maps silence to silence and never exceeds full scale', () => {
    const curve = saturationCurve(1.5);
    expect(curve.length % 2).toBe(1);
    expect(curve[(curve.length - 1) / 2]).toBe(0);
    expect(curve[0]).toBeCloseTo(-1);
    expect(curve[curve.length - 1]).toBeCloseTo(1);
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]!);
  });

  it('clip guard is transparent at normal levels and stays below full scale', () => {
    const curve = softClipCurve();
    const at = (x: number) => curve[Math.round(((x + 1) / 2) * (curve.length - 1))]!;
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.7)).toBeCloseTo(-0.7, 3);
    expect(Math.max(...curve.map(Math.abs))).toBeLessThan(0.98);
  });

  it('makes bounded noise and a smooth, seamlessly looping wander', () => {
    const noise = new Float32Array(48_000);
    fillWhiteNoise(noise, 1);
    const mean = noise.reduce((s, v) => s + v, 0) / noise.length;
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(Math.max(...noise.map(Math.abs))).toBeLessThanOrEqual(1);

    const rate = 8000;
    const wander = new Float32Array(rate * 2);
    fillWander(wander, rate, 40, 7);
    expect(Math.max(...wander.map(Math.abs))).toBeCloseTo(1, 3);
    let maxStep = 0;
    for (let i = 1; i < wander.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(wander[i]! - wander[i - 1]!));
    }
    expect(maxStep).toBeLessThan(0.02);
    expect(Math.abs(wander[0]! - wander[wander.length - 1]!)).toBeLessThan(0.02);
  });
});

// A stand-in for Web Audio that records calls and, like browsers, rejects non-finite values.
const errors: string[] = [];
let paramCalls = 0;

class FakeParam {
  value = 0;
  lastTarget = Number.NaN;
  private check(...values: number[]): void {
    paramCalls++;
    if (!values.every(Number.isFinite)) errors.push(`non-finite: ${values.join(', ')}`);
    if (values.some((v) => v < 0) && values.length > 1) errors.push(`negative time: ${values}`);
  }
  setTargetAtTime(v: number, time: number, tau: number): void {
    this.check(time, tau);
    this.check(v);
    this.lastTarget = v;
  }
  setValueAtTime(v: number, time: number): void {
    this.check(v);
    this.check(time);
  }
  linearRampToValueAtTime(v: number, time: number): void {
    this.check(v);
    this.check(time);
  }
  cancelScheduledValues(time: number): void {
    this.check(time);
  }
}

type FakeNode = Record<string | symbol, unknown>;

class FakeContext {
  static instances: FakeContext[] = [];
  state = 'suspended';
  currentTime = 0;
  sampleRate = 48_000;
  readonly edges: Array<[FakeNode, unknown]> = [];
  readonly destination = this.node();

  constructor() {
    FakeContext.instances.push(this);
  }

  resume(): Promise<void> {
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    if (this.state !== 'closed') this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  }
  createPeriodicWave(): object {
    return {};
  }
  createGain = () => this.node();
  createOscillator = () => this.node();
  createBiquadFilter = () => this.node();
  createBufferSource = () => this.node();
  createWaveShaper = () => this.node();
  createDynamicsCompressor = () => this.node();

  /** A node whose every unknown property is an AudioParam. */
  private node(): FakeNode {
    const props: FakeNode = { start: () => {}, stop: () => {}, setPeriodicWave: () => {} };
    const node = new Proxy(props, {
      get: (target, key) => (key in target ? target[key] : (target[key] = new FakeParam())),
    });
    props.connect = (dest: unknown) => {
      this.edges.push([node, dest]);
      return dest;
    };
    return node;
  }

  /** The master volume: the node feeding the speakers. */
  masterGain(): FakeParam {
    const edge = this.edges.find(([, dest]) => dest === this.destination);
    return edge![0].gain as FakeParam;
  }
}

const frame = (over: Partial<AudioFrame> = {}): AudioFrame => ({
  rpm: 3000,
  throttle: 0.5,
  limiter: false,
  shifting: false,
  speed: 20,
  slip: 0.2,
  offRoad: 0,
  ...over,
});

describe('EngineAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeContext.instances = [];
    errors.length = 0;
    paramCalls = 0;
  });

  it('stays silent and never throws without Web Audio', () => {
    vi.stubGlobal('AudioContext', undefined);
    const audio = new EngineAudio();
    audio.unlock();
    audio.unlock();
    audio.setVolume(0.5);
    audio.setMuted(true);
    audio.update(1 / 60, frame());
    audio.suspend();
    audio.resume();
    expect(audio.running).toBe(false);
    audio.dispose();
  });

  it('creates one context on unlock and survives garbage frames without bad AudioParam values', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const audio = new EngineAudio();
    expect(FakeContext.instances).toHaveLength(0); // nothing before a user gesture
    audio.unlock();
    audio.unlock();
    expect(FakeContext.instances).toHaveLength(1);
    expect(audio.running).toBe(true);

    const ctx = FakeContext.instances[0]!;
    const rand = mulberry32(99);
    const pick = (scale: number) =>
      rand() < 0.15 ? WEIRD[Math.floor(rand() * WEIRD.length)]! : rand() * scale;
    for (let i = 0; i < 3000; i++) {
      ctx.currentTime += 1 / 60;
      audio.update(pick(0.1), {
        rpm: pick(9000),
        throttle: pick(1),
        limiter: rand() < 0.2,
        shifting: rand() < 0.1,
        speed: pick(90),
        slip: pick(2),
        offRoad: pick(1),
      });
    }
    expect(errors).toEqual([]);
    expect(paramCalls).toBeGreaterThan(3000);
  });

  it('ramps the master volume and mutes', () => {
    vi.stubGlobal('AudioContext', FakeContext);
    const audio = new EngineAudio();
    audio.unlock();
    const master = FakeContext.instances[0]!.masterGain();
    expect(master.lastTarget).toBeCloseTo(0.7);
    audio.setVolume(0.4);
    expect(master.lastTarget).toBeCloseTo(0.4);
    audio.setMuted(true);
    expect(master.lastTarget).toBe(0);
    audio.setVolume(2);
    expect(master.lastTarget).toBe(0);
    audio.setMuted(false);
    expect(master.lastTarget).toBe(1);
    audio.setVolume(Number.NaN);
    expect(master.lastTarget).toBe(1);
  });

  it('fades out before suspending, resumes, and closes on dispose', () => {
    vi.useFakeTimers();
    vi.stubGlobal('AudioContext', FakeContext);
    const audio = new EngineAudio();
    audio.unlock();
    const ctx = FakeContext.instances[0]!;
    const master = ctx.masterGain();

    audio.suspend();
    expect(master.lastTarget).toBe(0);
    expect(ctx.state).toBe('running'); // still fading
    vi.advanceTimersByTime(200);
    expect(ctx.state).toBe('suspended');
    audio.unlock(); // a key press while hidden must not resume behind suspend()
    expect(ctx.state).toBe('suspended');

    audio.resume();
    expect(audio.running).toBe(true);
    expect(master.lastTarget).toBeCloseTo(0.7);

    audio.dispose();
    vi.advanceTimersByTime(200);
    expect(ctx.state).toBe('closed');
    const calls = paramCalls;
    audio.update(1 / 60, frame());
    audio.unlock();
    expect(paramCalls).toBe(calls);
    expect(FakeContext.instances).toHaveLength(1);
  });
});
