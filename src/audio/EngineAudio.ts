/**
 * Placeholder engine and tyre sound (Round 2): a V8 built from plain Web Audio nodes and steered
 * by the car state every frame. Round 8 replaces it with the AudioWorklet engine.
 *
 * Graph (every source starts once and runs until dispose; frames only move AudioParams):
 *
 *   V8 exhaust waves (on-load / idle-overrun, crossfaded by throttle)
 *   + combustion noise gated by the exhaust wave ─→ drive → tanh saturator → lowpass (rpm, load)
 *     → body resonances → DC block → random wobble → level → shift dip / limiter chop ─┐
 *   noise → two bandpasses → tyre squeal ────────────────────────────────────────────────┤
 *   noise → lowpass → wind; noise → lowpass → grass rumble ──────────────────────────────┴→
 *   stall guard → compressor → clip guard → master volume → speakers
 */
import { clamp } from '../shared/math';
import {
  clamp01,
  cycleFrequency,
  engineCutoff,
  engineDrive,
  engineGain,
  engineJitter,
  engineRoughness,
  fillWander,
  fillWhiteNoise,
  glideTime,
  otherEngineCutoff,
  otherEngineLevel,
  grassGain,
  IDLE_RPM,
  raspFrequency,
  raspGain,
  saturationCurve,
  softClipCurve,
  softSquareWave,
  squealFrequency,
  squealGain,
  v8ExhaustWave,
  rainGain,
  sprayGain,
  windCutoff,
  windGain,
  type ExhaustShape,
  type Waveform,
} from './synth';

export interface AudioFrame {
  /** Engine speed, rpm (idle ~900, limiter 8000). */
  rpm: number;
  /** Throttle actually applied, 0..1. */
  throttle: number;
  /** True while the rev limiter is cutting fuel (make it audibly stutter). */
  limiter: boolean;
  /** True during a gear change (~60 ms, power briefly cut). */
  shifting: boolean;
  /** Car speed, m/s (>= 0). */
  speed: number;
  /** Largest tyre slip across the four wheels: 0 = full grip, 1 = at the grip limit, > 1 sliding. */
  slip: number;
  /** 0..1: how much of the tyre contact is on grass (grass: no squeal, a soft rumble instead is optional). */
  offRoad: number;
  /** Rain falling on the car, 0 … 1, and how wet the road is, 0 … 1 (spray with speed). */
  rain?: number;
  wet?: number;
}

/** Mix levels, balanced against each other; the compressor and clip guard catch the sum. */
const LEVEL = {
  exhaust: 0.8,
  rasp: 2.5,
  engine: 0.5,
  squeal: 0.7,
  wind: 0.25,
  grass: 0.9,
  rain: 0.45,
  spray: 0.5,
  others: 0.3,
} as const;

/** Other cars heard at once (the nearest). */
export const OTHER_VOICES = 3;

/** Another car's engine as heard from the player's: its state, how far away and which side. */
export interface OtherEngine {
  rpm: number;
  throttle: number;
  distance: number;
  /** -1 (left) … 1 (right). */
  pan: number;
}

// Short pulses in both: real blowdown pulses stay short at idle, and the lowpass sets brightness.
const LOAD_SHAPE: ExhaustShape = {
  decay: 0.013,
  rise: 0.002,
  farBank: 0.75,
  spread: 0.06,
  seed: 11,
};
const IDLE_SHAPE: ExhaustShape = {
  decay: 0.012,
  rise: 0.0025,
  farBank: 0.45,
  spread: 0.12,
  seed: 23,
};

const DEFAULT_VOLUME = 0.7;
const VOLUME_TAU = 0.05;
/** Fade before a suspend or close: stopping the clock mid-waveform clicks. */
const FADE_TAU = 0.012;
const FADE_MS = 80;
/** Time without `update()` after which the sound fades out instead of droning on. */
const STALL_TIMEOUT = 0.35;
/** Rev-limiter fuel-cut stutter: chops the engine down to 1 − 2 × depth at this rate. */
const LIMITER_HZ = 24;
const LIMITER_DEPTH = 0.44;
/** Engine gain while the power is cut for a gear change. */
const SHIFT_DIP = 0.3;
/** Shortest time a limiter or shift flag is heard, so low frame rates can't skip it. */
const LIMITER_HOLD = 0.08;
const SHIFT_HOLD = 0.05;
/** The second squeal tone's ratio to the first: a slow beat between them makes it shimmer. */
const SQUEAL_SPREAD = 1.006;
const WANDER_RATE = 22050;

type AudioContextClass = new (options?: AudioContextOptions) => AudioContext;

/** The browser's AudioContext constructor (webkit-prefixed on old Safari), if it has one. */
function audioContextClass(): AudioContextClass | undefined {
  const scope = globalThis as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

const ignore = (): void => {};

/** Runs a promise-returning context call, ignoring refusals (autoplay policy, closed context). */
function quietly(run: () => Promise<void> | undefined): void {
  try {
    run()?.catch(ignore);
  } catch {
    // Old implementations throw instead of rejecting.
  }
}

/** An AudioParam steered by per-frame targets; skips the call when the target hasn't moved. */
class Knob {
  private readonly param: AudioParam;
  private last = Number.NaN;

  constructor(param: AudioParam) {
    this.param = param;
  }

  set(target: number, now: number, timeConstant: number): void {
    if (Math.abs(target - this.last) <= Math.abs(target) * 1e-4 + 1e-6) return;
    this.last = target;
    this.param.setTargetAtTime(target, now, timeConstant);
  }
}

interface Graph {
  master: GainNode;
  stallGuard: GainNode;
  pitchLoad: Knob;
  pitchIdle: Knob;
  loadMix: Knob;
  idleMix: Knob;
  raspFrequency: Knob;
  rasp: Knob;
  drive: Knob;
  cutoff: Knob;
  level: Knob;
  jitter: Knob;
  roughness: Knob;
  cutBase: Knob;
  cutDepth: Knob;
  squeal: Knob;
  squealA: Knob;
  squealB: Knob;
  squealBand: Knob;
  squealNoiseBand: Knob;
  windCutoff: Knob;
  wind: Knob;
  grass: Knob;
  rain: Knob;
  spray: Knob;
  /** The other cars' voices: pitch, brightness, level and (where the browser has it) pan each. */
  others: Array<{ pitch: Knob; cutoff: Knob; level: Knob; pan: Knob | null }>;
}

/**
 * Procedural V8 engine note plus tyre squeal, wind and grass rumble. Creates nothing audible until
 * `unlock()` succeeds, so it's safe to construct at startup. Without Web Audio it stays silent.
 */
export class EngineAudio {
  private ctx: AudioContext | undefined;
  private graph: Graph | undefined;
  private volume = DEFAULT_VOLUME;
  private muted = false;
  /** Set by suspend(): stay quiet, and don't let unlock() resume behind the caller's back. */
  private paused = false;
  private disposed = false;
  /** Creating the context failed once: don't retry on every key press. */
  private failed = false;
  private fadeTimer: ReturnType<typeof setTimeout> | undefined;
  private limiterHold = 0;
  private shiftHold = 0;

  /**
   * Browsers only allow audio after a user gesture: call from keydown/pointerdown/pointerup/
   * touchend (and try on gamepad presses). Creates/resumes the AudioContext. Safe to call often.
   */
  unlock(): void {
    if (this.disposed) return;
    if (!this.ctx) {
      if (this.failed) return;
      const AudioContextClass = audioContextClass();
      if (!AudioContextClass) {
        this.failed = true;
        return;
      }
      let ctx: AudioContext | undefined;
      try {
        ctx = new AudioContextClass({ latencyHint: 'interactive' });
        this.graph = buildGraph(ctx);
        this.ctx = ctx;
      } catch {
        this.failed = true;
        this.graph = undefined;
        const created = ctx;
        if (created) quietly(() => created.close());
        return;
      }
      this.applyMaster(VOLUME_TAU);
    }
    const ctx = this.ctx;
    if (!this.paused && ctx.state !== 'running') quietly(() => ctx.resume());
  }

  /** True once the AudioContext is running. */
  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Master volume 0..1 (default 0.7). Smoothly ramped. */
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = clamp(volume, 0, 1);
    this.applyMaster(VOLUME_TAU);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster(VOLUME_TAU);
  }

  /**
   * Call once per rendered frame with the latest car state (dt = frame time in seconds). Only
   * moves AudioParams: no nodes are created.
   */
  update(dt: number, frame: AudioFrame): void {
    const ctx = this.ctx;
    const graph = this.graph;
    // While the context isn't running its clock stands still, and scheduled events would pile up.
    if (!ctx || !graph || ctx.state !== 'running') return;
    try {
      this.steer(graph, ctx.currentTime, dt, frame);
    } catch {
      // Sound must never take the game loop down with it.
    }
  }

  /**
   * The nearest other cars, once per frame with the player's update: each gets a voice (an
   * exhaust wave, muffled and faded by distance); voices without a car fall silent.
   */
  updateOthers(dt: number, others: readonly OtherEngine[]): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph || ctx.state !== 'running') return;
    try {
      const now = ctx.currentTime;
      const step = dt > 0 ? Math.min(dt, 0.25) : 0;
      const tone = glideTime(step * 2, 0.015, 0.05);
      graph.others.forEach((voice, i) => {
        const o = others[i];
        if (!o) {
          voice.level.set(0, now, tone);
          return;
        }
        voice.pitch.set(cycleFrequency(o.rpm), now, tone);
        voice.cutoff.set(otherEngineCutoff(o.rpm, o.throttle, o.distance), now, tone);
        voice.level.set(otherEngineLevel(o.rpm, o.throttle, o.distance) * LEVEL.others, now, tone);
        const pan = Number.isFinite(o.pan) ? Math.max(-1, Math.min(1, o.pan)) : 0;
        voice.pan?.set(pan, now, tone);
      });
    } catch {
      // Sound must never take the game loop down with it.
    }
  }

  /** Pause when the tab is hidden: fades out, then suspends the AudioContext. */
  suspend(): void {
    this.paused = true;
    const ctx = this.ctx;
    if (!ctx) return;
    this.applyMaster(FADE_TAU);
    clearTimeout(this.fadeTimer);
    this.fadeTimer = setTimeout(() => {
      if (this.paused && this.ctx === ctx) quietly(() => ctx.suspend());
    }, FADE_MS);
  }

  /** Resume when the tab is visible again (a later unlock() retries if the browser refuses). */
  resume(): void {
    this.paused = false;
    clearTimeout(this.fadeTimer);
    const ctx = this.ctx;
    if (!ctx) return;
    quietly(() => ctx.resume());
    this.applyMaster(VOLUME_TAU);
  }

  /** Fades out and closes the AudioContext. The instance stays silent afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.fadeTimer);
    const ctx = this.ctx;
    const graph = this.graph;
    this.ctx = undefined;
    this.graph = undefined;
    if (!ctx) return;
    try {
      graph?.master.gain.setTargetAtTime(0, ctx.currentTime, FADE_TAU);
    } catch {
      // Closing anyway.
    }
    setTimeout(() => quietly(() => ctx.close()), FADE_MS);
  }

  private applyMaster(timeConstant: number): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph) return;
    const target = this.muted || this.paused ? 0 : this.volume;
    try {
      graph.master.gain.setTargetAtTime(target, ctx.currentTime, timeConstant);
    } catch {
      // Context already closed.
    }
  }

  private steer(g: Graph, now: number, dt: number, f: AudioFrame): void {
    const step = dt > 0 ? Math.min(dt, 0.25) : 0;
    this.limiterHold = f.limiter ? LIMITER_HOLD : Math.max(0, this.limiterHold - step);
    this.shiftHold = f.shifting ? SHIFT_HOLD : Math.max(0, this.shiftHold - step);
    const shifting = this.shiftHold > 0;
    // Power is cut while shifting, so the note briefly sounds like a lift.
    const throttle = shifting ? 0 : clamp01(f.throttle);
    const rpm = f.rpm;
    // Follow the frame rate: at 30 fps a 5 ms glide would leave audible steps between frames.
    const glide = glideTime(step, 0.006, 0.03);
    const tone = glideTime(step * 2, 0.015, 0.05);

    const pitch = cycleFrequency(rpm);
    g.pitchLoad.set(pitch, now, glide);
    g.pitchIdle.set(pitch, now, glide);
    // Equal-power crossfade from the burbly idle/overrun wave to the harsher on-load wave.
    const angle = (throttle * Math.PI) / 2;
    g.loadMix.set(Math.sin(angle) * LEVEL.exhaust, now, tone);
    g.idleMix.set(Math.cos(angle) * LEVEL.exhaust, now, tone);
    g.raspFrequency.set(raspFrequency(rpm), now, tone);
    g.rasp.set(raspGain(rpm, throttle) * LEVEL.rasp, now, tone);
    const drive = engineDrive(rpm, throttle);
    g.drive.set(drive, now, tone);
    g.cutoff.set(engineCutoff(rpm, throttle), now, tone);
    // More drive makes the saturator louder; take that back out of the level.
    g.level.set((engineGain(rpm, throttle) * LEVEL.engine) / Math.sqrt(drive), now, tone);
    g.jitter.set(engineJitter(rpm), now, tone);
    g.roughness.set(engineRoughness(rpm, throttle), now, tone);

    // Shift dip and limiter chop share one gain: dip × (1 − chop + chop × soft square).
    const dip = shifting ? SHIFT_DIP : 1;
    const chop = this.limiterHold > 0 ? LIMITER_DEPTH : 0;
    const cutTau = shifting ? 0.01 : 0.02;
    g.cutBase.set(dip * (1 - chop), now, cutTau);
    g.cutDepth.set(dip * chop, now, cutTau);

    const squealHz = squealFrequency(f.speed, f.slip);
    g.squeal.set(squealGain(f.slip, f.speed, f.offRoad) * LEVEL.squeal, now, tone);
    g.squealA.set(squealHz, now, tone);
    g.squealB.set(squealHz * SQUEAL_SPREAD, now, tone);
    g.squealBand.set(squealHz, now, tone);
    g.squealNoiseBand.set(squealHz, now, tone);
    g.windCutoff.set(windCutoff(f.speed), now, tone);
    g.wind.set(windGain(f.speed) * LEVEL.wind, now, tone);
    g.grass.set(grassGain(f.offRoad, f.speed) * LEVEL.grass, now, tone);
    g.rain.set(rainGain(f.rain ?? 0) * LEVEL.rain, now, tone);
    g.spray.set(sprayGain(f.wet ?? 0, f.speed) * LEVEL.spray, now, tone);

    // Stall guard: every frame pushes a fade-out STALL_TIMEOUT into the future. If frames stop
    // (long hitch, a pause without suspend()), the fade runs instead of the note droning on. When
    // they return, setTargetAtTime starts from wherever the fade got to, so nothing jumps.
    const guard = g.stallGuard.gain;
    guard.cancelScheduledValues(now);
    guard.setTargetAtTime(1, now, 0.03);
    guard.setTargetAtTime(0, now + STALL_TIMEOUT, 0.08);
  }
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const node = ctx.createGain();
  node.gain.value = value;
  return node;
}

function filterNode(
  ctx: BaseAudioContext,
  type: BiquadFilterType,
  frequency: number,
  q: number,
  gain = 0,
): BiquadFilterNode {
  const node = ctx.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = q;
  node.gain.value = gain;
  return node;
}

function oscillator(ctx: BaseAudioContext, wave: Waveform, frequency: number): OscillatorNode {
  const node = ctx.createOscillator();
  node.setPeriodicWave(
    ctx.createPeriodicWave(wave.real, wave.imag, { disableNormalization: true }),
  );
  node.frequency.value = frequency;
  return node;
}

function looped(ctx: BaseAudioContext, buffer: AudioBuffer, rate: number): AudioBufferSourceNode {
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  node.playbackRate.value = rate;
  return node;
}

/** Builds the whole graph once (see the file comment) and starts its sources. */
function buildGraph(ctx: BaseAudioContext): Graph {
  const rate = ctx.sampleRate;

  // Output chain. The stall guard keeps everything silent until the first update().
  const master = gainNode(ctx, 0);
  master.connect(ctx.destination);
  const clipGuard = ctx.createWaveShaper();
  clipGuard.curve = softClipCurve();
  clipGuard.connect(master);
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -6;
  compressor.knee.value = 6;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.2;
  compressor.connect(clipGuard);
  const stallGuard = gainNode(ctx, 0);
  stallGuard.connect(compressor);

  // Shared sources: 2 s of white noise, and a slow random wander for pitch and level wobble.
  const noise = ctx.createBuffer(1, Math.round(rate * 2), rate);
  fillWhiteNoise(noise.getChannelData(0), 0x5eed);
  const wander = ctx.createBuffer(1, WANDER_RATE * 5, WANDER_RATE);
  fillWander(wander.getChannelData(0), WANDER_RATE, 40, 0xbeef);
  const engineNoise = looped(ctx, noise, 1);
  const roadNoise = looped(ctx, noise, 1);
  const slowWander = looped(ctx, wander, 0.2);
  const fastWander = looped(ctx, wander, 1);

  // Engine: two exhaust waves at the cycle frequency, crossfaded by throttle.
  const loadWave = v8ExhaustWave(LOAD_SHAPE);
  const f0 = cycleFrequency(IDLE_RPM);
  const loadOsc = oscillator(ctx, loadWave, f0);
  const idleOsc = oscillator(ctx, v8ExhaustWave(IDLE_SHAPE), f0);
  const loadMix = gainNode(ctx, 0);
  const idleMix = gainNode(ctx, LEVEL.exhaust);
  loadOsc.connect(loadMix);
  idleOsc.connect(idleMix);

  // Combustion noise, gated by the exhaust wave itself so each burst lands on a firing pulse.
  const raspBand = filterNode(ctx, 'bandpass', raspFrequency(IDLE_RPM), 0.8);
  const raspGate = gainNode(ctx, -loadWave.min);
  loadOsc.connect(raspGate.gain);
  const rasp = gainNode(ctx, 0);
  engineNoise.connect(raspBand).connect(raspGate).connect(rasp);

  const drive = gainNode(ctx, 1);
  loadMix.connect(drive);
  idleMix.connect(drive);
  rasp.connect(drive);
  const shaper = ctx.createWaveShaper();
  shaper.curve = saturationCurve(1.5);
  shaper.oversample = '2x';
  // Lowpass Q is in dB: a mild resonance that moves with rpm, like intake roar.
  const lowpass = filterNode(ctx, 'lowpass', 600, 3);
  // Fixed resonances the harmonics sweep through as rpm changes, placed where small speakers
  // still play; the highpass drops sub-audio orders that would only eat headroom.
  const body = filterNode(ctx, 'peaking', 180, 0.8, 3);
  const pipe = filterNode(ctx, 'peaking', 700, 1.2, 4);
  const dcBlock = filterNode(ctx, 'highpass', 50, -3);
  const wobble = gainNode(ctx, 1);
  const level = gainNode(ctx, 0);
  const cut = gainNode(ctx, 1);
  drive
    .connect(shaper)
    .connect(lowpass)
    .connect(body)
    .connect(pipe)
    .connect(dcBlock)
    .connect(wobble)
    .connect(level)
    .connect(cut)
    .connect(stallGuard);

  // Random pitch wander (cents) and level wobble keep it from sounding like a test tone.
  const jitter = gainNode(ctx, 0);
  slowWander.connect(jitter);
  jitter.connect(loadOsc.detune);
  jitter.connect(idleOsc.detune);
  const roughness = gainNode(ctx, 0);
  fastWander.connect(roughness).connect(wobble.gain);

  // Rev limiter: a soft square wave chops the engine while its depth is up.
  const limiterOsc = oscillator(ctx, softSquareWave(), LIMITER_HZ);
  const cutDepth = gainNode(ctx, 0);
  limiterOsc.connect(cutDepth).connect(cut.gain);

  // Tyre squeal: the stick-slip tone of a sliding tyre. Two slightly detuned sawtooths (all
  // the harmonics) through a resonant band, warbling and wandering in pitch, over a little
  // noise in the same band for the scrub.
  const squealOscA = ctx.createOscillator();
  squealOscA.type = 'sawtooth';
  squealOscA.frequency.value = 1000;
  const squealOscB = ctx.createOscillator();
  squealOscB.type = 'sawtooth';
  squealOscB.frequency.value = 1000 * SQUEAL_SPREAD;
  const squealBand = filterNode(ctx, 'bandpass', 1000, 2.2);
  const squealTone = gainNode(ctx, 0.5);
  squealOscA.connect(squealBand);
  squealOscB.connect(squealBand);
  squealBand.connect(squealTone);
  const squealNoiseBand = filterNode(ctx, 'bandpass', 1000, 5);
  const squealNoise = gainNode(ctx, 0.35);
  roadNoise.connect(squealNoiseBand).connect(squealNoise);
  const squeal = gainNode(ctx, 0);
  squealTone.connect(squeal);
  squealNoise.connect(squeal);
  squeal.connect(stallGuard);
  // Pitch: a 6.5 Hz warble on top of the random wander.
  const squealVibrato = ctx.createOscillator();
  squealVibrato.frequency.value = 6.5;
  const squealVibratoDepth = gainNode(ctx, 22);
  squealVibrato.connect(squealVibratoDepth);
  const squealWobble = gainNode(ctx, 40);
  fastWander.connect(squealWobble);
  for (const target of [squealOscA.detune, squealOscB.detune, squealBand.detune]) {
    squealVibratoDepth.connect(target);
    squealWobble.connect(target);
  }

  // Wind and grass rumble.
  const windFilter = filterNode(ctx, 'lowpass', windCutoff(0), 0);
  const wind = gainNode(ctx, 0);
  roadNoise.connect(windFilter).connect(wind).connect(stallGuard);
  const grassFilter = filterNode(ctx, 'lowpass', 160, 4);
  const grass = gainNode(ctx, 0);
  roadNoise.connect(grassFilter).connect(grass).connect(stallGuard);
  // Rain: a patter on the roof and glass (a band of hiss), and the spray off a wet road.
  const rainFilter = filterNode(ctx, 'bandpass', 2600, 0.5);
  const rain = gainNode(ctx, 0);
  roadNoise.connect(rainFilter).connect(rain).connect(stallGuard);
  const sprayFilter = filterNode(ctx, 'lowpass', 900, 0.7);
  const spray = gainNode(ctx, 0);
  roadNoise.connect(sprayFilter).connect(spray).connect(stallGuard);

  // Other cars' engines: one exhaust wave each, muffled and faded with distance, each detuned
  // a little from the player's and from each other so they don't phase.
  const others: Graph['others'] = [];
  const otherOscs: OscillatorNode[] = [];
  for (let i = 0; i < OTHER_VOICES; i++) {
    const osc = oscillator(ctx, loadWave, f0);
    osc.detune.value = 5 + (i - 1) * 9;
    const filter = filterNode(ctx, 'lowpass', 500, 1);
    const gain = gainNode(ctx, 0);
    // Panned by the car's bearing where the browser has a stereo panner.
    const panner = typeof ctx.createStereoPanner === 'function' ? ctx.createStereoPanner() : null;
    if (panner) osc.connect(filter).connect(gain).connect(panner).connect(stallGuard);
    else osc.connect(filter).connect(gain).connect(stallGuard);
    otherOscs.push(osc);
    others.push({
      pitch: new Knob(osc.frequency),
      cutoff: new Knob(filter.frequency),
      level: new Knob(gain.gain),
      pan: panner ? new Knob(panner.pan) : null,
    });
  }

  const now = ctx.currentTime;
  loadOsc.start(now);
  idleOsc.start(now);
  limiterOsc.start(now);
  for (const osc of otherOscs) osc.start(now);
  squealOscA.start(now);
  squealOscB.start(now);
  squealVibrato.start(now);
  engineNoise.start(now);
  // Offsets decorrelate sources that share a buffer.
  roadNoise.start(now, 0.9);
  slowWander.start(now, 1.3);
  fastWander.start(now, 3.1);

  return {
    master,
    stallGuard,
    others,
    pitchLoad: new Knob(loadOsc.frequency),
    pitchIdle: new Knob(idleOsc.frequency),
    loadMix: new Knob(loadMix.gain),
    idleMix: new Knob(idleMix.gain),
    raspFrequency: new Knob(raspBand.frequency),
    rasp: new Knob(rasp.gain),
    drive: new Knob(drive.gain),
    cutoff: new Knob(lowpass.frequency),
    level: new Knob(level.gain),
    jitter: new Knob(jitter.gain),
    roughness: new Knob(roughness.gain),
    cutBase: new Knob(cut.gain),
    cutDepth: new Knob(cutDepth.gain),
    squeal: new Knob(squeal.gain),
    squealA: new Knob(squealOscA.frequency),
    squealB: new Knob(squealOscB.frequency),
    squealBand: new Knob(squealBand.frequency),
    squealNoiseBand: new Knob(squealNoiseBand.frequency),
    windCutoff: new Knob(windFilter.frequency),
    wind: new Knob(wind.gain),
    grass: new Knob(grass.gain),
    rain: new Knob(rain.gain),
    spray: new Knob(spray.gain),
  };
}
