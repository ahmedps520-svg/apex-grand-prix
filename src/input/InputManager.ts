import { neutralInput, type DriverInput } from '../shared/protocol';

/** One-shot actions (edge-triggered) besides driving. */
export type Action = 'reset' | 'camera' | 'overlay' | 'help' | 'scaleUp' | 'scaleDown' | 'units';

export type DeviceKind = 'keyboard' | 'gamepad' | 'none';
export type PadFamily = 'playstation' | 'xbox' | 'generic';

const STICK_DEADZONE = 0.08;
const TRIGGER_DEADZONE = 0.03;
/** > 1 gives finer control around the centre of the stick. */
const STEER_EXPONENT = 1.3;

// Standard Gamepad mapping indices (https://w3c.github.io/gamepad/#remapping).
const PAD = {
  SOUTH: 0, // Cross / A
  EAST: 1, // Circle / B
  NORTH: 3, // Triangle / Y
  L2: 6,
  R2: 7,
  SELECT: 8, // Create / Share / View
  START: 9, // Options / Menu
  DPAD_UP: 12,
  DPAD_DOWN: 13,
} as const;

const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'reset',
  KeyC: 'camera',
  F3: 'overlay',
  Backquote: 'overlay',
  KeyH: 'help',
  BracketRight: 'scaleUp',
  BracketLeft: 'scaleDown',
  KeyU: 'units',
};

const PAD_ACTIONS: Array<[number, Action]> = [
  [PAD.NORTH, 'reset'],
  [PAD.EAST, 'camera'],
  [PAD.SELECT, 'overlay'],
  [PAD.START, 'help'],
  [PAD.DPAD_UP, 'scaleUp'],
  [PAD.DPAD_DOWN, 'scaleDown'],
];

/** Keys the game uses, so the browser doesn't also scroll or click with them. */
const CAPTURED_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'F3',
  ...Object.keys(KEY_ACTIONS),
]);

/**
 * Samples keyboard and gamepads once per frame on the main thread (the Gamepad API isn't
 * available in workers) and produces the driver input sent to the simulation.
 */
export class InputManager {
  readonly driver: DriverInput = neutralInput();
  readonly actions = new Set<Action>();
  lastDevice: DeviceKind = 'none';
  padName = '';
  padFamily: PadFamily = 'generic';
  padConnected = false;

  private readonly keys = new Set<string>();
  private readonly pendingKeyActions: Action[] = [];
  private readonly prevButtons = new Map<number, boolean[]>();
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];

  constructor() {
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    // Released keys aren't reported while the window is unfocused: forget them.
    this.listen(window, 'blur', () => this.keys.clear());
    this.listen(window, 'gamepadconnected', () => (this.padConnected = true));
  }

  /** Call once per frame before reading `driver` / `actions`. */
  update(): void {
    this.actions.clear();
    for (const a of this.pendingKeyActions) this.actions.add(a);
    this.pendingKeyActions.length = 0;

    const k = this.keys;
    const kbSteer =
      (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) -
      (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    const kbThrottle = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    const kbBrake = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    const kbHandbrake = k.has('Space') ? 1 : 0;

    let padSteer = 0;
    let padThrottle = 0;
    let padBrake = 0;
    let padHandbrake = 0;
    const pad = this.activePad();
    if (pad) {
      padSteer = shapeStick(pad.axes[0] ?? 0);
      padThrottle = shapeTrigger(pad.buttons[PAD.R2]?.value ?? 0);
      padBrake = shapeTrigger(pad.buttons[PAD.L2]?.value ?? 0);
      padHandbrake = pad.buttons[PAD.SOUTH]?.pressed ? 1 : 0;
      const prev = this.prevButtons.get(pad.index) ?? [];
      const now = pad.buttons.map((b) => b.pressed);
      for (const [button, action] of PAD_ACTIONS) {
        if (now[button] && !prev[button]) this.actions.add(action);
      }
      this.prevButtons.set(pad.index, now);
      if (padSteer !== 0 || padThrottle > 0 || padBrake > 0 || now.some(Boolean)) {
        this.lastDevice = 'gamepad';
      }
    }

    // The stick wins whenever it's outside its dead zone; otherwise the keys steer.
    const padSteering = padSteer !== 0;
    this.driver.steer = padSteering ? padSteer : kbSteer;
    this.driver.steerIsDigital = !padSteering && kbSteer !== 0;
    this.driver.throttle = Math.max(kbThrottle, padThrottle);
    this.driver.brake = Math.max(kbBrake, padBrake);
    this.driver.handbrake = Math.max(kbHandbrake, padHandbrake);
  }

  dispose(): void {
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
  }

  /** The most recently used connected gamepad (Gamepad API only reports after a button press). */
  private activePad(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let best: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      if (!best || pad.timestamp > best.timestamp) best = pad;
    }
    this.padConnected = best !== null;
    if (best) {
      this.padName = cleanPadName(best.id);
      this.padFamily = padFamily(best.id);
    }
    return best;
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    if (CAPTURED_KEYS.has(event.code)) event.preventDefault();
    if (down) {
      if (!event.repeat) {
        const action = KEY_ACTIONS[event.code];
        if (action) this.pendingKeyActions.push(action);
      }
      this.keys.add(event.code);
      this.lastDevice = 'keyboard';
    } else {
      this.keys.delete(event.code);
    }
  }

  private listen(target: EventTarget, type: string, fn: EventListener): void {
    target.addEventListener(type, fn);
    this.listeners.push([target, type, fn]);
  }
}

export function shapeStick(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude <= STICK_DEADZONE) return 0;
  const scaled = Math.min((magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1);
  return Math.sign(value) * Math.pow(scaled, STEER_EXPONENT);
}

export function shapeTrigger(value: number): number {
  if (value <= TRIGGER_DEADZONE) return 0;
  return Math.min((value - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE), 1);
}

export function padFamily(id: string): PadFamily {
  if (/054c|dualsense|dualshock|playstation|ps[345]/i.test(id)) return 'playstation';
  if (/045e|xbox|xinput/i.test(id)) return 'xbox';
  // Safari reports many PlayStation pads as "Wireless Controller".
  if (/^wireless controller/i.test(id)) return 'playstation';
  return 'generic';
}

export function cleanPadName(id: string): string {
  const name = id
    .replace(/\s*\(.*\)\s*$/, '')
    .replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '')
    .trim();
  return name || 'Gamepad';
}
