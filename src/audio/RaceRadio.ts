/**
 * The race engineer: short radio calls about the race (start, positions, lap times, gaps, the
 * last lap, the finish), spoken with the browser's speech synthesis and shown as subtitles.
 * `RaceEngineer` decides what to say from the race state; `RadioVoice` says it.
 */

import type { GameMode } from '../shared/protocol';

/** What the engineer knows about the player's race, every frame. */
export interface RadioInput {
  mode: GameMode;
  phase: 'grid' | 'countdown' | 'racing' | 'finished';
  /** Laps completed by the player. */
  lapsDone: number;
  /** Race length in laps (0 = no limit, e.g. time trial). */
  laps: number;
  /** 1-based. */
  position: number;
  cars: number;
  /** Player's last and best lap this session, seconds (0 = none yet). */
  lastLap: number;
  bestLap: number;
  /** Best lap of anyone else in the session (0 = none). */
  rivalBest: number;
  /** Seconds to the car ahead / behind, or null when there is none (or it's unknown). */
  gapAhead: number | null;
  gapBehind: number | null;
  finished: boolean;
  /** Player's damage, 0 … 1 (steering signed: + = pulls right). */
  damageAero: number;
  damageEngine: number;
  damageSteer: number;
}

export interface RadioMessage {
  text: string;
  /** Higher interrupts lower; equal waits its turn. */
  priority: number;
}

/** Seconds a position has to hold before the engineer mentions it. */
const POSITION_SETTLE = 2.5;
/** Minimum gap between two low-priority calls. */
const CHATTER_GAP = 8;

/** Lap time as said out loud: "one thirty-two point four". */
export function spokenTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  const whole = Math.floor(s);
  const tenth = Math.floor((s - whole) * 10);
  const secs = whole < 10 ? `oh ${whole}` : String(whole);
  return m > 0 ? `${m} ${secs} point ${tenth}` : `${whole} point ${tenth}`;
}

const ordinal = (p: number): string => `P${p}`;

/** Decides what to say. Pure logic, so it can be tested without speech. */
export class RaceEngineer {
  private lastPhase: RadioInput['phase'] | null = null;
  private lapsDone = 0;
  private position = 0;
  private positionSince = 0;
  private announcedPosition = 0;
  private bestLap = 0;
  private time = 0;
  private lastChatter = -Infinity;
  private finishedSaid = false;
  private finalLapSaid = false;
  /** Damage already reported (so each part is mentioned once). */
  private aeroSaid = false;
  private engineSaid = false;
  private steerSaid = false;

  reset(): void {
    this.lastPhase = null;
    this.lapsDone = 0;
    this.position = 0;
    this.positionSince = 0;
    this.announcedPosition = 0;
    this.bestLap = 0;
    this.time = 0;
    this.lastChatter = -Infinity;
    this.finishedSaid = false;
    this.finalLapSaid = false;
    this.aeroSaid = false;
    this.engineSaid = false;
    this.steerSaid = false;
  }

  update(dt: number, r: RadioInput): RadioMessage[] {
    this.time += dt;
    const out: RadioMessage[] = [];
    const race = r.mode === 'race';
    const phaseChanged = r.phase !== this.lastPhase;
    const first = this.lastPhase === null;
    this.lastPhase = r.phase;

    if (phaseChanged && !first) {
      if (r.phase === 'racing' && race) {
        out.push({ text: 'Lights out. Good luck out there.', priority: 2 });
        this.announcedPosition = r.position;
      }
    }
    if (first) {
      if (race && r.phase !== 'racing') {
        out.push({
          text: `Radio check. You start ${ordinal(r.position)} of ${r.cars}. ${r.laps} ${r.laps === 1 ? 'lap' : 'laps'} today.`,
          priority: 1,
        });
      } else if (r.mode === 'timeTrial') {
        out.push({ text: 'Track is clear. Push when ready.', priority: 1 });
      }
      this.announcedPosition = r.position;
      this.position = r.position;
      this.lapsDone = r.lapsDone;
      this.bestLap = r.bestLap;
      return out;
    }

    // Finish.
    if (r.finished && !this.finishedSaid && race) {
      this.finishedSaid = true;
      const p = r.position;
      const text =
        p === 1
          ? 'Chequered flag! You won it! Fantastic drive.'
          : p <= 3
            ? `Chequered flag. ${ordinal(p)}, that's a podium. Great job.`
            : p <= 10
              ? `Chequered flag. ${ordinal(p)}. Points on the board.`
              : `Chequered flag. ${ordinal(p)}. We'll go again.`;
      out.push({ text, priority: 3 });
      this.lapsDone = r.lapsDone;
      return out;
    }

    // Lap completed.
    if (r.lapsDone > this.lapsDone) {
      this.lapsDone = r.lapsDone;
      const improved = r.bestLap > 0 && (this.bestLap === 0 || r.bestLap < this.bestLap - 1e-3);
      const fastest = improved && (r.rivalBest === 0 || r.bestLap < r.rivalBest);
      this.bestLap = r.bestLap;
      const parts: string[] = [];
      if (race && r.laps > 0 && r.lapsDone === r.laps - 1 && !this.finalLapSaid) {
        this.finalLapSaid = true;
        parts.push('Final lap. Bring it home.');
      }
      if (r.lastLap > 0 && r.lapsDone >= 1) {
        if (fastest && race) parts.push(`Fastest lap of the race, ${spokenTime(r.lastLap)}.`);
        else if (improved) parts.push(`Personal best, ${spokenTime(r.lastLap)}.`);
        else if (race && this.time - this.lastChatter > CHATTER_GAP) {
          parts.push(`Last lap ${spokenTime(r.lastLap)}.`);
        } else if (!race) parts.push(`${spokenTime(r.lastLap)}.`);
      }
      if (race && !this.finalLapSaid && r.gapAhead !== null && r.position > 1) {
        if (r.gapAhead < 1) parts.push(`Car ahead is within a second. Go get him.`);
        else if (r.gapAhead < 4) parts.push(`Gap ahead ${r.gapAhead.toFixed(1)}.`);
      } else if (race && r.position === 1 && r.gapBehind !== null && r.gapBehind < 1) {
        parts.push('Car behind is close. Defend.');
      }
      if (parts.length > 0) {
        out.push({ text: parts.join(' '), priority: 2 });
        this.lastChatter = this.time;
      }
    }

    // Damage, once per part, after the car has settled from the hit.
    if (r.phase === 'racing' && !r.finished) {
      if (!this.aeroSaid && r.damageAero > 0.25) {
        this.aeroSaid = true;
        out.push({
          text: 'We have aero damage. Expect less grip in the fast corners.',
          priority: 2,
        });
      } else if (!this.steerSaid && Math.abs(r.damageSteer) > 0.25) {
        this.steerSaid = true;
        const side = r.damageSteer > 0 ? 'right' : 'left';
        out.push({ text: `Steering is bent, the car will pull to the ${side}.`, priority: 2 });
      } else if (!this.engineSaid && r.damageEngine > 0.25) {
        this.engineSaid = true;
        out.push({ text: 'Engine damage. We are down on power.', priority: 2 });
      }
    }

    // Position changes, once they've settled.
    if (race && r.phase === 'racing' && !r.finished) {
      if (r.position !== this.position) {
        this.position = r.position;
        this.positionSince = this.time;
      } else if (
        r.position !== this.announcedPosition &&
        this.time - this.positionSince > POSITION_SETTLE &&
        this.time - this.lastChatter > 3
      ) {
        const gained = r.position < this.announcedPosition;
        this.announcedPosition = r.position;
        this.lastChatter = this.time;
        const text =
          r.position === 1
            ? 'You are leading the race! Keep it tidy.'
            : gained
              ? `Nice move. ${ordinal(r.position)}.`
              : `Lost a place. ${ordinal(r.position)}. Stay calm, you'll get it back.`;
        out.push({ text, priority: 1 });
      }
    }
    return out;
  }
}

/** Speaks radio messages (where the browser can) and reports them for subtitles. */
export class RadioVoice {
  enabled = true;
  volume = 1;
  onMessage: ((text: string) => void) | null = null;
  private voice: SpeechSynthesisVoice | null = null;
  private speakingPriority = 0;

  constructor() {
    if (!RadioVoice.supported()) return;
    const pick = () => {
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
      const preferred = ['Daniel', 'Google UK English Male', 'Arthur', 'Oliver', 'Alex', 'David'];
      this.voice =
        preferred.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean) ??
        voices.find((v) => v.lang === 'en-GB') ??
        voices[0] ??
        null;
    };
    pick();
    speechSynthesis.addEventListener?.('voiceschanged', pick);
  }

  static supported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  say(message: RadioMessage): void {
    this.onMessage?.(message.text);
    if (!this.enabled || this.volume <= 0 || !RadioVoice.supported()) return;
    if (speechSynthesis.speaking) {
      if (message.priority <= this.speakingPriority) {
        // Queue behind the current call rather than cutting it off.
        this.speak(message);
        return;
      }
      speechSynthesis.cancel();
    }
    this.speak(message);
  }

  stop(): void {
    if (RadioVoice.supported()) speechSynthesis.cancel();
  }

  private speak(message: RadioMessage): void {
    const u = new SpeechSynthesisUtterance(message.text);
    if (this.voice) u.voice = this.voice;
    u.lang = this.voice?.lang ?? 'en-GB';
    u.rate = 1.12;
    u.pitch = 0.92;
    u.volume = this.volume;
    this.speakingPriority = message.priority;
    u.onend = () => (this.speakingPriority = 0);
    speechSynthesis.speak(u);
  }
}
