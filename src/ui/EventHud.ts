import type { FestivalView } from '../app/Festival';
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
  private shown = '';
  private visible = true;
  private active = false;

  constructor(parent: HTMLElement) {
    this.root.append(this.kind, this.name, this.line, this.detail);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !(visible && this.active);
  }

  reset(): void {
    this.shown = '';
    this.active = false;
    this.root.hidden = true;
  }

  update(view: FestivalView): void {
    const a = view.active;
    const h = view.hint;
    const key = a
      ? `a:${a.kind}:${a.name}:${a.line}:${a.detail}`
      : h
        ? `h:${h.kind}:${h.name}:${Math.round(h.distance / 10)}`
        : '';
    if (key === this.shown) return;
    this.shown = key;
    this.active = key !== '';
    this.root.hidden = !(this.visible && this.active);
    if (!this.active) return;
    this.root.className = `fest ${a ? 'active' : 'hint'} ${a ? a.kind : h!.kind}`;
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
}
