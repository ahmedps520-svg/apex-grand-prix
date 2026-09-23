import type { Standing } from '../app/Festival';
import { el } from './dom';

/** Free roam: the results of a street race, up for a few seconds after the flag. */
export class RaceCard {
  readonly root = el('div', 'race-card');
  private readonly title = el('div', 'race-card-title', 'RACE RESULTS');
  private readonly name = el('div', 'race-card-name');
  private readonly sub = el('div', 'race-card-sub');
  private readonly rows = el('div', 'race-card-rows');
  private timer: ReturnType<typeof setTimeout> | null = null;
  private visible = true;
  private shown = false;

  constructor(parent: HTMLElement) {
    this.root.append(this.title, this.name, this.sub, this.rows);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  show(name: string, summary: string, standings: readonly Standing[], seconds = 9): void {
    this.name.textContent = name;
    this.sub.textContent = summary;
    this.rows.replaceChildren();
    for (const s of standings) {
      const row = el('div', `race-card-row${s.you ? ' you' : ''}`);
      row.append(
        el('span', 'race-card-pos', `P${s.position}`),
        el('span', 'race-card-driver', s.name),
        el('span', 'race-card-gap', s.gap),
      );
      this.rows.appendChild(row);
    }
    this.shown = true;
    this.root.hidden = !this.visible;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.hide(), seconds * 1000);
  }

  hide(): void {
    this.shown = false;
    this.root.hidden = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !(visible && this.shown);
  }
}
