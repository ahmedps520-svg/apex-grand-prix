/**
 * Rebindable controls: which controller button or keyboard keys trigger each action. The
 * sticks, triggers and D-pad keep fixed roles (steering, pedals, quick menu); everything else
 * can be moved. Pure data and functions, so saving and loading can be unit tested.
 */

export type PadAction =
  'shiftUp' | 'shiftDown' | 'handbrake' | 'camera' | 'reset' | 'telemetry' | 'overlay' | 'pause';

export type KeyAction =
  | 'throttle'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'handbrake'
  | 'shiftUp'
  | 'shiftDown'
  | 'camera'
  | 'reset'
  | 'telemetry'
  | 'overlay'
  | 'pause';

export interface Bindings {
  /** Standard-mapping button index for each controller action. */
  pad: Record<PadAction, number>;
  /** KeyboardEvent.code values for each keyboard action (first = primary). */
  keys: Record<KeyAction, string[]>;
}

export const PAD_ACTIONS: ReadonlyArray<{ action: PadAction; label: string }> = [
  { action: 'shiftUp', label: 'Shift up' },
  { action: 'shiftDown', label: 'Shift down' },
  { action: 'handbrake', label: 'Handbrake' },
  { action: 'camera', label: 'Change camera' },
  { action: 'reset', label: 'Reset car' },
  { action: 'telemetry', label: 'Telemetry panel' },
  { action: 'overlay', label: 'Performance overlay' },
  { action: 'pause', label: 'Pause' },
];

export const KEY_ACTIONS: ReadonlyArray<{ action: KeyAction; label: string }> = [
  { action: 'throttle', label: 'Throttle' },
  { action: 'brake', label: 'Brake / reverse' },
  { action: 'steerLeft', label: 'Steer left' },
  { action: 'steerRight', label: 'Steer right' },
  { action: 'handbrake', label: 'Handbrake' },
  { action: 'shiftUp', label: 'Shift up' },
  { action: 'shiftDown', label: 'Shift down' },
  { action: 'camera', label: 'Change camera' },
  { action: 'reset', label: 'Reset car' },
  { action: 'telemetry', label: 'Telemetry panel' },
  { action: 'overlay', label: 'Performance overlay' },
  { action: 'pause', label: 'Pause' },
];

export const defaultBindings = (): Bindings => ({
  pad: {
    shiftUp: 5, // R1 / RB
    shiftDown: 4, // L1 / LB
    handbrake: 0, // ✕ / A
    camera: 1, // ○ / B
    reset: 3, // △ / Y
    telemetry: 17, // touchpad click (L3 + R3 also works)
    overlay: 8, // Create / View
    pause: 9, // Options / Menu
  },
  keys: {
    throttle: ['KeyW', 'ArrowUp'],
    brake: ['KeyS', 'ArrowDown'],
    steerLeft: ['KeyA', 'ArrowLeft'],
    steerRight: ['KeyD', 'ArrowRight'],
    handbrake: ['Space'],
    shiftUp: ['KeyE'],
    shiftDown: ['KeyQ'],
    camera: ['KeyC'],
    reset: ['KeyR'],
    telemetry: ['F3'],
    overlay: ['Backquote'],
    pause: ['Escape', 'KeyP'],
  },
});

/** Buttons the menus rely on (confirm, back); binding them elsewhere is allowed but warned. */
export const MENU_BUTTONS = new Set([0, 1]);

/** Assigns `button` to `action`; an action that had that button gets this action's old one. */
export function rebindPad(bindings: Bindings, action: PadAction, button: number): Bindings {
  const pad = { ...bindings.pad };
  const previous = pad[action];
  for (const { action: other } of PAD_ACTIONS) {
    if (other !== action && pad[other] === button) pad[other] = previous;
  }
  pad[action] = button;
  return { ...bindings, pad };
}

/** Makes `code` the primary key for `action` and takes it away from any other action. */
export function rebindKey(bindings: Bindings, action: KeyAction, code: string): Bindings {
  const keys = { ...bindings.keys };
  for (const { action: other } of KEY_ACTIONS) {
    if (other !== action) keys[other] = keys[other].filter((k) => k !== code);
  }
  keys[action] = [code, ...keys[action].filter((k) => k !== code).slice(1)];
  return { ...bindings, keys };
}

/** Repairs stored bindings: unknown actions dropped, missing or invalid ones reset. */
export function sanitizeBindings(raw: unknown): Bindings {
  const d = defaultBindings();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as { pad?: Record<string, unknown>; keys?: Record<string, unknown> };
  const pad = { ...d.pad };
  for (const { action } of PAD_ACTIONS) {
    const v = r.pad?.[action];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 32) pad[action] = v;
  }
  const keys = { ...d.keys };
  for (const { action } of KEY_ACTIONS) {
    const v = r.keys?.[action];
    if (Array.isArray(v)) {
      const codes = v.filter((k): k is string => typeof k === 'string' && k.length < 32);
      keys[action] = codes.slice(0, 3);
    }
  }
  return { pad, keys };
}

const PS_BUTTONS = [
  '✕',
  '○',
  '□',
  '△',
  'L1',
  'R1',
  'L2',
  'R2',
  'Create',
  'Options',
  'L3',
  'R3',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
  'PS',
  'Touchpad',
];
const XBOX_BUTTONS = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'View',
  'Menu',
  'LS',
  'RS',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
  'Guide',
  'Share',
];

/** How to show a standard-mapping button to the player. */
export function padButtonName(index: number, family: 'playstation' | 'xbox' | 'generic'): string {
  const names = family === 'playstation' ? PS_BUTTONS : XBOX_BUTTONS;
  return names[index] ?? `Button ${index}`;
}

const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  Backquote: '`',
  Enter: 'Enter',
  ShiftLeft: 'Left Shift',
  ShiftRight: 'Right Shift',
  ControlLeft: 'Left Ctrl',
  ControlRight: 'Right Ctrl',
  AltLeft: 'Left Alt',
  AltRight: 'Right Alt',
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
};

/** How to show a key (KeyboardEvent.code) to the player. */
export function keyName(code: string): string {
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  return code;
}
