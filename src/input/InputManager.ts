import type { PadSettings } from '../app/settings';
import { neutralInput, type DriverInput } from '../shared/protocol';
import type { UiEvent } from '../ui/menu/focus';
import { defaultBindings, type Bindings, type KeyAction, type PadAction } from './bindings';
import { shapePedal, shapeSteer } from './curves';
import type { TouchControls } from './TouchControls';
import {
  buttonDown,
  looksLikeWheel,
  readWheel,
  wheelReading,
  type WheelAction,
  type WheelProfile,
} from './wheel';

/** One-shot actions (edge-triggered) while driving. */
export type Action =
  | 'reset'
  | 'camera'
  | 'festivalMap'
  | 'overlay'
  | 'telemetry'
  | 'pause'
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

export type DeviceKind = 'keyboard' | 'gamepad' | 'wheel' | 'touch' | 'none';
export type PadFamily = 'playstation' | 'xbox' | 'generic';

/** A menu event and where it came from (some screens treat controller buttons specially). */
export interface UiInput {
  event: UiEvent;
  source: 'pad' | 'key' | 'wheel';
}

// Standard Gamepad mapping indices (https://w3c.github.io/gamepad/#remapping).
const PAD = {
  SOUTH: 0, // Cross / A
  EAST: 1, // Circle / B
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
} as const;

/** Keys with fixed roles (the rebindable ones come from the bindings). */
const FIXED_KEY_ACTIONS: Record<string, Action> = {
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

/** Rebindable pad buttons → actions (driving controls are handled separately). */
const PAD_BUTTON_ACTIONS: ReadonlyArray<[PadAction, Action]> = [
  ['reset', 'reset'],
  ['camera', 'camera'],
  ['overlay', 'overlay'],
  ['telemetry', 'telemetry'],
  ['pause', 'pause'],
];

const KEY_BUTTON_ACTIONS: ReadonlyArray<[KeyAction, Action]> = [
  ['reset', 'reset'],
  ['camera', 'camera'],
  ['overlay', 'overlay'],
  ['telemetry', 'telemetry'],
  ['pause', 'pause'],
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

/** The wheel's quick-menu buttons also move through menus. */
const WHEEL_MENU_EVENTS: Partial<Record<WheelAction, UiEvent>> = {
  menuUp: 'up',
  menuDown: 'down',
  menuPrev: 'left',
  menuNext: 'right',
};

const MENU_KEYS: Record<string, UiEvent> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Space: 'confirm',
  Escape: 'back',
  Backspace: 'back',
  KeyQ: 'tabPrev',
  KeyE: 'tabNext',
  PageUp: 'fastUp',
  PageDown: 'fastDown',
};
/** Menu keys that repeat while held (the rest fire once per press). */
const REPEATING = new Set<UiEvent>(['up', 'down', 'left', 'right', 'fastUp', 'fastDown']);

/** Keys the game uses, so the browser doesn't also scroll, tab or click with them. */
const ALWAYS_CAPTURED = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'Tab',
  'Backspace',
  'PageUp',
  'PageDown',
  ...Object.keys(FIXED_KEY_ACTIONS),
]);

/** A gamepad counts as used when something moves at least this much. */
const ACTIVITY = 0.15;
/** Holding a direction in a menu repeats it after this delay, at this interval (seconds). */
const REPEAT_DELAY = 0.38;
const REPEAT_INTERVAL = 0.085;
/** The stick counts as pushed past this (with a little hysteresis). */
const STICK_ON = 0.55;
const STICK_OFF = 0.4;

type Capture = { kind: 'pad' | 'key'; done: (value: number | string | null) => void };

/**
 * Samples keyboard, gamepads and wheels once per frame on the main thread (the Gamepad API isn't
 * available in workers). Produces the driver input sent to the simulation, one-shot driving
 * actions, and menu events with auto-repeat.
 */
export class InputManager {
  readonly driver: DriverInput = neutralInput();
  /** This frame's one-shot actions, in order (a key tapped twice in one frame counts twice). */
  readonly actions: Action[] = [];
  /** This frame's menu events. */
  readonly ui: UiInput[] = [];
  lastDevice: DeviceKind = 'none';
  padName = '';
  padFamily: PadFamily = 'generic';
  padConnected = false;
  /** The standard gamepad used most recently (for the controller tester and rumble). */
  activePad: Gamepad | null = null;
  /** A connected steering wheel (recognised by name or by a saved profile). */
  wheelPad: Gamepad | null = null;
  wheelProfile: WheelProfile | null = null;
  /** Steering and pedals before the car's own processing, for the telemetry panel. */
  readonly raw = { steer: 0, throttle: 0, brake: 0 };

  /** Set by the game from the saved settings. */
  padSettings: PadSettings | null = null;
  bindings: Bindings = defaultBindings();
  wheelProfiles: Record<string, WheelProfile> = {};
  /** While the wheel setup runs, the wheel is read by the wizard instead of driving. */
  wheelCaptured = false;
  /** On-screen controls (touch screens), read while they are shown. */
  touch: TouchControls | null = null;

  private readonly keys = new Set<string>();
  private readonly pendingKeyActions: Action[] = [];
  private readonly pendingUi: UiInput[] = [];
  private pendingShiftUp = 0;
  private pendingDrs = 0;
  private pendingBoost = 0;
  private pendingLights = 0;
  private pendingIndicatorLeft = 0;
  private pendingIndicatorRight = 0;
  private pendingHazards = 0;
  /** Free roam: the D-pad works the car's lights instead of the quick menu. */
  roam = false;
  private pendingShiftDown = 0;
  private readonly prevButtons = new Map<number, boolean[]>();
  private readonly prevWheel = new Map<WheelAction, boolean>();
  private readonly lastWheelState = { steer: 0, throttle: 0, brake: 0 };
  private readonly wheelOut = wheelReading();
  private readonly listeners: Array<[EventTarget, string, EventListener]> = [];
  /** Menu direction repeat state: when each held direction started and last fired. */
  private readonly held = new Map<UiEvent, { since: number; last: number; polls: number }>();
  private stickX = 0;
  private stickY = 0;
  private capture: Capture | null = null;
  /**
   * Button presses (released → pressed) seen between frames, per pad. The Gamepad API has no
   * button events, only polling: at a low frame rate a quick tap can start and end between two
   * frames, so the pads are also sampled on a fast timer and each new press is kept until the
   * next frame reads it. Only presses are kept, not the pressed state, so a press never lasts
   * longer than the button was actually down.
   */
  private readonly latched = new Map<number, boolean[]>();
  private readonly sampled = new Map<number, boolean[]>();
  private readonly sampler: ReturnType<typeof setInterval>;

  constructor() {
    this.sampler = setInterval(() => this.samplePads(), 8);
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    // Released keys aren't reported while the window is unfocused: forget them.
    this.listen(window, 'blur', () => this.keys.clear());
    this.listen(window, 'gamepadconnected', () => (this.padConnected = true));
    this.listen(window, 'pointerdown', (e) => {
      this.lastDevice = (e as PointerEvent).pointerType === 'touch' ? 'touch' : 'keyboard';
    });
  }

  /**
   * Waits for the next controller button or key (for rebinding). `done` gets the button index
   * or key code, or null if cancelled (Esc, or `cancelCapture`).
   */
  startCapture(kind: 'pad' | 'key', done: (value: number | string | null) => void): void {
    this.cancelCapture();
    this.capture = { kind, done };
  }

  cancelCapture(): void {
    const capture = this.capture;
    this.capture = null;
    capture?.done(null);
  }

  get capturing(): boolean {
    return this.capture !== null;
  }

  /** Call once per frame before reading `driver`, `actions` and `ui`. */
  update(): void {
    const now = performance.now() / 1000;
    this.actions.length = 0;
    this.actions.push(...this.pendingKeyActions);
    this.pendingKeyActions.length = 0;
    this.ui.length = 0;
    this.ui.push(...this.pendingUi);
    this.pendingUi.length = 0;
    const d = this.driver;
    d.shiftUp = this.pendingShiftUp;
    d.shiftDown = this.pendingShiftDown;
    d.drs = this.pendingDrs;
    d.boost = this.pendingBoost;
    d.lights = this.pendingLights;
    d.indicatorLeft = this.pendingIndicatorLeft;
    d.indicatorRight = this.pendingIndicatorRight;
    d.hazards = this.pendingHazards;
    this.pendingShiftUp = 0;
    this.pendingShiftDown = 0;
    this.pendingDrs = 0;
    this.pendingBoost = 0;
    this.pendingLights = 0;
    this.pendingIndicatorLeft = 0;
    this.pendingIndicatorRight = 0;
    this.pendingHazards = 0;

    const k = this.keys;
    const keysDown = (codes: readonly string[]) => codes.some((c) => k.has(c));
    d.horn = keysDown(this.bindings.keys.horn);
    d.nitro = keysDown(this.bindings.keys.boost);
    const kb = this.bindings.keys;
    const kbSteer = (keysDown(kb.steerRight) ? 1 : 0) - (keysDown(kb.steerLeft) ? 1 : 0);
    let throttle = keysDown(kb.throttle) ? 1 : 0;
    let brake = keysDown(kb.brake) ? 1 : 0;
    let handbrake = keysDown(kb.handbrake) ? 1 : 0;
    let clutch = 0;

    let padSteer = 0;
    const pad = this.readPads();
    if (pad) {
      const s = this.padSettings;
      padSteer = shapeSteer(
        pad.axes[0] ?? 0,
        s?.steerDeadzone ?? 0.06,
        s?.steerLinearity ?? 0.35,
        s?.steerSaturation ?? 1,
      );
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
      const b = this.bindings.pad;
      const prev = this.prevButtons.get(pad.index) ?? [];
      const latch = this.latched.get(pad.index);
      const now2 = pad.buttons.map((btn, i) => btn.pressed || latch?.[i] === true);
      if (latch) latch.length = 0;
      const pressed = (i: number) => now2[i] === true && prev[i] !== true;
      this.prevButtons.set(pad.index, now2);

      const captured = this.capture?.kind === 'pad' ? now2.findIndex((v, i) => v && !prev[i]) : -1;
      if (captured >= 0) {
        const capture = this.capture!;
        this.capture = null;
        capture.done(captured);
      } else if (!this.capture) {
        if (now2[b.handbrake]) handbrake = 1;
        for (const [binding, action] of PAD_BUTTON_ACTIONS) {
          if (pressed(b[binding])) this.actions.push(action);
        }
        if (this.roam) {
          // Free roam: the D-pad works the lights and R3 is the horn (the quick menu stays on
          // the keyboard there).
          if (pressed(PAD.DPAD_UP)) d.lights++;
          if (pressed(PAD.DPAD_DOWN)) d.hazards++;
          if (pressed(PAD.DPAD_LEFT)) d.indicatorLeft++;
          if (pressed(PAD.DPAD_RIGHT)) d.indicatorRight++;
          if (now2[PAD.R3] && !now2[PAD.L3]) d.horn = true;
        } else {
          if (pressed(PAD.DPAD_UP)) this.actions.push('menuUp');
          if (pressed(PAD.DPAD_DOWN)) this.actions.push('menuDown');
          if (pressed(PAD.DPAD_LEFT)) this.actions.push('menuPrev');
          if (pressed(PAD.DPAD_RIGHT)) this.actions.push('menuNext');
        }
        if (pressed(b.shiftUp)) d.shiftUp++;
        if (pressed(b.drs)) d.drs++;
        if (pressed(b.boost)) d.boost++;
        if (now2[b.boost]) d.nitro = true;
        if (pressed(b.shiftDown)) d.shiftDown++;
        // L3 + R3 together also toggle the telemetry (for pads without a touchpad).
        if ((pressed(PAD.L3) && now2[PAD.R3]) || (pressed(PAD.R3) && now2[PAD.L3])) {
          this.actions.push('telemetry');
        }
        this.padMenuEvents(pad, pressed, now2, now);
      }
      if (
        Math.abs(padSteer) > ACTIVITY ||
        padThrottle > ACTIVITY ||
        padBrake > ACTIVITY ||
        now2.some(Boolean)
      ) {
        this.lastDevice = 'gamepad';
      }
    } else {
      this.held.clear();
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
        if (!this.wheelPressed(binding, wheel, profile)) continue;
        this.actions.push(action);
        const menu = WHEEL_MENU_EVENTS[binding];
        if (menu) this.ui.push({ event: menu, source: 'wheel' });
      }
      if (this.wheelPressed('shiftUp', wheel, profile)) d.shiftUp++;
      if (this.wheelPressed('shiftDown', wheel, profile)) d.shiftDown++;
      if (buttonDown(profile.buttons.handbrake, wheel)) handbrake = 1;
    }

    let touchSteer = 0;
    const touch = this.touch;
    if (touch?.visible) {
      touch.update();
      const presses = touch.take();
      d.shiftUp += presses.shiftUp;
      d.shiftDown += presses.shiftDown;
      d.lights += presses.lights;
      d.hazards += presses.hazards;
      d.indicatorLeft += presses.indicatorLeft;
      d.indicatorRight += presses.indicatorRight;
      if (touch.horn) d.horn = true;
      for (let i = 0; i < presses.camera; i++) this.actions.push('camera');
      for (let i = 0; i < presses.reset; i++) this.actions.push('reset');
      for (let i = 0; i < presses.map; i++) this.actions.push('festivalMap');
      for (let i = 0; i < presses.menuNext; i++) this.actions.push('menuNext');
      for (let i = 0; i < presses.menuUp; i++) this.actions.push('menuUp');
      for (let i = 0; i < presses.menuDown; i++) this.actions.push('menuDown');
      if (presses.pause) this.actions.push('pause');
      throttle = Math.max(throttle, touch.throttle);
      brake = Math.max(brake, touch.brake);
      handbrake = Math.max(handbrake, touch.handbrake);
      if (touch.steering) {
        touchSteer = touch.steer;
        this.lastDevice = 'touch';
      }
    }

    // Steering comes from whichever device was used last; the keys steer when nothing else does.
    if (this.lastDevice === 'touch') {
      d.steerMode = 'pad';
      d.steer = touchSteer;
      this.raw.steer = touchSteer;
    } else if (this.lastDevice === 'wheel' && wheel && profile && !this.wheelCaptured) {
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
    clearInterval(this.sampler);
    for (const [target, type, fn] of this.listeners) target.removeEventListener(type, fn);
  }

  /** Between frames: remembers each new button press, so short taps aren't missed. */
  private samplePads(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad || !pad.connected) continue;
      let latch = this.latched.get(pad.index);
      let last = this.sampled.get(pad.index);
      if (!latch || !last) {
        latch = [];
        last = [];
        this.latched.set(pad.index, latch);
        this.sampled.set(pad.index, last);
      }
      for (let i = 0; i < pad.buttons.length; i++) {
        const down = pad.buttons[i]!.pressed;
        if (down && last[i] !== true) latch[i] = true;
        last[i] = down;
      }
    }
  }

  /** Menu events from a standard pad: buttons once per press, directions with auto-repeat. */
  private padMenuEvents(
    pad: Gamepad,
    pressed: (i: number) => boolean,
    down: boolean[],
    now: number,
  ): void {
    const push = (event: UiEvent) => this.ui.push({ event, source: 'pad' });
    if (pressed(PAD.SOUTH)) push('confirm');
    if (pressed(PAD.EAST)) push('back');
    if (pressed(PAD.L1)) push('tabPrev');
    if (pressed(PAD.R1)) push('tabNext');
    if (pressed(this.bindings.pad.pause)) push('pause');

    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    this.stickX = Math.abs(x) > (this.stickX !== 0 ? STICK_OFF : STICK_ON) ? Math.sign(x) : 0;
    this.stickY = Math.abs(y) > (this.stickY !== 0 ? STICK_OFF : STICK_ON) ? Math.sign(y) : 0;
    const directions: Array<[UiEvent, boolean]> = [
      ['up', down[PAD.DPAD_UP] === true || this.stickY < 0],
      ['down', down[PAD.DPAD_DOWN] === true || this.stickY > 0],
      ['left', down[PAD.DPAD_LEFT] === true || this.stickX < 0],
      ['right', down[PAD.DPAD_RIGHT] === true || this.stickX > 0],
      ['fastUp', (pad.buttons[PAD.R2]?.value ?? 0) > 0.6],
      ['fastDown', (pad.buttons[PAD.L2]?.value ?? 0) > 0.6],
    ];
    for (const [event, isDown] of directions) {
      const state = this.held.get(event);
      if (!isDown) {
        this.held.delete(event);
      } else if (!state) {
        this.held.set(event, { since: now, last: now, polls: 1 });
        push(event);
      } else if (
        // Seen held on a few polls as well as for the delay: one long frame (a hitch while a
        // menu opens) must not turn a tap into a repeat.
        ++state.polls > 2 &&
        now - state.since > REPEAT_DELAY &&
        now - state.last > REPEAT_INTERVAL
      ) {
        state.last = now;
        push(event);
      }
    }
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
    this.activePad = best;
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

    const capture = this.capture;
    if (capture?.kind === 'key' && down) {
      event.preventDefault();
      if (event.repeat) return;
      this.capture = null;
      capture.done(event.code === 'Escape' ? null : event.code);
      return;
    }

    const bound = this.boundKeyActions(event.code);
    if (ALWAYS_CAPTURED.has(event.code) || MENU_KEYS[event.code] || this.isBoundKey(event.code)) {
      event.preventDefault();
    }
    if (down) {
      const menu = MENU_KEYS[event.code];
      if (menu && (!event.repeat || REPEATING.has(menu))) {
        this.pendingUi.push({ event: menu, source: 'key' });
      }
      if (!event.repeat) {
        const fixed = FIXED_KEY_ACTIONS[event.code];
        if (fixed) this.pendingKeyActions.push(fixed);
        this.pendingKeyActions.push(...bound);
        if (event.code === 'Tab') {
          this.pendingKeyActions.push(event.shiftKey ? 'menuPrev' : 'menuNext');
        }
        if (this.bindings.keys.shiftUp.includes(event.code)) this.pendingShiftUp++;
        if (this.bindings.keys.drs.includes(event.code)) this.pendingDrs++;
        if (this.bindings.keys.boost.includes(event.code)) this.pendingBoost++;
        if (this.bindings.keys.lights.includes(event.code)) this.pendingLights++;
        if (this.bindings.keys.indicatorLeft.includes(event.code)) this.pendingIndicatorLeft++;
        if (this.bindings.keys.indicatorRight.includes(event.code)) this.pendingIndicatorRight++;
        if (this.bindings.keys.hazards.includes(event.code)) this.pendingHazards++;
        if (this.bindings.keys.shiftDown.includes(event.code)) this.pendingShiftDown++;
      }
      this.keys.add(event.code);
      this.lastDevice = 'keyboard';
    } else {
      this.keys.delete(event.code);
    }
  }

  /** One-shot actions bound to this key. */
  private boundKeyActions(code: string): Action[] {
    const keys = this.bindings.keys;
    const out: Action[] = [];
    for (const [binding, action] of KEY_BUTTON_ACTIONS) {
      if (keys[binding].includes(code)) out.push(action);
    }
    return out;
  }

  /** True if the key is bound to anything, so the browser shouldn't also act on it. */
  private isBoundKey(code: string): boolean {
    return Object.values(this.bindings.keys).some((codes) => codes.includes(code));
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
