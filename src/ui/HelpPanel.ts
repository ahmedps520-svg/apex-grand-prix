import type { PadFamily } from '../input/InputManager';
import { el } from './dom';

interface Row {
  action: string;
  keys: string;
  pad: Record<PadFamily, string>;
}

const ROWS: Row[] = [
  { action: 'Throttle', keys: 'W / ↑', pad: { playstation: 'R2', xbox: 'RT', generic: 'RT' } },
  {
    action: 'Brake / reverse',
    keys: 'S / ↓',
    pad: { playstation: 'L2', xbox: 'LT', generic: 'LT' },
  },
  {
    action: 'Steer',
    keys: 'A D / ← →',
    pad: { playstation: 'Left stick', xbox: 'Left stick', generic: 'Left stick' },
  },
  { action: 'Handbrake', keys: 'Space', pad: { playstation: '✕', xbox: 'A', generic: 'A' } },
  { action: 'Camera', keys: 'C', pad: { playstation: '○', xbox: 'B', generic: 'B' } },
  { action: 'Reset car', keys: 'R', pad: { playstation: '△', xbox: 'Y', generic: 'Y' } },
  {
    action: 'Performance overlay',
    keys: 'F3 / `',
    pad: { playstation: 'Create', xbox: 'View', generic: 'Select' },
  },
  {
    action: 'Resolution scale',
    keys: '[ / ]',
    pad: { playstation: 'D-pad ↑ ↓', xbox: 'D-pad ↑ ↓', generic: 'D-pad ↑ ↓' },
  },
  { action: 'km/h ↔ mph', keys: 'U', pad: { playstation: '—', xbox: '—', generic: '—' } },
  {
    action: 'Show / hide this help',
    keys: 'H',
    pad: { playstation: 'Options', xbox: 'Menu', generic: 'Start' },
  },
];

/** Controls reference shown at start-up; hides once you start driving. */
export class HelpPanel {
  readonly root = el('div', 'help');
  private readonly padHeader = el('th', undefined, 'Controller');
  private readonly padCells: HTMLElement[] = [];
  private readonly hint = el('p', 'help-hint');
  private family: PadFamily | null = null;

  constructor(parent: HTMLElement) {
    const card = el('div', 'help-card');
    card.appendChild(el('h1', 'help-title', 'APEX GRAND PRIX'));
    card.appendChild(
      el('p', 'help-sub', 'Round 1 test build — drive the test car on the proving ground'),
    );
    const table = el('table', 'help-table');
    const head = el('tr');
    head.append(el('th', undefined, ''), el('th', undefined, 'Keyboard'), this.padHeader);
    table.appendChild(head);
    for (const row of ROWS) {
      const tr = el('tr');
      const padCell = el('td', 'pad', row.pad.generic);
      this.padCells.push(padCell);
      tr.append(el('td', 'action', row.action), el('td', 'keys', row.keys), padCell);
      table.appendChild(tr);
    }
    card.append(table, this.hint);
    this.root.appendChild(card);
    parent.appendChild(this.root);
    this.setPad(null, '');
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setPad(family: PadFamily | null, name: string): void {
    const shown = family ?? 'generic';
    if (family !== this.family) {
      this.family = family;
      ROWS.forEach((row, i) => (this.padCells[i]!.textContent = row.pad[shown]));
      this.padHeader.textContent =
        family === 'playstation' ? 'PlayStation' : family === 'xbox' ? 'Xbox' : 'Controller';
    }
    this.hint.textContent = family
      ? `Controller: ${name}. Press throttle or steer to start driving.`
      : 'Using a controller? Press any button on it so the browser can see it.';
  }
}
