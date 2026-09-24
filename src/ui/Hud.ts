import { clockText } from '../content/conditions';
import {
  FLAG_ABS,
  FLAG_LIMITER,
  FLAG_NITRO,
  FLAG_SHIFT_DENIED,
  FLAG_TC,
  type PoliceStatus,
} from '../shared/protocol';
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
  /** Free roam: the speed limit of the road, as a round sign. */
  private readonly limit = el('div', 'hud-limit');
  /** Free roam: the time on the day's clock, above the readout. */
  private readonly clock = el('div', 'hud-clock');
  /** Tyre wear: the tread left on each tyre, in races with wear. */
  private readonly tyres = el('div', 'hud-tyres');
  private readonly tyreBars: HTMLElement[] = [];
  private tyresOn = false;
  private tyresShown = '';
  private clockShown = '';
  private limitShown = -1;
  /** Free roam: the wanted level, the state of the pursuit and the fine, at the top. */
  private readonly heat = el('div', 'hud-heat');
  private readonly heatStars: HTMLElement[] = [];
  private readonly heatState = el('div', 'hud-heat-state');
  private readonly heatHeli = el(
    'div',
    'hud-heat-heli',
    'HELICOPTER OVERHEAD · HIDE UNDER THE ORBITAL',
  );
  private readonly heatEvade = el('div', 'hud-heat-evade');
  private readonly heatEvadeFill = el('span');
  private readonly heatFine = el('div', 'hud-heat-fine');
  private heatShown = '';
  private heatVisible = true;
  private heatActive = false;
  private readonly segments: HTMLElement[] = [];
  private readonly abs = el('span', 'hud-lamp', 'ABS');
  private readonly tc = el('span', 'hud-lamp', 'TC');
  /** Hybrid cars: the DRS lamp and the ERS battery. */
  private readonly hybrid = el('div', 'hud-hybrid');
  private readonly drs = el('span', 'hud-drs', 'DRS');
  private readonly ers = el('span', 'hud-ers');
  private readonly ersFill = el('span');
  private hybridShown = '';
  /** Arcade: the nitro tank and the badge that says the handling is arcade. */
  private readonly nitro = el('div', 'hud-nitro');
  private readonly nitroFill = el('span');
  private readonly badge = el('div', 'hud-badge', 'ARCADE');
  private nitroShown = '';
  /** Damage: wing, engine and alignment bars, shown once something is damaged. */
  private readonly damage = el('div', 'hud-damage');
  private readonly damageBars: HTMLElement[] = [];
  private damageShown = '';
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
    for (const name of ['AERO', 'ENGINE', 'ALIGN']) {
      const row = el('div', 'hud-damage-row');
      const bar = el('span', 'hud-damage-bar');
      const fill = el('span');
      bar.appendChild(fill);
      row.append(el('span', 'hud-damage-name', name), bar);
      this.damage.appendChild(row);
      this.damageBars.push(fill);
    }
    this.damage.hidden = true;
    for (const name of ['FL', 'FR', 'RL', 'RR']) {
      const cell = el('div', 'hud-tyre');
      const bar = el('span', 'hud-tyre-bar');
      const fill = el('span');
      bar.appendChild(fill);
      cell.append(el('span', 'hud-tyre-name', name), bar);
      this.tyres.appendChild(cell);
      this.tyreBars.push(fill);
    }
    this.tyres.hidden = true;
    const nitroBar = el('span', 'hud-nitro-bar');
    nitroBar.appendChild(this.nitroFill);
    this.nitro.append(el('span', 'hud-nitro-label', 'NITRO'), nitroBar);
    this.nitro.hidden = true;
    this.badge.hidden = true;
    this.ers.appendChild(this.ersFill);
    this.hybrid.append(this.drs, this.ers);
    this.hybrid.hidden = true;
    const readout = el('div', 'hud-readout');
    const gearBlock = el('div', 'hud-gear-block');
    gearBlock.append(this.gear, this.mode);
    const speedBlock = el('div', 'hud-speed-block');
    speedBlock.append(this.speed, this.unit);
    readout.append(gearBlock, speedBlock);
    this.limit.hidden = true;
    this.clock.hidden = true;
    const stars = el('div', 'hud-heat-stars');
    for (let i = 0; i < 5; i++) {
      const star = el('span', undefined, '★');
      stars.appendChild(star);
      this.heatStars.push(star);
    }
    this.heatEvade.appendChild(this.heatEvadeFill);
    this.heat.append(stars, this.heatState, this.heatHeli, this.heatEvade, this.heatFine);
    this.heat.hidden = true;
    this.root.append(
      this.badge,
      this.tyres,
      this.damage,
      this.nitro,
      this.hybrid,
      this.lights,
      bar,
      this.clock,
      readout,
      lamps,
      this.limit,
    );
    // The wanted level sits at the top of the screen, outside the panel.
    parent.append(this.root, this.heat);
  }

  /** On-screen pedals in the right corner (touch): the readout takes the left one instead. */
  setBesideTouch(on: boolean): void {
    this.root.classList.toggle('beside-touch', on);
  }

  /** Shows or hides the HUD (the wanted level goes with it). */
  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.heatVisible = visible;
    this.heat.hidden = !(visible && this.heatActive);
  }

  /** Free roam: the time on the day's clock (null hides it). */
  setClock(hour: number | null): void {
    const text = hour === null ? '' : clockText(hour);
    if (text === this.clockShown) return;
    this.clockShown = text;
    this.clock.hidden = text === '';
    setText(this.clock, text);
  }

  /** Free roam: the wanted stars, the pursuit's state and the fine (null hides it all). */
  setHeat(status: PoliceStatus | null): void {
    const shown = !!status && (status.heat > 0 || status.state !== 'clear');
    const evade = status && status.state === 'pursuit' ? status.evade : 0;
    const key = status
      ? `${shown}:${status.heat}:${status.state}:${status.fine}:${status.fines}:${Math.round(evade * 40)}:${status.helicopter ? 1 : 0}`
      : '';
    if (key === this.heatShown) return;
    this.heatShown = key;
    this.heatActive = shown;
    this.heat.hidden = !(shown && this.heatVisible);
    if (!status || !shown) return;
    this.heat.className = `hud-heat ${status.state}`;
    this.heatStars.forEach((star, i) => star.classList.toggle('lit', i < status.heat));
    setText(
      this.heatState,
      status.state === 'pursuit'
        ? 'PURSUIT'
        : status.state === 'escaped'
          ? 'GOT AWAY'
          : status.state === 'busted'
            ? 'BUSTED'
            : '',
    );
    this.heatEvade.hidden = status.state !== 'pursuit';
    this.heatHeli.hidden = !(status.state === 'pursuit' && status.helicopter);
    this.heatEvadeFill.style.width = `${Math.round(evade * 100)}%`;
    const money = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
    setText(
      this.heatFine,
      status.state === 'busted'
        ? `FINES PAID ${money(status.fines)}`
        : status.state === 'pursuit'
          ? `FINE ${money(status.fine)}`
          : '',
    );
  }

  /** Shows the road's speed limit (km/h or mph by the units; 0 hides the sign). */
  setSpeedLimit(kmh: number): void {
    const shown = this.units === 'metric' ? Math.round(kmh) : Math.round(kmh * 0.621371);
    if (shown === this.limitShown) return;
    this.limitShown = shown;
    this.limit.hidden = kmh <= 0;
    setText(this.limit, String(shown));
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
    this.updateDamage(car);
    if (this.tyresOn) this.updateTyres(car);
    this.updateHybrid(car);
  }

  private updateHybrid(car: CarRenderState): void {
    const burning = (car.flags & FLAG_NITRO) !== 0;
    const nitroKey = `${car.nitro < 0 ? -1 : Math.round(car.nitro * 40)},${burning}`;
    if (nitroKey !== this.nitroShown) {
      this.nitroShown = nitroKey;
      this.nitro.hidden = car.nitro < 0;
      this.badge.hidden = car.nitro < 0;
      if (car.nitro >= 0) {
        this.nitroFill.style.width = `${Math.round(car.nitro * 100)}%`;
        this.nitro.classList.toggle('burning', burning);
      }
    }
    const key = `${car.ers < 0 ? -1 : Math.round(car.ers * 40)},${car.drs},${car.ersBoost}`;
    if (key === this.hybridShown) return;
    this.hybridShown = key;
    this.hybrid.hidden = car.ers < 0;
    if (car.ers < 0) return;
    this.drs.classList.toggle('allowed', car.drs === 1);
    this.drs.classList.toggle('open', car.drs === 2);
    this.ersFill.style.width = `${Math.round(car.ers * 100)}%`;
    this.ers.classList.toggle('boost', car.ersBoost);
  }

  /** Shows the tyres' tread (races with tyre wear). */
  setTyres(on: boolean): void {
    this.tyresOn = on;
    this.tyres.hidden = !on;
    this.tyresShown = '';
  }

  private updateTyres(car: CarRenderState): void {
    const levels = car.wheels.map((w) => w.wear);
    const key = levels.map((v) => Math.round(v * 50)).join(',');
    if (key === this.tyresShown) return;
    this.tyresShown = key;
    levels.forEach((v, i) => {
      const fill = this.tyreBars[i]!;
      fill.style.width = `${Math.round((1 - Math.min(v, 1)) * 100)}%`;
      fill.className = v > 0.8 ? 'bad' : v > 0.5 ? 'warn' : '';
    });
  }

  private updateDamage(car: CarRenderState): void {
    const levels = [car.damageAero, car.damageEngine, Math.abs(car.damageSteer)];
    // Update the DOM only when a bar moves by a visible step.
    const key = levels.map((v) => Math.round(v * 20)).join(',');
    if (key === this.damageShown) return;
    this.damageShown = key;
    this.damage.hidden = levels.every((v) => v < 0.03);
    levels.forEach((v, i) => {
      const fill = this.damageBars[i]!;
      fill.style.width = `${Math.round(Math.min(v, 1) * 100)}%`;
      fill.className = v > 0.5 ? 'bad' : v > 0.2 ? 'warn' : '';
    });
  }
}
