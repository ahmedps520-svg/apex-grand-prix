import './touch.css';

export type TouchSteering = 'drag' | 'tilt';

/** Tilt steering: degrees of roll for full lock, and the dead zone around level. */
const TILT_LOCK = 24;
const TILT_DEAD = 1.5;

/** How the screen is turned from the device's natural orientation, 0 / 90 / 180 / 270. */
function screenAngle(): number {
  const legacy = (window as unknown as { orientation?: number }).orientation;
  const angle = screen.orientation?.angle ?? legacy ?? 0;
  return ((angle % 360) + 360) % 360;
}

/**
 * On-screen controls for touch screens: drag anywhere on the left half to steer (or tilt the
 * device), pedals and paddles on the right, a pause button, and in free roam a row for the
 * lights, the indicators, the hazards and the horn. Each control follows its own finger, so
 * steering, throttle and brake work at the same time.
 */
export class TouchControls {
  readonly root = document.createElement('div');
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = 0;
  /** Free roam: the horn, while held. */
  horn = false;
  /** True while a finger is steering (or tilt is on). */
  steering = false;
  steeringMode: TouchSteering = 'drag';
  private pendingUp = 0;
  private pendingDown = 0;
  private pendingPause = false;
  private pendingCamera = 0;
  private pendingReset = 0;
  private pendingLights = 0;
  private pendingMap = 0;
  private pendingHazards = 0;
  private pendingIndicatorLeft = 0;
  private pendingIndicatorRight = 0;
  private steerPointer = -1;
  private steerOrigin = 0;
  private tilt = 0;
  /** Motion access still to be asked for, on the next tap (iOS). */
  private tiltPending = false;
  private readonly knob = document.createElement('div');
  private readonly zone = document.createElement('div');
  private readonly roam = document.createElement('div');

  constructor(parent: HTMLElement) {
    this.root.className = 'touch-controls';
    this.root.hidden = true;
    this.zone.className = 'tc-steer-zone';
    this.knob.className = 'tc-knob';
    this.zone.appendChild(this.knob);
    this.root.appendChild(this.zone);
    this.bindSteering();

    const pedals = document.createElement('div');
    pedals.className = 'tc-pedals';
    pedals.append(
      this.pedal('tc-brake', 'BRAKE', (v) => (this.brake = v)),
      this.pedal('tc-throttle', 'GAS', (v) => (this.throttle = v)),
    );
    const paddles = document.createElement('div');
    paddles.className = 'tc-paddles';
    paddles.append(
      this.tap('tc-small', '−', () => this.pendingDown++),
      this.tap('tc-small', '+', () => this.pendingUp++),
      this.hold('tc-small tc-hb', 'HB', (v) => (this.handbrake = v)),
    );
    const pause = this.tap('tc-pause', 'II', () => (this.pendingPause = true));
    // Beside the pause button: the camera and the reset, in every mode.
    const extras = document.createElement('div');
    extras.className = 'tc-extras';
    extras.append(
      this.tap('tc-small tc-extra', 'CAM', () => this.pendingCamera++),
      this.tap('tc-small tc-extra', 'RESET', () => this.pendingReset++),
    );
    // Free roam: lights, indicators, hazards and the horn, top left (shown by setRoam).
    this.roam.className = 'tc-roam';
    this.roam.hidden = true;
    this.roam.append(
      this.tap('tc-small tc-roam-btn', 'LIGHTS', () => this.pendingLights++),
      this.tap('tc-small tc-roam-btn', '◄', () => this.pendingIndicatorLeft++),
      this.tap('tc-small tc-roam-btn', '►', () => this.pendingIndicatorRight++),
      this.tap('tc-small tc-roam-btn tc-hazards', '▲', () => this.pendingHazards++),
      this.hold('tc-small tc-roam-btn tc-horn', 'HORN', (v) => (this.horn = v > 0)),
      this.tap('tc-small tc-roam-btn', 'MAP', () => this.pendingMap++),
    );
    this.root.append(pedals, paddles, pause, extras, this.roam);
    parent.appendChild(this.root);
    window.addEventListener('deviceorientation', (e) => this.onTilt(e));
    // iOS: motion access asked for outside a tap fails; ask again on the first tap.
    document.addEventListener(
      'pointerdown',
      () => {
        if (!this.tiltPending) return;
        this.tiltPending = false;
        void this.enableTilt();
      },
      { passive: true },
    );
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean): void {
    if (this.root.hidden === !visible) return;
    this.root.hidden = !visible;
    if (!visible) {
      this.throttle = 0;
      this.brake = 0;
      this.handbrake = 0;
      this.horn = false;
      this.steer = 0;
      this.steerPointer = -1;
    }
  }

  /** Free roam: shows the lights, indicators, hazards and horn row. */
  setRoam(on: boolean): void {
    this.roam.hidden = !on;
    if (!on) this.horn = false;
  }

  /**
   * Tilt steering needs motion access on iOS, which is only granted from a tap. Restoring the
   * setting at start-up isn't one, so the request is repeated on the first touch; false means
   * the person refused it.
   */
  async enableTilt(): Promise<boolean> {
    const api = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    this.steeringMode = 'tilt';
    if (!api.requestPermission) return true;
    try {
      if ((await api.requestPermission()) === 'granted') return true;
      this.steeringMode = 'drag';
      return false;
    } catch {
      this.tiltPending = true;
      return true;
    }
  }

  /** Gear, pause and free-roam presses since the last call. */
  take(): {
    shiftUp: number;
    shiftDown: number;
    pause: boolean;
    camera: number;
    reset: number;
    map: number;
    lights: number;
    hazards: number;
    indicatorLeft: number;
    indicatorRight: number;
  } {
    const out = {
      shiftUp: this.pendingUp,
      shiftDown: this.pendingDown,
      pause: this.pendingPause,
      camera: this.pendingCamera,
      reset: this.pendingReset,
      map: this.pendingMap,
      lights: this.pendingLights,
      hazards: this.pendingHazards,
      indicatorLeft: this.pendingIndicatorLeft,
      indicatorRight: this.pendingIndicatorRight,
    };
    this.pendingUp = 0;
    this.pendingDown = 0;
    this.pendingPause = false;
    this.pendingCamera = 0;
    this.pendingReset = 0;
    this.pendingMap = 0;
    this.pendingLights = 0;
    this.pendingHazards = 0;
    this.pendingIndicatorLeft = 0;
    this.pendingIndicatorRight = 0;
    return out;
  }

  /** Call once per frame: applies tilt steering. */
  update(): void {
    if (this.steeringMode === 'tilt' && this.visible) {
      this.steer = this.tilt;
      this.steering = true;
    }
  }

  private bindSteering(): void {
    const zone = this.zone;
    zone.addEventListener('pointerdown', (e) => {
      if (this.steeringMode !== 'drag' || this.steerPointer >= 0) return;
      this.steerPointer = e.pointerId;
      this.steerOrigin = e.clientX;
      this.steering = true;
      zone.setPointerCapture(e.pointerId);
      this.moveKnob(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.steerPointer) return;
      const range = Math.max(window.innerWidth * 0.16, 60);
      this.steer = Math.max(-1, Math.min(1, (e.clientX - this.steerOrigin) / range));
      this.moveKnob(e.clientX, e.clientY);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = -1;
      this.steer = 0;
      this.steering = false;
      this.knob.style.opacity = '0';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
  }

  private moveKnob(x: number, y: number): void {
    this.knob.style.opacity = '1';
    this.knob.style.transform = `translate(${x - 36}px, ${y - 36}px)`;
  }

  /**
   * Steering is how far the screen's horizontal axis dips from level, whichever way the
   * device is held (flat on a lap or upright), worked out from where gravity points in the
   * device's own axes. Landscape works out which way round the device is turned from gravity
   * too, so it is right with the home button on either side.
   */
  private onTilt(e: DeviceOrientationEvent): void {
    const beta = ((e.beta ?? 0) * Math.PI) / 180;
    const gamma = ((e.gamma ?? 0) * Math.PI) / 180;
    // Gravity in device axes (x across the screen, y up it, in portrait), unit length.
    const gx = Math.sin(gamma) * Math.cos(beta);
    const gy = -Math.sin(beta);
    let across: number;
    if (window.innerWidth > window.innerHeight && Math.abs(gx) > 0.15) {
      // Landscape: the screen's "up" is whichever of ±x points away from gravity.
      across = gx < 0 ? -gy : gy;
    } else {
      const angle = screenAngle();
      const rad = (angle * Math.PI) / 180;
      across = gx * Math.cos(rad) - gy * Math.sin(rad);
    }
    const roll = (Math.asin(Math.max(-1, Math.min(1, across))) * 180) / Math.PI;
    const magnitude = Math.max(Math.abs(roll) - TILT_DEAD, 0) / (TILT_LOCK - TILT_DEAD);
    this.tilt = Math.sign(roll) * Math.min(magnitude, 1);
  }

  private pedal(className: string, label: string, set: (v: number) => void): HTMLElement {
    return this.hold(`tc-pedal ${className}`, label, set);
  }

  /** A button that reads 1 while held (pressure-sensitive where the screen supports it). */
  private hold(className: string, label: string, set: (v: number) => void): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = label;
    const pointers = new Set<number>();
    el.addEventListener('pointerdown', (e) => {
      pointers.add(e.pointerId);
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      set(e.pressure > 0 && e.pressure < 1 && e.pointerType === 'pen' ? e.pressure : 1);
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        el.classList.remove('down');
        set(0);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return el;
  }

  private tap(className: string, label: string, onTap: () => void): HTMLElement {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = label;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.classList.add('down');
      onTap();
    });
    const up = () => el.classList.remove('down');
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    return el;
  }
}

/** True on devices with a touch screen. */
export function hasTouch(): boolean {
  return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
}
