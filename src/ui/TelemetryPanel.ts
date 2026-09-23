import type { CarRenderState } from '../render/interpolate';
import { FLAG_ABS, FLAG_TC, WHEEL_NAMES } from '../shared/protocol';
import { el, setText } from './dom';

const G = 9.81;
const DEG = 180 / Math.PI;
/** Text refresh rate; the g-g plot redraws every frame. */
const TEXT_INTERVAL = 1 / 15;
const TRAIL = 120;
const PLOT_G = 2.5;
const AID_NAMES = ['off', 'low', 'high'];

/** What the player asked for, next to what the car did with it. */
export interface TelemetryInputs {
  steer: number;
  throttle: number;
  brake: number;
  device: string;
}

interface Bar {
  root: HTMLElement;
  fill: HTMLElement;
  text: HTMLElement;
}

/**
 * Developer telemetry for tuning the handling (F3 / touchpad click / L3 + R3): inputs versus
 * what the car applied, and per-wheel load, slip and grip, plus a g-g diagram.
 */
export class TelemetryPanel {
  readonly root = el('div', 'telemetry');
  private readonly summary = el('div', 'tm-summary');
  private readonly bars: Record<'throttleIn' | 'throttleCar' | 'brakeIn' | 'brakeCar', Bar>;
  private readonly steer = el('div', 'tm-line');
  private readonly aids = el('div', 'tm-line');
  private readonly g = el('div', 'tm-line');
  private readonly cells: HTMLElement[][] = [];
  private readonly gripBars: HTMLElement[] = [];
  private readonly plot: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly trail = new Float32Array(TRAIL * 2);
  private trailHead = 0;
  private trailCount = 0;
  private textTimer = 0;

  constructor(parent: HTMLElement) {
    this.root.appendChild(el('div', 'tm-title', 'Telemetry'));
    this.root.appendChild(this.summary);
    const bar = (label: string): Bar => {
      const root = el('div', 'tm-bar');
      const track = el('div', 'tm-track');
      const fill = el('span');
      track.appendChild(fill);
      const text = el('span', 'tm-val', '0%');
      root.append(el('span', 'tm-key', label), track, text);
      return { root, fill, text };
    };
    this.bars = {
      throttleIn: bar('Throttle in'),
      throttleCar: bar('Throttle car'),
      brakeIn: bar('Brake in'),
      brakeCar: bar('Brake car'),
    };
    for (const b of Object.values(this.bars)) this.root.appendChild(b.root);
    this.root.append(this.steer, this.aids);

    const table = el('table', 'tm-wheels');
    const head = el('tr');
    head.appendChild(el('th'));
    for (const name of WHEEL_NAMES) head.appendChild(el('th', undefined, name));
    table.appendChild(head);
    const rows = ['Load kN', 'Slip %', 'Angle °', 'Grip', 'Camber °', 'Surface'];
    for (const row of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'tm-key', row));
      const cells: HTMLElement[] = [];
      for (let i = 0; i < WHEEL_NAMES.length; i++) {
        const td = el('td');
        if (row === 'Grip') {
          const meter = el('div', 'tm-grip');
          const fill = el('span');
          meter.appendChild(fill);
          const text = el('span', 'tm-grip-text');
          td.append(meter, text);
          this.gripBars.push(fill);
          cells.push(text);
        } else {
          cells.push(td);
        }
        tr.appendChild(td);
      }
      this.cells.push(cells);
      table.appendChild(tr);
    }
    this.root.appendChild(table);

    const gRow = el('div', 'tm-g');
    this.plot = el('canvas', 'tm-plot');
    this.plot.width = 132;
    this.plot.height = 132;
    this.ctx = this.plot.getContext('2d');
    gRow.append(this.plot, this.g);
    this.root.appendChild(gRow);
    this.root.hidden = true;
    parent.appendChild(this.root);
  }

  get visible(): boolean {
    return !this.root.hidden;
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.trailCount = 0;
  }

  update(dt: number, car: CarRenderState, inputs: TelemetryInputs): void {
    if (!this.visible) return;
    const gLong = car.accelLong / G;
    const gLat = car.accelLat / G;
    this.trail[this.trailHead * 2] = gLat;
    this.trail[this.trailHead * 2 + 1] = gLong;
    this.trailHead = (this.trailHead + 1) % TRAIL;
    this.trailCount = Math.min(this.trailCount + 1, TRAIL);
    this.drawPlot();

    this.textTimer += dt;
    if (this.textTimer < TEXT_INTERVAL) return;
    this.textTimer = 0;

    const gear = car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : String(car.gear);
    setText(
      this.summary,
      `${Math.round(Math.abs(car.speed) * 3.6)} km/h · ${Math.round(car.rpm)} rpm · gear ${gear} ` +
        `(${car.manualGearbox ? 'manual' : 'auto'}) · ${inputs.device}`,
    );
    this.setBar(this.bars.throttleIn, inputs.throttle);
    this.setBar(this.bars.throttleCar, car.throttle);
    this.setBar(this.bars.brakeIn, inputs.brake);
    this.setBar(this.bars.brakeCar, car.brake);
    setText(
      this.steer,
      `Steer in ${signed(inputs.steer, 2)} → road wheels ${signed(car.steerAngle * DEG, 1)}° ` +
        `(range ±${(car.steerAuthority * DEG).toFixed(1)}°)`,
    );
    const tc = `TC ${AID_NAMES[car.tcLevel] ?? '?'}${car.flags & FLAG_TC ? ' ACTIVE' : ''}`;
    const abs = `ABS ${AID_NAMES[car.absLevel] ?? '?'}${car.flags & FLAG_ABS ? ' ACTIVE' : ''}`;
    setText(this.aids, `${tc} · ${abs} · clutch ${Math.round(car.clutch * 100)}%`);
    setText(this.g, `g long ${signed(gLong, 2)}\ng lat ${signed(gLat, 2)}`);

    for (let i = 0; i < car.wheels.length; i++) {
      const w = car.wheels[i]!;
      const c = (row: number) => this.cells[row]![i]!;
      setText(c(0), (w.load / 1000).toFixed(2));
      setText(c(1), signed(w.slipRatio * 100, 1));
      setText(c(2), signed(w.slipAngle * DEG, 1));
      setText(c(3), w.contact ? `${Math.round(w.slip * 100)}%` : 'air');
      setText(c(4), signed(w.camber * DEG, 1));
      setText(c(5), !w.contact ? '—' : w.surface === 1 ? 'grass' : 'asphalt');
      const bar = this.gripBars[i]!;
      bar.style.width = `${Math.min(w.slip, 1.5) * (100 / 1.5)}%`;
      bar.className = w.slip > 1 ? 'over' : w.slip > 0.8 ? 'near' : '';
    }
  }

  private setBar(bar: Bar, value: number): void {
    const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100);
    bar.fill.style.width = `${pct}%`;
    setText(bar.text, `${pct}%`);
  }

  /** Lateral g across, longitudinal g up (acceleration up, braking down). */
  private drawPlot(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const size = this.plot.width;
    const mid = size / 2;
    const scale = (mid - 6) / PLOT_G;
    ctx.clearRect(0, 0, size, size);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    for (const r of [1, 2]) {
      ctx.beginPath();
      ctx.arc(mid, mid, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(mid, 4);
    ctx.lineTo(mid, size - 4);
    ctx.moveTo(4, mid);
    ctx.lineTo(size - 4, mid);
    ctx.stroke();
    for (let k = 0; k < this.trailCount; k++) {
      const i = (this.trailHead - 1 - k + TRAIL) % TRAIL;
      const x = mid + this.trail[i * 2]! * scale;
      const y = mid - this.trail[i * 2 + 1]! * scale;
      const newest = k === 0;
      ctx.fillStyle = newest ? '#ff3b2f' : `rgba(255,255,255,${0.6 * (1 - k / TRAIL)})`;
      ctx.fillRect(x - (newest ? 3 : 1), y - (newest ? 3 : 1), newest ? 6 : 2, newest ? 6 : 2);
    }
  }
}

function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return value >= 0 ? `+${text}` : text;
}
