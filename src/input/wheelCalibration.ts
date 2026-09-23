import {
  WHEEL_ACTIONS,
  defaultPedal,
  type ButtonBinding,
  type GamepadLike,
  type PedalBinding,
  type WheelAction,
  type WheelProfile,
} from './wheel';

/**
 * The wheel setup wizard's logic, separate from its UI so it can be tested with simulated
 * wheels. Feed it one gamepad sample per frame; it watches which axes and buttons move during
 * each step and builds a WheelProfile.
 */

export type PedalName = 'throttle' | 'brake' | 'clutch';

export type CalibrationStep =
  | { kind: 'center' }
  | { kind: 'steer'; side: 'left' | 'right' }
  | { kind: 'pedal'; pedal: PedalName }
  | { kind: 'button'; action: WheelAction; label: string }
  | { kind: 'done' };

/** Smallest axis movement that counts as "this is the axis you moved". */
const AXIS_THRESHOLD = 0.3;
/** A hat switch or axis-button counts as pressed this far from its rest value. */
const AXIS_BUTTON_THRESHOLD = 0.5;

interface AxisStats {
  min: number;
  max: number;
  last: number;
}

export class WheelCalibration {
  readonly steps: CalibrationStep[];
  index = 0;
  /** Why the last `next()` was refused (shown in the UI). */
  problem = '';

  private baseline: number[] = [];
  private stats: AxisStats[] = [];
  /** Buttons seen released during this step: only those can be bound by a new press. */
  private armed = new Set<number>();
  private axisArmed = new Set<number>();
  private detectedButton: ButtonBinding | null = null;

  private steer: WheelProfile['steer'] | null = null;
  private readonly pedals: Record<PedalName, PedalBinding | null> = {
    throttle: null,
    brake: null,
    clutch: null,
  };
  private readonly buttons: Partial<Record<WheelAction, ButtonBinding>> = {};

  constructor(
    readonly padId: string,
    readonly name: string,
    /** When set, only these button steps run (to rebind buttons on an existing profile). */
    only?: WheelAction[],
  ) {
    const buttonSteps: CalibrationStep[] = WHEEL_ACTIONS.filter(
      (a) => !only || only.includes(a.action),
    ).map((a) => ({ kind: 'button', action: a.action, label: a.label }));
    this.steps = only
      ? [{ kind: 'center' }, ...buttonSteps, { kind: 'done' }]
      : [
          { kind: 'center' },
          { kind: 'steer', side: 'left' },
          { kind: 'steer', side: 'right' },
          { kind: 'pedal', pedal: 'throttle' },
          { kind: 'pedal', pedal: 'brake' },
          { kind: 'pedal', pedal: 'clutch' },
          ...buttonSteps,
          { kind: 'done' },
        ];
  }

  get step(): CalibrationStep {
    return this.steps[this.index]!;
  }

  get done(): boolean {
    return this.step.kind === 'done';
  }

  /** Steps the user may skip: the clutch and every button. */
  get canSkip(): boolean {
    const s = this.step;
    return s.kind === 'button' || (s.kind === 'pedal' && s.pedal === 'clutch');
  }

  /** Feed the latest gamepad state (once per frame). */
  sample(pad: GamepadLike): void {
    const axes = pad.axes;
    for (let i = 0; i < axes.length; i++) {
      const v = axes[i]!;
      const s = this.stats[i];
      if (!s) this.stats[i] = { min: v, max: v, last: v };
      else {
        s.min = Math.min(s.min, v);
        s.max = Math.max(s.max, v);
        s.last = v;
      }
    }
    const step = this.step;
    if (step.kind === 'button' && !this.detectedButton) {
      pad.buttons.forEach((b, i) => {
        if (!b.pressed) this.armed.add(i);
        else if (this.armed.has(i)) this.detectedButton = { type: 'button', index: i };
      });
      // Hat switches that report as axes: a free axis jumping away from its rest value.
      for (let i = 0; i < axes.length && !this.detectedButton; i++) {
        if (this.usedAxis(i)) continue;
        const rest = this.baseline[i] ?? 0;
        const v = axes[i]!;
        if (Math.abs(v - rest) < 0.1) this.axisArmed.add(i);
        else if (this.axisArmed.has(i) && Math.abs(v - rest) > AXIS_BUTTON_THRESHOLD) {
          this.detectedButton = { type: 'axis', index: i, value: Math.round(v * 100) / 100 };
        }
      }
    }
  }

  /** True once a button step has seen a press (the wizard then moves on by itself). */
  get buttonDetected(): boolean {
    return this.detectedButton !== null;
  }

  /** What the current step has detected so far, for the live readout. */
  get detected(): string {
    const step = this.step;
    if (step.kind === 'steer' || step.kind === 'pedal') {
      const found = this.strongestAxis(
        step.kind === 'steer' ? [] : this.pedalExclusions(step.pedal),
      );
      return found ? `Axis ${found.axis} (${found.value.toFixed(2)})` : 'Waiting for movement…';
    }
    if (step.kind === 'button') {
      const b = this.detectedButton;
      if (!b) return 'Waiting for a button…';
      return b.type === 'button' ? `Button ${b.index}` : `Axis ${b.index} = ${b.value}`;
    }
    return '';
  }

  /** Accepts the current step. Returns false (and sets `problem`) if nothing usable was seen. */
  next(): boolean {
    const step = this.step;
    this.problem = '';
    switch (step.kind) {
      case 'center':
        this.baseline = this.stats.map((s) => s.last);
        break;
      case 'steer': {
        const found = this.strongestAxis([]);
        if (!found) return this.refuse('Turn the wheel all the way, then press Next.');
        if (step.side === 'left') {
          this.steer = {
            axis: found.axis,
            left: found.value,
            center: this.baseline[found.axis] ?? 0,
            right: -found.value,
          };
        } else {
          const steer = this.steer;
          if (!steer) return this.refuse('Turn the wheel left first.');
          const s = this.stats[steer.axis];
          const center = steer.center;
          // The right end is the extreme on the opposite side of the centre from the left end.
          const right = steer.left < center ? (s?.max ?? center) : (s?.min ?? center);
          if (Math.abs(right - center) < AXIS_THRESHOLD) {
            return this.refuse('Turn the wheel all the way to the right, then press Next.');
          }
          steer.right = right;
        }
        break;
      }
      case 'pedal': {
        const found = this.strongestAxis(this.pedalExclusions(step.pedal));
        if (!found) return this.refuse('Press the pedal all the way down, then press Next.');
        const current = this.stats[found.axis]?.last ?? found.value;
        // Some pedals read 0 until first moved, so trust the released position over the baseline.
        const rest =
          Math.abs(current - found.value) > 0.5 ? current : (this.baseline[found.axis] ?? 0);
        this.pedals[step.pedal] = defaultPedal(found.axis, rest, found.value);
        break;
      }
      case 'button':
        if (!this.detectedButton) return this.refuse('Press the button you want to use.');
        this.buttons[step.action] = this.detectedButton;
        break;
      case 'done':
        return true;
    }
    this.advance();
    return true;
  }

  skip(): void {
    if (!this.canSkip) return;
    this.problem = '';
    this.advance();
  }

  back(): void {
    if (this.index === 0) return;
    this.index--;
    this.problem = '';
    this.resetStep();
  }

  /** The finished profile (steering and pedals can be absent when only rebinding buttons). */
  profile(base?: WheelProfile): WheelProfile {
    const steer = this.steer ?? base?.steer ?? { axis: 0, left: -1, center: 0, right: 1 };
    return {
      version: 1,
      id: this.padId,
      name: this.name,
      steer,
      rotation: base?.rotation ?? 900,
      steerDeadzone: base?.steerDeadzone ?? 0,
      steerLinearity: base?.steerLinearity ?? 0,
      throttle: this.pedals.throttle ?? base?.throttle ?? null,
      brake: this.pedals.brake ?? base?.brake ?? null,
      clutch: this.steer ? this.pedals.clutch : (base?.clutch ?? null),
      buttons: { ...base?.buttons, ...this.buttons },
    };
  }

  private refuse(problem: string): false {
    this.problem = problem;
    return false;
  }

  private advance(): void {
    this.index = Math.min(this.index + 1, this.steps.length - 1);
    this.resetStep();
  }

  private resetStep(): void {
    // Start each step's min/max from the current position.
    this.stats = this.stats.map((s) => ({ min: s.last, max: s.last, last: s.last }));
    this.armed.clear();
    this.axisArmed.clear();
    this.detectedButton = null;
  }

  /** Throttle and brake may share one axis (combined pedals), in opposite directions. */
  private pedalExclusions(pedal: PedalName): number[] {
    const used: number[] = [];
    if (this.steer) used.push(this.steer.axis);
    const t = this.pedals.throttle;
    const b = this.pedals.brake;
    if (pedal !== 'throttle' && t && !(pedal === 'brake' && this.sharesAxis(t))) used.push(t.axis);
    if (pedal === 'clutch' && b) used.push(b.axis);
    return used;
  }

  /** True if the throttle's axis moved the other way from its rest this step (combined pedals). */
  private sharesAxis(throttle: PedalBinding): boolean {
    const s = this.stats[throttle.axis];
    if (!s) return false;
    const towardsFull = throttle.full - throttle.rest;
    const opposite = towardsFull > 0 ? throttle.rest - s.min : s.max - throttle.rest;
    return opposite > AXIS_THRESHOLD;
  }

  private usedAxis(axis: number): boolean {
    if (this.steer?.axis === axis) return true;
    return Object.values(this.pedals).some((p) => p?.axis === axis);
  }

  /** The axis that moved furthest from its rest position during this step. */
  private strongestAxis(exclude: number[]): { axis: number; value: number } | null {
    let best: { axis: number; value: number } | null = null;
    let bestMove = AXIS_THRESHOLD;
    this.stats.forEach((s, axis) => {
      if (exclude.includes(axis)) return;
      const rest = this.baseline[axis] ?? 0;
      for (const v of [s.min, s.max]) {
        const move = Math.abs(v - rest);
        if (move > bestMove) {
          bestMove = move;
          best = { axis, value: v };
        }
      }
    });
    return best;
  }
}
