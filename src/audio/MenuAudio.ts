/**
 * Menu audio, all generated in code: a synthwave music loop for the menus (pads, bass, an arpeggio
 * and drums, scheduled a moment ahead on the audio clock) and short interface sounds for moving,
 * selecting and going back. Its own AudioContext, unlocked by the first user gesture.
 */

export type UiSound = 'move' | 'select' | 'back' | 'tab' | 'start';

const BPM = 96;
const BEAT = 60 / BPM;
const STEP = BEAT / 4;
/** Schedule this far ahead of the audio clock, seconds. */
const LOOKAHEAD = 0.15;
/** Bars in the loop: 4 intro bars (pads), then bass and drums, then the arpeggio. */
const BARS = 16;
/** A minor: Am – F – C – G, as MIDI notes (root, third, fifth). */
const CHORDS: ReadonlyArray<readonly [number, number, number]> = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

export class MenuAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private delay: DelayNode | null = null;
  private noise: AudioBuffer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Next 16th-note step to schedule, and when it plays on the audio clock. */
  private step = 0;
  private nextTime = 0;
  private musicOn = false;
  private musicLevel = 0.5;
  private sfxLevel = 0.6;
  private muted = false;
  private failed = false;

  /** Creates or resumes the audio context; call from a user gesture. */
  unlock(): void {
    if (this.failed) return;
    if (!this.ctx) {
      try {
        this.build(new AudioContext());
      } catch {
        this.failed = true;
        return;
      }
    }
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    if (this.musicOn) this.startScheduler();
  }

  setLevels(music: number, sfx: number, muted: boolean): void {
    this.musicLevel = music;
    this.sfxLevel = sfx;
    this.muted = muted;
    this.applyLevels(0.3);
  }

  /** Music plays in the menus and fades out while driving. */
  setMusic(on: boolean): void {
    if (on === this.musicOn) return;
    this.musicOn = on;
    this.applyLevels(on ? 1.5 : 0.8);
    if (on) this.startScheduler();
  }

  play(sound: UiSound): void {
    const ctx = this.ctx;
    const bus = this.sfxBus;
    if (!ctx || !bus || ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    switch (sound) {
      case 'move':
        this.blip(t, 1320, 1320, 0.035, 0.07, 'sine');
        break;
      case 'select':
        this.blip(t, 880, 1760, 0.09, 0.12, 'triangle');
        this.hiss(t, 0.05, 6000, 0.05);
        break;
      case 'back':
        this.blip(t, 740, 440, 0.09, 0.1, 'triangle');
        break;
      case 'tab':
        this.hiss(t, 0.14, 2500, 0.08);
        break;
      case 'start':
        for (const note of [69, 73, 76, 81])
          this.blip(t, hz(note), hz(note), 0.5, 0.06, 'sawtooth');
        this.hiss(t, 0.3, 4000, 0.06);
        break;
    }
  }

  suspend(): void {
    if (this.ctx?.state === 'running') void this.ctx.suspend().catch(() => undefined);
  }

  resume(): void {
    if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => undefined);
  }

  // ---------------------------------------------------------------- set-up

  private build(ctx: AudioContext): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = 0;
    this.sfxBus = ctx.createGain();
    // A soft compressor keeps the loop from clipping when all the voices play at once.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    this.musicBus.connect(comp).connect(this.master);
    this.sfxBus.connect(this.master);
    // Echo for the arpeggio: a dotted-eighth delay.
    this.delay = ctx.createDelay(1);
    this.delay.delayTime.value = STEP * 3;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.delay.connect(feedback).connect(this.delay);
    this.delay.connect(wet).connect(this.musicBus);
    const length = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.applyLevels(0);
  }

  private applyLevels(fade: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus || !this.sfxBus) return;
    const now = ctx.currentTime;
    const music = this.muted || !this.musicOn ? 0 : this.musicLevel * 0.45;
    this.musicBus.gain.cancelScheduledValues(now);
    this.musicBus.gain.setTargetAtTime(music, now, Math.max(fade, 0.01) / 3);
    this.sfxBus.gain.setTargetAtTime(this.muted ? 0 : this.sfxLevel * 0.8, now, 0.02);
  }

  private startScheduler(): void {
    const ctx = this.ctx;
    if (!ctx || this.timer) return;
    this.nextTime = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  /** Queues the notes that fall within the lookahead window; stops once the music has faded. */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.musicOn && ctx.currentTime > this.nextTime + 1) {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      return;
    }
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(this.step, this.nextTime);
      this.step = (this.step + 1) % (BARS * 16);
      this.nextTime += STEP;
    }
  }

  // ---------------------------------------------------------------- the music

  private playStep(step: number, t: number): void {
    const bar = Math.floor(step / 16);
    const inBar = step % 16;
    const chord = CHORDS[bar % CHORDS.length]!;
    const full = bar >= 4;
    if (inBar === 0) this.pad(t, chord, BEAT * 4);
    if (full) {
      // Bass: eighth notes on the root, an octave jump on the off-beat of beat 4.
      if (inBar % 2 === 0) {
        const up = inBar === 14 ? 12 : 0;
        this.bass(t, hz(chord[0] - 24 + up), STEP * 1.8);
      }
      if (inBar === 0 || inBar === 8) this.kick(t);
      if (inBar === 4 || inBar === 12) this.clap(t);
      if (inBar % 2 === 0) this.hat(t, inBar % 4 === 2 ? 0.05 : 0.03);
    } else if (inBar === 0 || inBar === 8) {
      this.hat(t, 0.02);
    }
    if (bar >= 8) {
      // Arpeggio: the chord tones rising through two octaves.
      const order = [0, 1, 2, 1, 2, 0, 1, 2];
      const note = chord[order[inBar % order.length]!]! + (inBar >= 8 ? 24 : 12);
      this.arp(t, hz(note), STEP * 0.9);
    }
  }

  private voice(type: OscillatorType, freq: number, t: number, length: number): OscillatorNode {
    const osc = this.ctx!.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    osc.start(t);
    osc.stop(t + length + 0.05);
    return osc;
  }

  private envelope(t: number, attack: number, hold: number, release: number, level: number) {
    const g = this.ctx!.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.setValueAtTime(level, t + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
    return g;
  }

  private pad(t: number, chord: readonly number[], length: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(700, t);
    filter.frequency.linearRampToValueAtTime(1600, t + length * 0.6);
    filter.frequency.linearRampToValueAtTime(900, t + length);
    const env = this.envelope(t, 0.5, length - 0.7, 1.2, 0.05);
    filter.connect(env).connect(this.musicBus!);
    for (const note of chord) {
      for (const detune of [-7, 7]) {
        const osc = this.voice('sawtooth', hz(note), t, length + 1.2);
        osc.detune.value = detune;
        osc.connect(filter);
      }
    }
  }

  private bass(t: number, freq: number, length: number): void {
    const ctx = this.ctx!;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 4;
    const env = this.envelope(t, 0.005, length * 0.5, length * 0.5, 0.16);
    filter.connect(env).connect(this.musicBus!);
    this.voice('sawtooth', freq, t, length).connect(filter);
  }

  private arp(t: number, freq: number, length: number): void {
    const env = this.envelope(t, 0.004, 0.02, length, 0.045);
    env.connect(this.musicBus!);
    env.connect(this.delay!);
    this.voice('square', freq, t, length).connect(env);
  }

  private kick(t: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.18);
    const env = this.envelope(t, 0.002, 0.02, 0.28, 0.5);
    osc.connect(env).connect(this.musicBus!);
    osc.start(t);
    osc.stop(t + 0.35);
  }

  private clap(t: number): void {
    this.noiseHit(t, 'bandpass', 1800, 0.16, 0.12, this.musicBus!);
  }

  private hat(t: number, level: number): void {
    this.noiseHit(t, 'highpass', 8000, 0.045, level, this.musicBus!);
  }

  private noiseHit(
    t: number,
    type: BiquadFilterType,
    freq: number,
    length: number,
    level: number,
    out: AudioNode,
  ): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    const env = this.envelope(t, 0.001, 0.005, length, level);
    src.connect(filter).connect(env).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + length + 0.05);
  }

  // ---------------------------------------------------------------- interface sounds

  private blip(
    t: number,
    from: number,
    to: number,
    length: number,
    level: number,
    type: OscillatorType,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length * 0.7);
    const env = this.envelope(t, 0.003, length * 0.3, length * 0.7, level);
    osc.connect(env).connect(this.sfxBus!);
    osc.start(t);
    osc.stop(t + length + 0.05);
  }

  private hiss(t: number, length: number, freq: number, level: number): void {
    this.noiseHit(t, 'bandpass', freq, length, level, this.sfxBus!);
  }
}
