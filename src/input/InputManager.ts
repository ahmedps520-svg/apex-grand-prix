import type { PadSettings } from '../app/settings';
import { neutralInput, type DriverInput } from '../shared/protocol';
import { shapePedal, shapeSteer } from './curves';
import {
  buttonDown,
  looksLikeWheel,
  readWheel,
  wheelReading,
  type WheelAction,
  type WheelProfile,
} from './wheel';

/** One-shot actions (edge-triggered) besides driving. */
export type Action =
  | 'reset'
  | 'camera'
  | 'overlay'
  | 'telemetry'
  | 'help'
  | 'units'
  | 'mute'
  | 'menuNext'
  | 'menuPrev'
  | 'menuUp'
  | 'menuDown'
  | 'teleportLoop'
  | 'teleportDrag'
  | 'teleportSkidpad'
  | 'wheelSetup';

export type DeviceKind = 'keyboard' | 'gamepad' | 'wheel' | 'none';
export type PadFamily = 'playstation' | 'xbox' | 'generic';

// Standard Gamepad mapping indices (https://w3c.github.io/gamepad/#remapping).
const PAD = {
  SOUTH: 0, // Cross / A
  EAST: 1, // Circle / B
  WEST: 2, // Square / X
  NORTH: 3, // Triangle / Y
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8, // Create / Share / View
  START: 9, // Options / Menu
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  /** DualSense / DualShock 4 touchpad click (Chrome exposes it after the standard buttons). */
  TOUCHPAD: 17,
} as const;

const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'reset',
  KeyC: 'camera',
  F3: 'telemetry',
  Backquote: 'overlay',
  KeyH: 'help',
  KeyU: 'units',
  KeyM: 'mute',
  BracketRight: 'menuUp',
  Equal: 'menuUp',
  BracketLeft: 'menuDown',
  Minus: 'menuDown',
  Digit1: 'teleportLoop',
  Digit2: 'teleportDrag',
  Digit3: 'teleportSkidpad',
  KeyK: 'wheelSetup',
};

const PAD_ACTIONS: Array<[number, Action]> = [
  [PAD.NORTH, 'reset'],
  [PAD.EAST, 'camera'],
  [PAD.SELECT, 'overlay'],
  [PAD.START, 'help'],
  [PAD.TOUCHPAD, 'telemetry'],
  [PAD.DPAD_UP, 'menuUp'],
  [PAD.DPAD_DOWN, 'menuDown'],
  [PAD.DPAD_LEFT, 'menuPrev'],
  [PAD.DPAD_RIGHT, 'menuNext'],
];

const WHEEL_BUTTON_ACTIONS: Array<[WheelAction, Action]> = [
  ['camera', 'camera'],
  ['reset', 'reset'],
  ['telemetry', 'telemetry'],
  ['menuNext', 'menuNext'],
  ['menuPrev', 'menuPrev'],
  ['menuUp', 'menuUp'],
  ['menuDown', 'menuDown'],
];

/** Keys the game uses, so the browser doesn't also scroll, tab or click with them. */
const CAPTURED_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyE',
  'KeyQ',
  ...Object.keys(KEY_ACTIONS),
]);

/** A gamepad counts as used when something moves at least this much. */
const ACTIVITY = 0.15;

/**
 * Samples keyboard, gamepads and wheels once per frame on the main thread (the Gamepad API isn't
 * available in workers) and produces the driver input sent to the simulation.
 */
export class InputManager {
  readonly driver: DriverInput = neutralInput();
  readonly actions = new Set<Action>();
  lastDevice: DeviceKind = 'none';
  padName = '';
  padFamily: PadFamily = 'generic';
  padConnected = false;
  /** A connected steering wheel (recognised by name or by a saved profile). */
  wheelPad: Gamepad | null = null;
  wheelProfile: WheelProfile | null = null;
  /** Steering and pedals before the car's own processing, for the telemetry panel. */
  readonly raw = { steer: 0, throttle: 0, brake: 0 };

  /** Set by the game from the saved settings. */
  padSettings: PadSettings | null = null;
  wheelProfiles: Record<string, WheelProfile> = {};
  /** While the wheel setup runs, the wheel is read by the wizard instead of driving. */
  wheelCaptured = false;

  private readonly keys = new Set<string>();
  private readonly pendingKeyActions: Action[] = [];
  private pendingShiftUp = 0;
  private pendingShiftDown = 0;
  private readonly prevButtons = new Map<number, boolean[]>();
  private readonly prevWheel = new Map<WheelAction, boolean>();
  private readonly lastWheelState = { steer: 0, throttle: 0, brake: 0 };
  private readonly wheelOut = wheelReading();
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
    const d = this.driver;
    d.shiftUp = this.pendingShiftUp;
    d.shiftDown = this.pendingShiftDown;
    this.pendingShiftUp = 0;
    this.pendingShiftDown = 0;

    const k = this.keys;
    const kbSteer =
      (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0) -
      (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0);
    let throttle = k.has('ArrowUp') || k.has('KeyW') ? 1 : 0;
    let brake = k.has('ArrowDown') || k.has('KeyS') ? 1 : 0;
    let handbrake = k.has('Space') ? 1 : 0;
    let clutch = 0;

    let padSteer = 0;
    const pad = this.readPads();
    if (pad) {
      const s = this.padSettings;
      padSteer = shapeSteer(pad.axes[0] ?? 0, s?.steerDeadzone ?? 0.06, s?.steerLinearity ?? 0.35);
      const padThrottle = shapePedal(pad.buttons[PAD.R2]?.value ?? 0, {
        curve: s?.throttleCurve ?? 'linear',
        deadzone: s?.throttleDeadzone ?? 0.03,
        saturation: 1,
      });
      const padBrake = shapePedal(pad.buttons[PAD.L2]?.value ?? 0, {
        curve: s?.brakeCurve ?? 'linear',
        deadzone: s?.brakeDeadzone ?? 0.03,
        saturation: 1,
      });
      throttle = Math.max(throttle, padThrottle);
      brake = Math.max(brake, padBrake);
      if (pad.buttons[PAD.SOUTH]?.pressed) handbrake = 1;
      const prev = this.prevButtons.get(pad.index) ?? [];
      const now = pad.buttons.map((b) => b.pressed);
      const pressed = (i: number) => now[i] === true && prev[i] !== true;
      for (const [button, action] of PAD_ACTIONS) if (pressed(button)) this.actions.add(action);
      if (pressed(PAD.R1)) d.shiftUp++;
      if (pressed(PAD.L1)) d.shiftDown++;
      // L3 + R3 together also toggle the telemetry (for pads without a touchpad).
      if ((pressed(PAD.L3) && now[PAD.R3]) || (pressed(PAD.R3) && now[PAD.L3])) {
        this.actions.add('telemetry');
      }
      this.prevButtons.set(pad.index, now);
      if (
        Math.abs(padSteer) > ACTIVITY ||
        padThrottle > ACTIVITY ||
        padBrake > ACTIVITY ||
        now.some(Boolean)
      ) {
        this.lastDevice = 'gamepad';
      }
    }

    let wheelAngle = 0;
    const wheel = this.wheelPad;
    const profile = this.wheelProfile;
    if (wheel && profile && !this.wheelCaptured) {
      const r = readWheel(wheel, profile, this.wheelOut);
      wheelAngle = r.angle;
      throttle = Math.max(throttle, r.throttle);
      brake = Math.max(brake, r.brake);
      clutch = r.clutch;
      const last = this.lastWheelState;
      if (
        Math.abs(r.steer - last.steer) > 0.02 ||
        Math.abs(r.throttle - last.throttle) > 0.05 ||
        Math.abs(r.brake - last.brake) > 0.05
      ) {
        this.lastDevice = 'wheel';
      }
      last.steer = r.steer;
      last.throttle = r.throttle;
      last.brake = r.brake;
      for (const [binding, action] of WHEEL_BUTTON_ACTIONS) {
        if (this.wheelPressed(binding, wheel, profile)) this.actions.add(action);
      }
      if (this.wheelPressed('shiftUp', wheel, profile)) d.shiftUp++;
      if (this.wheelPressed('shiftDown', wheel, profile)) d.shiftDown++;
      if (buttonDown(profile.buttons.handbrake, wheel)) handbrake = 1;
    }

    // Steering comes from whichever device was used last; the keys steer when nothing else does.
    if (this.lastDevice === 'wheel' && wheel && profile && !this.wheelCaptured) {
      d.steerMode = 'wheel';
      d.wheelAngle = wheelAngle;
      d.steer = 0;
      this.raw.steer = this.wheelOut.steer;
    } else if (this.lastDevice === 'gamepad' && kbSteer === 0) {
      d.steerMode = 'pad';
      d.steer = padSteer;
      this.raw.steer = padSteer;
    } else {
      d.steerMode = kbSteer !== 0 || this.lastDevice === 'keyboard' ? 'keyboard' : 'pad';
      d.steer = kbSteer !== 0 ? kbSteer : padSteer;
      this.raw.steer = d.steer;
    }
    d.throttle = throttle;
    d.brake = brake;
    d.handbrake = handbrake;
    d.clutch = clutch;
    this.raw.throttle = throttle;
    this.raw.brake = brake;
  }

  dispose(): void {
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
  }

  /**
   * Finds the wheel (if any) and the most recently used standard gamepad. Wheels are never used
   * as pads: without a profile their axes mean nothing.
   */
  private readPads(): Gamepad | null {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let best: Gamepad | null = null;
    let wheel: Gamepad | null = null;
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      const isWheel = this.wheelProfiles[pad.id] !== undefined || looksLikeWheel(pad.id);
      if (isWheel) {
        if (!wheel) wheel = pad;
        continue;
      }
      if (!best || pad.timestamp > best.timestamp) best = pad;
    }
    this.wheelPad = wheel;
    this.wheelProfile = wheel ? (this.wheelProfiles[wheel.id] ?? null) : null;
    this.padConnected = best !== null;
    if (best) {
      this.padName = cleanPadName(best.id);
      this.padFamily = padFamily(best.id);
    }
    return best;
  }

  private wheelPressed(action: WheelAction, pad: Gamepad, profile: WheelProfile): boolean {
    const down = buttonDown(profile.buttons[action], pad);
    const was = this.prevWheel.get(action) ?? false;
    this.prevWheel.set(action, down);
    if (down) this.lastDevice = 'wheel';
    return down && !was;
  }

  private onKey(event: KeyboardEvent, down: boolean): void {
    // Leave typing in form fields (wheel settings) alone.
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
    if (target?.closest?.('.wheel-setup')) return;
    if (CAPTURED_KEYS.has(event.code)) event.preventDefault();
    if (down) {
      if (!event.repeat) {
        const action = KEY_ACTIONS[event.code];
        if (action) this.pendingKeyActions.push(action);
        if (event.code === 'Tab')
          this.pendingKeyActions.push(event.shiftKey ? 'menuPrev' : 'menuNext');
        if (event.code === 'KeyE') this.pendingShiftUp++;
        if (event.code === 'KeyQ') this.pendingShiftDown++;
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
