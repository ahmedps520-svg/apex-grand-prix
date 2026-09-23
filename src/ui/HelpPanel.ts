import type { PadFamily } from '../input/InputManager';
import { VERSION_TEXT } from '../app/version';
import { el } from './dom';

interface Row {
  action: string;
  keys: string;
  pad: Record<PadFamily, string>;
}

const same = (label: string): Record<PadFamily, string> => ({
  playstation: label,
  xbox: label,
  generic: label,
});

const ROWS: Row[] = [
  { action: 'Throttle', keys: 'W / ↑', pad: { playstation: 'R2', xbox: 'RT', generic: 'RT' } },
  {
    action: 'Brake (reverse in auto)',
    keys: 'S / ↓',
    pad: { playstation: 'L2', xbox: 'LT', generic: 'LT' },
  },
  { action: 'Steer', keys: 'A D / ← →', pad: same('Left stick') },
  {
    action: 'Shift up / down',
    keys: 'E / Q',
    pad: { playstation: 'R1 / L1', xbox: 'RB / LB', generic: 'RB / LB' },
  },
  { action: 'Handbrake', keys: 'Space', pad: { playstation: '✕', xbox: 'A', generic: 'A' } },
  { action: 'Camera', keys: 'C', pad: { playstation: '○', xbox: 'B', generic: 'B' } },
  { action: 'Reset car', keys: 'R', pad: { playstation: '△', xbox: 'Y', generic: 'Y' } },
  {
    action: 'Quick menu (aids, gears, curves…)',
    keys: 'Tab, then [ ]',
    pad: same('D-pad'),
  },
  {
    action: 'Telemetry',
    keys: 'F3',
    pad: { playstation: 'Touchpad / L3+R3', xbox: 'L3+R3', generic: 'L3+R3' },
  },
  { action: 'Loop / drag strip / skidpad', keys: '1 / 2 / 3', pad: same('Quick menu') },
  { action: 'Steering wheel setup', keys: 'K', pad: same('—') },
  {
    action: 'Performance overlay',
    keys: '`',
    pad: { playstation: 'Create', xbox: 'View', generic: 'Select' },
  },
  { action: 'Sound on / off · km/h ↔ mph', keys: 'M · U', pad: same('Quick menu · —') },
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
    card.appendChild(el('p', 'help-sub', `GT car on the proving ground · ${VERSION_TEXT}`));
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
