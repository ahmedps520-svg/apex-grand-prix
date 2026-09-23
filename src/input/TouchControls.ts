import './touch.css';

export type TouchSteering = 'drag' | 'tilt';

/**
 * On-screen controls for touch screens: drag anywhere on the left half to steer (or tilt the
 * device), pedals and paddles on the right, and a pause button. Each control follows its own
 * finger, so steering, throttle and brake work at the same time.
 */
export class TouchControls {
  readonly root = document.createElement('div');
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = 0;
  /** True while a finger is steering (or tilt is on). */
  steering = false;
  steeringMode: TouchSteering = 'drag';
  private pendingUp = 0;
  private pendingDown = 0;
  private pendingPause = false;
  private steerPointer = -1;
  private steerOrigin = 0;
  private tilt = 0;
  private readonly knob = document.createElement('div');
  private readonly zone = document.createElement('div');

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
    this.root.append(pedals, paddles, pause);
    parent.appendChild(this.root);
    window.addEventListener('deviceorientation', (e) => this.onTilt(e));
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
      this.steer = 0;
      this.steerPointer = -1;
    }
  }

  /** Tilt steering needs permission on iOS; call from a tap. */
  async enableTilt(): Promise<boolean> {
    const request = (
      DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> }
    ).requestPermission;
    if (request) {
      try {
        if ((await request()) !== 'granted') return false;
      } catch {
        return false;
      }
    }
    this.steeringMode = 'tilt';
    return true;
  }

  /** Gear and pause presses since the last call. */
  take(): { shiftUp: number; shiftDown: number; pause: boolean } {
    const out = { shiftUp: this.pendingUp, shiftDown: this.pendingDown, pause: this.pendingPause };
    this.pendingUp = 0;
    this.pendingDown = 0;
    this.pendingPause = false;
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

  private onTilt(e: DeviceOrientationEvent): void {
    // Landscape: steering is the device's roll, which the browser reports as beta or gamma
    // depending on which way up it is held.
    const angle = screen.orientation?.angle ?? 0;
    const beta = e.beta ?? 0;
    const roll = angle === 90 ? beta : angle === 270 || angle === -90 ? -beta : (e.gamma ?? 0);
    this.tilt = Math.max(-1, Math.min(1, roll / 28));
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
