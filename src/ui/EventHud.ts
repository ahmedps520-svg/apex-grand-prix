import type { FestivalView, Standing } from '../app/Festival';
import type { EventKind } from '../content/city/events';
import { el, setText } from './dom';

const KIND_LABEL: Record<EventKind, string> = {
  race: 'RACE',
  drift: 'DRIFT ZONE',
  camera: 'SPEED TRAP',
  jump: 'JUMP',
};

/** Free roam: the festival event under way (time, points, distance) or the nearest one to go for. */
export class EventHud {
  readonly root = el('div', 'fest');
  private readonly kind = el('div', 'fest-kind');
  private readonly name = el('div', 'fest-name');
  private readonly line = el('div', 'fest-line');
  private readonly detail = el('div', 'fest-detail');
  private readonly standings = el('div', 'fest-standings');
  private shown = '';
  private shownRows = '';
  private visible = true;
  private active = false;

  constructor(parent: HTMLElement) {
    this.root.append(this.kind, this.name, this.line, this.detail, this.standings);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !(visible && this.active);
  }

  reset(): void {
    this.shown = '';
    this.shownRows = '';
    this.standings.replaceChildren();
    this.active = false;
    this.root.hidden = true;
  }

  update(view: FestivalView): void {
    const a = view.active;
    const h = view.hint;
    const key = a
      ? `a:${a.kind}:${a.name}:${a.line}:${a.detail}:${a.countdown ? 1 : 0}`
      : h
        ? `h:${h.kind}:${h.name}:${Math.round(h.distance / 10)}`
        : '';
    this.updateStandings(a?.standings ?? []);
    if (key === this.shown) return;
    this.shown = key;
    this.active = key !== '';
    this.root.hidden = !(this.visible && this.active);
    if (!this.active) return;
    this.root.className = `fest ${a ? 'active' : 'hint'} ${a ? a.kind : h!.kind}${a?.countdown ? ' countdown' : ''}`;
    if (a) {
      setText(this.kind, KIND_LABEL[a.kind]);
      setText(this.name, a.name);
      setText(this.line, a.line);
      setText(this.detail, a.detail);
    } else if (h) {
      setText(this.kind, KIND_LABEL[h.kind]);
      setText(this.name, h.name);
      setText(this.line, `${Math.round(h.distance)} m`);
      setText(this.detail, 'ahead');
    }
  }

  /** The race's field, a row each, rebuilt only when something in it changed. */
  private updateStandings(rows: ReadonlyArray<Standing>): void {
    const key = rows.map((r) => `${r.position}|${r.name}|${r.you ? 1 : 0}|${r.gap}`).join(';');
    if (key === this.shownRows) return;
    this.shownRows = key;
    this.standings.replaceChildren();
    this.standings.hidden = rows.length === 0;
    for (const r of rows) {
      const row = el('div', `fest-row${r.you ? ' you' : ''}`);
      row.append(
        el('span', 'fest-pos', `P${r.position}`),
        el('span', 'fest-driver', r.name),
        el('span', 'fest-gap', r.gap),
      );
      this.standings.appendChild(row);
    }
  }
}
