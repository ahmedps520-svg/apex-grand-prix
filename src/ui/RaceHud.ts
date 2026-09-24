import type { RaceStatus } from '../sim/race/RaceDirector';
import { el, setText } from './dom';
import './raceHud.css';

/** Formats seconds as m:ss.mmm (or — when there's no time yet). */
export function lapTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—:—.———';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function delta(seconds: number): string {
  const sign = seconds < 0 ? '−' : '+';
  return `${sign}${Math.abs(seconds).toFixed(3)}`;
}

/**
 * Race and time-trial overlay: position and lap, timing with sector splits, the start lights
 * countdown and the finish banner. Updated every frame; text changes only when it has to.
 */
export class RaceHud {
  readonly root = el('div', 'race-hud');
  private readonly position = el('div', 'rh-position');
  private readonly positionTotal = el('span', 'rh-total');
  private readonly lap = el('div', 'rh-lap');
  private readonly current = el('div', 'rh-current');
  private readonly last = el('div', 'rh-line');
  private readonly best = el('div', 'rh-line');
  private readonly record = el('div', 'rh-line');
  private readonly split = el('div', 'rh-split');
  private readonly lights = el('div', 'rh-lights');
  private readonly lightEls: HTMLElement[] = [];
  private readonly banner = el('div', 'rh-banner');
  /** Elimination race: the clock to the next car out, red when it would be the player. */
  private readonly elimination = el('div', 'rh-elimination');
  private eliminationShown = '';
  private readonly wrongWay = el('div', 'rh-wrong', 'WRONG WAY');
  private shownSector = -1;
  private splitTimer = 0;
  private bannerTimer = 0;
  private lastPhase = '';
  private goTimer = 0;

  constructor(parent: HTMLElement) {
    const left = el('div', 'rh-left');
    const pos = el('div', 'rh-pos-block');
    pos.append(this.position, this.positionTotal);
    left.append(pos, this.lap, this.elimination);
    this.elimination.hidden = true;
    const times = el('div', 'rh-times');
    times.append(this.current, this.last, this.best, this.record, this.split);
    for (let i = 0; i < 5; i++) {
      const light = el('span');
      this.lights.appendChild(light);
      this.lightEls.push(light);
    }
    this.root.append(left, times, this.lights, this.banner, this.wrongWay);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  /** Elimination race: OUT IN n, and LAST when the player is the one on the way out. */
  private updateElimination(race: RaceStatus, player: number): void {
    const elim = race.elimination;
    const me = race.cars[player];
    const on = !!elim && race.phase === 'racing' && !!me && !me.finished;
    let text = '';
    let last = false;
    if (on && elim && me) {
      const running = race.order.filter((i) => !race.cars[i]!.finished);
      last = running.length > 1 && running[running.length - 1] === player;
      text = `${last ? 'LAST · ' : ''}OUT IN ${Math.max(0, Math.ceil(elim.next))}`;
    }
    const key = `${text}:${last}`;
    if (key === this.eliminationShown) return;
    this.eliminationShown = key;
    this.elimination.hidden = text === '';
    setText(this.elimination, text);
    this.elimination.classList.toggle('last', last);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  /** Big centred message that fades after a few seconds (e.g. "FINISH"). */
  flash(text: string, seconds = 3): void {
    setText(this.banner, text);
    this.banner.classList.remove('show');
    // Restart the animation.
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
    this.bannerTimer = seconds;
  }

  update(
    dt: number,
    race: RaceStatus,
    player: number,
    record: number | null,
    wrongWay: boolean,
  ): void {
    const me = race.cars[player];
    if (!me) return;
    const racing = race.mode === 'race';
    this.root.classList.toggle('time-trial', !racing);

    setText(this.position, racing ? `P${me.position}` : '');
    setText(this.positionTotal, racing ? `/${race.cars.length}` : '');
    const lapText = racing
      ? `${race.qualifying ? 'QUALIFYING · ' : ''}LAP ${Math.min(Math.max(me.lap + 1, 1), race.laps)}/${race.laps}`
      : `LAP ${Math.max(me.lap + 1, 1)}`;
    setText(this.lap, me.finished ? 'FINISHED' : lapText);
    this.updateElimination(race, player);
    setText(this.current, lapTime(me.currentLap));
    setText(this.last, `Last ${lapTime(me.lastLap)}`);
    setText(this.best, `Best ${lapTime(me.bestLap)}`);
    this.record.hidden = racing;
    if (!racing) setText(this.record, `Record ${lapTime(record ?? 0)}`);

    // Sector split against the best sector: shown for a few seconds after each sector.
    if (me.sector !== this.shownSector && race.phase === 'racing') {
      const done = (me.sector + 2) % 3; // the sector just completed
      const time = me.sectorTimes[done] ?? 0;
      const bestSector = me.bestSectors[done] ?? 0;
      if (this.shownSector >= 0 && time > 0 && bestSector > 0) {
        const d = time - bestSector;
        setText(this.split, `S${done + 1} ${delta(d)}`);
        this.split.className = d <= 0.0005 ? 'rh-split best' : 'rh-split slower';
        this.splitTimer = 3;
      }
      this.shownSector = me.sector;
    }
    this.splitTimer -= dt;
    this.split.hidden = this.splitTimer <= 0;

    // Start lights: red one by one, then all out (shown green briefly) at the start.
    const counting = race.phase === 'grid' || race.phase === 'countdown';
    if (race.go && this.lastPhase !== 'racing' && race.phase === 'racing') this.goTimer = 1.4;
    this.goTimer -= dt;
    const showLights = counting || this.goTimer > 0;
    this.lights.hidden = !showLights;
    this.lightEls.forEach((l, i) => {
      l.className = this.goTimer > 0 ? 'go' : i < race.lights ? 'on' : '';
    });
    if (race.phase === 'racing' && this.lastPhase && this.lastPhase !== 'racing' && racing) {
      this.flash('GO!', 1.2);
    }
    if (me.finished && this.lastPhase !== 'finished-shown') {
      this.flash(
        racing
          ? race.qualifying
            ? `P${me.position} ON THE GRID`
            : `FINISH · P${me.position}`
          : 'SESSION OVER',
        4,
      );
      this.lastPhase = 'finished-shown';
    } else if (this.lastPhase !== 'finished-shown') {
      this.lastPhase = race.phase;
    }

    this.bannerTimer -= dt;
    if (this.bannerTimer <= 0) this.banner.classList.remove('show');
    this.wrongWay.classList.toggle('show', wrongWay && race.phase === 'racing');
  }

  reset(): void {
    this.shownSector = -1;
    this.splitTimer = 0;
    this.bannerTimer = 0;
    this.goTimer = 0;
    this.lastPhase = '';
    this.banner.classList.remove('show');
  }
}
