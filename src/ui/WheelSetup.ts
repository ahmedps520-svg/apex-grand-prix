import { CURVE_KINDS, type CurveKind } from '../input/curves';
import {
  WHEEL_ACTIONS,
  readWheel,
  wheelReading,
  type ButtonBinding,
  type PedalBinding,
  type WheelAction,
  type WheelProfile,
} from '../input/wheel';
import { WheelCalibration, type CalibrationStep } from '../input/wheelCalibration';
import { el, setText } from './dom';

type PedalKey = 'throttle' | 'brake' | 'clutch';
const PEDALS: ReadonlyArray<{ key: PedalKey; label: string }> = [
  { key: 'throttle', label: 'Throttle' },
  { key: 'brake', label: 'Brake' },
  { key: 'clutch', label: 'Clutch' },
];

const CURVE_LABELS: Record<CurveKind, string> = {
  linear: 'Linear',
  progressive: 'Progressive',
  aggressive: 'Aggressive',
};

function instructions(step: CalibrationStep): string {
  switch (step.kind) {
    case 'center':
      return 'Centre the wheel and take your feet off the pedals, then press Next.';
    case 'steer':
      return `Turn the wheel all the way to the ${step.side.toUpperCase()} (you can let go again), then press Next.`;
    case 'pedal':
      return step.pedal === 'clutch'
        ? 'Press the CLUTCH all the way down and release it, then press Next. No clutch pedal? Press Skip.'
        : `Press the ${step.pedal.toUpperCase()} all the way down and release it, then press Next.`;
    case 'button':
      return `Press the wheel button for: ${step.label}. Or press Skip.`;
    case 'done':
      return 'All set. Next, check the steering rotation and pedal feel.';
  }
}

export function bindingText(binding: ButtonBinding | undefined): string {
  if (!binding) return '—';
  return binding.type === 'button'
    ? `Button ${binding.index}`
    : `Axis ${binding.index} at ${binding.value}`;
}

/**
 * Steering wheel setup: a step-by-step calibration wizard, then a settings page with the
 * rotation, dead zone, linearity, pedal curves and button bindings. Works with mouse and
 * keyboard (Enter = next, Esc = close), since the wheel itself is being calibrated.
 */
export class WheelSetup {
  readonly root = el('div', 'wheel-setup');
  /** Called with the finished or edited profile. */
  onSave: (profile: WheelProfile) => void = () => {};
  onClose: () => void = () => {};

  private readonly card = el('div', 'ws-card');
  private pad: Gamepad | null = null;
  private profile: WheelProfile | null = null;
  private calibration: WheelCalibration | null = null;
  private live: Array<() => void> = [];
  private autoNext = 0;
  private readonly reading = wheelReading();
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.visible) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    } else if (e.code === 'Enter' && this.calibration) {
      e.preventDefault();
      this.next();
    }
  };

  constructor(parent: HTMLElement) {
    this.root.appendChild(this.card);
    this.root.hidden = true;
    parent.appendChild(this.root);
    window.addEventListener('keydown', this.onKey);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  /** Starts the calibration wizard for `pad`. */
  startWizard(pad: Gamepad, base: WheelProfile | null): void {
    this.pad = pad;
    this.profile = base;
    this.calibration = new WheelCalibration(pad.id, cleanName(pad.id));
    this.root.hidden = false;
    this.renderWizard();
  }

  /** Opens the settings page for an existing profile. */
  openSettings(pad: Gamepad, profile: WheelProfile): void {
    this.pad = pad;
    this.profile = structuredClone(profile);
    this.calibration = null;
    this.root.hidden = false;
    this.renderSettings();
  }

  close(): void {
    this.root.hidden = true;
    this.calibration = null;
    this.live = [];
    this.onClose();
  }

  /** Call every frame with the wheel's current state. */
  update(pad: Gamepad | null, dt: number): void {
    if (!this.visible) return;
    if (pad) this.pad = pad;
    const cal = this.calibration;
    if (cal && this.pad) {
      cal.sample(this.pad);
      // Button steps move on by themselves shortly after a press was seen.
      if (cal.step.kind === 'button' && cal.buttonDetected) {
        this.autoNext += dt;
        if (this.autoNext > 0.25) this.next();
      } else {
        this.autoNext = 0;
      }
    }
    for (const fn of this.live) fn();
  }

  // ---------------------------------------------------------------- wizard

  private next(): void {
    const cal = this.calibration;
    if (!cal) return;
    this.autoNext = 0;
    if (cal.done) {
      const profile = cal.profile(this.profile ?? undefined);
      this.profile = profile;
      this.calibration = null;
      this.onSave(profile);
      this.renderSettings();
      return;
    }
    cal.next();
    this.renderWizard();
  }

  private renderWizard(): void {
    const cal = this.calibration!;
    this.card.replaceChildren();
    this.live = [];
    const step = cal.step;
    const total = cal.steps.length - 1;
    this.card.append(
      el('h2', undefined, `Wheel setup — ${cal.name}`),
      el('div', 'ws-step', cal.done ? 'Done' : `Step ${cal.index + 1} of ${total}`),
      el('p', 'ws-text', instructions(step)),
    );
    const detected = el('div', 'ws-detected');
    const problem = el('div', 'ws-problem', cal.problem);
    this.card.append(detected, problem);
    this.live.push(() => setText(detected, cal.detected));

    const buttons = el('div', 'ws-buttons');
    if (cal.index > 0 && !cal.done) {
      buttons.appendChild(this.button('Back', () => (cal.back(), this.renderWizard())));
    }
    if (cal.canSkip) {
      buttons.appendChild(this.button('Skip', () => (cal.skip(), this.renderWizard())));
    }
    buttons.appendChild(this.button(cal.done ? 'Continue' : 'Next', () => this.next(), true));
    buttons.appendChild(this.button('Cancel', () => this.close()));
    this.card.appendChild(buttons);
  }

  // ---------------------------------------------------------------- settings

  private renderSettings(): void {
    const profile = this.profile;
    if (!profile) return;
    this.card.replaceChildren();
    this.live = [];
    const save = () => this.onSave(structuredClone(profile));
    this.card.append(
      el('h2', undefined, `Wheel settings — ${profile.name}`),
      el(
        'p',
        'ws-text',
        'Steering is 1:1: the car’s steering wheel turns exactly as far as yours. Set the ' +
          'rotation to match your wheel driver (Logitech G HUB default: 900°).',
      ),
    );

    // Steering.
    const steer = el('div', 'ws-section');
    steer.appendChild(el('h3', undefined, 'Steering'));
    const angle = el('div', 'ws-live');
    this.live.push(() => {
      if (!this.pad) return;
      readWheel(this.pad, profile, this.reading);
      setText(angle, `Wheel angle ${((this.reading.angle * 180) / Math.PI).toFixed(0)}°`);
    });
    steer.append(
      angle,
      this.slider('Rotation', 180, 1080, 10, profile.rotation, '°', (v) => {
        profile.rotation = v;
        save();
      }),
      this.slider('Dead zone', 0, 10, 0.5, profile.steerDeadzone * 100, '%', (v) => {
        profile.steerDeadzone = v / 100;
        save();
      }),
      this.slider('Centre precision', 0, 100, 5, profile.steerLinearity * 100, '%', (v) => {
        profile.steerLinearity = v / 100;
        save();
      }),
    );
    this.card.appendChild(steer);

    // Pedals.
    const pedals = el('div', 'ws-section');
    pedals.appendChild(el('h3', undefined, 'Pedals'));
    for (const { key, label } of PEDALS) {
      const pedal = profile[key];
      const row = el('div', 'ws-pedal');
      row.appendChild(el('div', 'ws-pedal-name', label));
      if (!pedal) {
        row.appendChild(el('span', 'ws-muted', 'Not set up'));
        pedals.appendChild(row);
        continue;
      }
      const meter = el('div', 'ws-meter');
      const fill = el('span');
      meter.appendChild(fill);
      this.live.push(() => {
        const v = this.reading[key];
        fill.style.width = `${Math.round(v * 100)}%`;
      });
      row.append(
        meter,
        this.select(pedal.curve, (curve) => {
          pedal.curve = curve;
          save();
        }),
        this.slider('Dead zone', 0, 30, 1, pedal.deadzone * 100, '%', (v) => {
          pedal.deadzone = v / 100;
          save();
        }),
        this.slider('Full at', 50, 100, 1, pedal.saturation * 100, '%', (v) => {
          pedal.saturation = v / 100;
          save();
        }),
        this.checkbox('Invert', false, () => {
          invert(pedal);
          save();
        }),
      );
      pedals.appendChild(row);
    }
    this.card.appendChild(pedals);

    // Buttons.
    const buttons = el('div', 'ws-section');
    buttons.appendChild(el('h3', undefined, 'Buttons'));
    const list = el('div', 'ws-bindings');
    for (const { action, label } of WHEEL_ACTIONS) {
      const row = el('div', 'ws-binding');
      row.append(
        el('span', undefined, label),
        el('span', 'ws-muted', bindingText(profile.buttons[action])),
        this.button('Change', () => this.rebind(action)),
      );
      list.appendChild(row);
    }
    buttons.appendChild(list);
    this.card.appendChild(buttons);

    const footer = el('div', 'ws-buttons');
    footer.append(
      this.button('Run setup again', () => {
        if (this.pad) this.startWizard(this.pad, profile);
      }),
      this.button('Done', () => this.close(), true),
    );
    this.card.appendChild(footer);
  }

  private rebind(action: WheelAction): void {
    const profile = this.profile;
    if (!profile || !this.pad) return;
    this.calibration = new WheelCalibration(profile.id, profile.name, [action]);
    // The centre step only records rest positions: take it straight away.
    this.calibration.sample(this.pad);
    this.calibration.next();
    this.renderWizard();
  }

  // ---------------------------------------------------------------- widgets

  private button(text: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = el('button', primary ? 'ws-btn primary' : 'ws-btn', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  private slider(
    label: string,
    min: number,
    max: number,
    step: number,
    value: number,
    unit: string,
    onChange: (v: number) => void,
  ): HTMLElement {
    const wrap = el('label', 'ws-slider');
    const input = el('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    const out = el('span', 'ws-val', `${Math.round(value * 10) / 10}${unit}`);
    input.addEventListener('input', () => {
      const v = Number(input.value);
      setText(out, `${Math.round(v * 10) / 10}${unit}`);
      onChange(v);
    });
    wrap.append(el('span', undefined, label), input, out);
    return wrap;
  }

  private select(value: CurveKind, onChange: (v: CurveKind) => void): HTMLElement {
    const select = el('select', 'ws-select');
    for (const kind of CURVE_KINDS) {
      const option = el('option', undefined, CURVE_LABELS[kind]);
      option.value = kind;
      option.selected = kind === value;
      select.appendChild(option);
    }
    select.addEventListener('change', () => onChange(select.value as CurveKind));
    return select;
  }

  private checkbox(label: string, checked: boolean, onChange: () => void): HTMLElement {
    const wrap = el('label', 'ws-check');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = checked;
    input.addEventListener('change', onChange);
    wrap.append(input, el('span', undefined, label));
    return wrap;
  }
}

/** Swaps a pedal's released and pressed ends. */
function invert(pedal: PedalBinding): void {
  const rest = pedal.rest;
  pedal.rest = pedal.full;
  pedal.full = rest;
}

function cleanName(id: string): string {
  return id.replace(/\s*\(.*\)\s*$/, '').replace(/^[0-9a-f]{4}-[0-9a-f]{4}-/i, '') || 'Wheel';
}
