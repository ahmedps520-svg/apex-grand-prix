import { FLAG_ABS, FLAG_LIMITER, FLAG_SHIFT_DENIED, FLAG_TC } from '../shared/protocol';
import type { CarRenderState } from '../render/interpolate';
import { el, setText } from './dom';

export type Units = 'metric' | 'imperial';

const RPM_MAX = 8500;
const RPM_RED = 7600;
const SEGMENTS = 24;
/** Shift lights: green, red, then blue, filling up towards the shift point. */
const SHIFT_LIGHTS = 15;
const AID_NAMES = ['OFF', 'LO', 'HI'];

export interface HudEngine {
  /** Where the shift lights are all lit. */
  upshiftRpm: number;
  /** Where the first shift light comes on. */
  shiftLightsFrom: number;
}

/** Speed, gear, shift lights, rev bar and driver-aid lamps, anchored to the bottom safe area. */
export class Hud {
  readonly root = el('div', 'hud');
  units: Units = 'metric';
  private readonly lights = el('div', 'hud-shift');
  private readonly lightEls: HTMLElement[] = [];
  private readonly speed = el('div', 'hud-speed', '0');
  private readonly unit = el('div', 'hud-unit', 'km/h');
  private readonly gear = el('div', 'hud-gear', 'N');
  private readonly mode = el('div', 'hud-mode', 'AUTO');
  private readonly segments: HTMLElement[] = [];
  private readonly abs = el('span', 'hud-lamp', 'ABS');
  private readonly tc = el('span', 'hud-lamp', 'TC');
  private litSegments = -1;
  private litLights = -1;
  private flash = 0;

  constructor(
    parent: HTMLElement,
    private engine: HudEngine,
  ) {
    for (let i = 0; i < SHIFT_LIGHTS; i++) {
      const light = el('span');
      light.classList.add(i < 5 ? 'green' : i < 10 ? 'red' : 'blue');
      this.lights.appendChild(light);
      this.lightEls.push(light);
    }
    const bar = el('div', 'hud-rpm');
    for (let i = 0; i < SEGMENTS; i++) {
      const seg = el('span');
      if ((i + 1) / SEGMENTS > RPM_RED / RPM_MAX) seg.classList.add('red');
      bar.appendChild(seg);
      this.segments.push(seg);
    }
    const lamps = el('div', 'hud-lamps');
    lamps.append(this.tc, this.abs);
    const readout = el('div', 'hud-readout');
    const gearBlock = el('div', 'hud-gear-block');
    gearBlock.append(this.gear, this.mode);
    const speedBlock = el('div', 'hud-speed-block');
    speedBlock.append(this.speed, this.unit);
    readout.append(gearBlock, speedBlock);
    this.root.append(this.lights, bar, readout, lamps);
    parent.appendChild(this.root);
  }

  /** Shift-light thresholds for the car being driven. */
  setEngine(engine: HudEngine): void {
    this.engine = engine;
  }

  setUnits(units: Units): void {
    this.units = units;
    setText(this.unit, units === 'metric' ? 'km/h' : 'mph');
  }

  update(car: CarRenderState, dt: number): void {
    const kmh = Math.abs(car.speed) * 3.6;
    const shown = this.units === 'metric' ? kmh : kmh / 1.609344;
    setText(this.speed, Math.round(shown).toString());
    setText(this.gear, car.gear < 0 ? 'R' : car.gear === 0 ? 'N' : String(car.gear));
    setText(this.mode, car.manualGearbox ? 'MAN' : 'AUTO');
    this.gear.classList.toggle('denied', (car.flags & FLAG_SHIFT_DENIED) !== 0);

    const rpmMax = Math.max(this.engine.upshiftRpm * 1.1, RPM_MAX * 0.5);
    const lit = Math.round((Math.min(car.rpm, rpmMax) / rpmMax) * SEGMENTS);
    if (lit !== this.litSegments) {
      this.segments.forEach((s, i) => s.classList.toggle('on', i < lit));
      this.litSegments = lit;
    }

    // Shift lights fill between the two thresholds; at the shift point they all flash.
    const { upshiftRpm, shiftLightsFrom } = this.engine;
    const fill = (car.rpm - shiftLightsFrom) / (upshiftRpm - shiftLightsFrom);
    let lights = Math.max(0, Math.min(SHIFT_LIGHTS, Math.ceil(fill * SHIFT_LIGHTS)));
    const shiftNow = car.rpm >= upshiftRpm && car.gear > 0;
    if (shiftNow) {
      this.flash = (this.flash + dt * 8) % 1;
      lights = this.flash < 0.5 ? SHIFT_LIGHTS : 0;
    }
    if (lights !== this.litLights) {
      this.lightEls.forEach((l, i) => l.classList.toggle('on', i < lights));
      this.litLights = lights;
    }
    this.lights.classList.toggle('shift-now', shiftNow);

    this.root.classList.toggle('limiter', (car.flags & FLAG_LIMITER) !== 0);
    setText(this.tc, `TC ${AID_NAMES[car.tcLevel] ?? ''}`);
    setText(this.abs, `ABS ${AID_NAMES[car.absLevel] ?? ''}`);
    this.tc.classList.toggle('off', car.tcLevel === 0);
    this.abs.classList.toggle('off', car.absLevel === 0);
    this.abs.classList.toggle('active', (car.flags & FLAG_ABS) !== 0);
    this.tc.classList.toggle('active', (car.flags & FLAG_TC) !== 0);
  }
}
