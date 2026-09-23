import { FLAG_ABS, FLAG_LIMITER, FLAG_TC } from '../shared/protocol';
import type { CarRenderState } from '../render/interpolate';
import { el, setText } from './dom';

export type Units = 'metric' | 'imperial';

const RPM_MAX = 8500;
const RPM_RED = 7600;
const SEGMENTS = 24;

/** Speed, gear, rev bar and assist lights, anchored to the bottom safe area. */
export class Hud {
  readonly root = el('div', 'hud');
  units: Units = 'metric';
  private readonly speed = el('div', 'hud-speed', '0');
  private readonly unit = el('div', 'hud-unit', 'km/h');
  private readonly gear = el('div', 'hud-gear', 'N');
  private readonly segments: HTMLElement[] = [];
  private readonly abs = el('span', 'hud-lamp', 'ABS');
  private readonly tc = el('span', 'hud-lamp', 'TC');
  private litSegments = -1;

  constructor(parent: HTMLElement) {
    const bar = el('div', 'hud-rpm');
    for (let i = 0; i < SEGMENTS; i++) {
      const seg = el('span');
      if ((i + 1) / SEGMENTS > RPM_RED / RPM_MAX) seg.classList.add('red');
      bar.appendChild(seg);
      this.segments.push(seg);
    }
    const lamps = el('div', 'hud-lamps');
    lamps.append(this.abs, this.tc);
    const readout = el('div', 'hud-readout');
    const speedBlock = el('div', 'hud-speed-block');
    speedBlock.append(this.speed, this.unit);
    readout.append(this.gear, speedBlock);
    this.root.append(bar, readout, lamps);
    parent.appendChild(this.root);
  }

  setUnits(units: Units): void {
    this.units = units;
    setText(this.unit, units === 'metric' ? 'km/h' : 'mph');
  }

  update(car: CarRenderState): void {
    const kmh = Math.abs(car.speed) * 3.6;
    const shown = this.units === 'metric' ? kmh : kmh / 1.609344;
    setText(this.speed, Math.round(shown).toString());
    setText(this.gear, car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : String(car.gear));
    const lit = Math.round((Math.min(car.rpm, RPM_MAX) / RPM_MAX) * SEGMENTS);
    if (lit !== this.litSegments) {
      this.segments.forEach((s, i) => s.classList.toggle('on', i < lit));
      this.litSegments = lit;
    }
    this.root.classList.toggle('limiter', (car.flags & FLAG_LIMITER) !== 0);
    this.abs.classList.toggle('active', (car.flags & FLAG_ABS) !== 0);
    this.tc.classList.toggle('active', (car.flags & FLAG_TC) !== 0);
  }
}
