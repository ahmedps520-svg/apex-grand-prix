import type { CityMap } from '../content/city/map';
import { el } from './dom';
import type { MinimapCar } from './Minimap';
import './minimap.css';

/**
 * The open world's minimap: the roads around the car, north up, drawn once into an offscreen
 * map of the whole city and copied from around the car each frame. The car is the dot in the
 * middle with a heading line; other cars are small dots.
 */

/** Map pixels per metre in the offscreen drawing. */
const SCALE = 0.32;
/** Metres shown across the map. */
const SPAN = 700;

export class CityMinimap {
  readonly root = el('div', 'minimap');
  private readonly canvas = el('canvas', 'minimap-canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly world = document.createElement('canvas');
  private readonly observer: ResizeObserver | null = null;
  private readonly originX: number;
  private readonly originZ: number;
  private visible = true;
  private size = 0;
  private ratio = 1;
  private observedSize = -1;

  constructor(
    parent: HTMLElement,
    private readonly map: CityMap,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
  ) {
    this.root.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    parent.appendChild(this.root);
    this.originX = bounds.minX;
    this.originZ = bounds.minZ;
    this.world.width = Math.ceil((bounds.maxX - bounds.minX) * SCALE);
    this.world.height = Math.ceil((bounds.maxZ - bounds.minZ) * SCALE);
    this.drawWorld();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) this.observedSize = box.width;
        this.size = 0;
      });
      this.observer.observe(this.canvas);
    }
  }

  update(cars: ReadonlyArray<MinimapCar>): void {
    const ctx = this.ctx;
    if (!this.visible || !ctx) return;
    if (this.size === 0) this.layout();
    const size = this.size;
    if (size === 0) return;
    const me = cars[0];
    if (!me) return;
    const ratio = this.ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = 'rgba(12, 15, 22, 0.72)';
    ctx.fillRect(0, 0, size, size);
    // The window of the world map around the car.
    const pxPerM = size / SPAN;
    const wx = (me.x - this.originX) * SCALE - (SPAN / 2) * SCALE;
    const wz = (me.z - this.originZ) * SCALE - (SPAN / 2) * SCALE;
    ctx.drawImage(this.world, wx, wz, SPAN * SCALE, SPAN * SCALE, 0, 0, size, size);
    for (let i = cars.length - 1; i >= 0; i--) {
      const car = cars[i]!;
      const x = size / 2 + (car.x - me.x) * pxPerM;
      const y = size / 2 + (car.z - me.z) * pxPerM;
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#ff3b2f' : '#f2f4f8';
      ctx.fill();
      if (i === 0) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.hidden = !visible;
  }

  dispose(): void {
    this.observer?.disconnect();
    this.root.remove();
  }

  private layout(): void {
    const css = this.observedSize > 0 ? this.observedSize : this.canvas.clientWidth;
    if (css <= 0) return;
    this.ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.size = css;
    this.canvas.width = Math.round(css * this.ratio);
    this.canvas.height = Math.round(css * this.ratio);
  }

  /** Every road once, width by kind, the decks brighter. */
  private drawWorld(): void {
    const ctx = this.world.getContext('2d');
    if (!ctx) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const pass = (elevated: boolean) => {
      for (const road of this.map.roads) {
        if (road.elevated !== elevated) continue;
        ctx.strokeStyle = elevated
          ? 'rgba(255, 214, 120, 0.95)'
          : road.kind === 'avenue'
            ? 'rgba(235, 238, 244, 0.9)'
            : road.kind === 'circuit'
              ? 'rgba(255, 90, 80, 0.9)'
              : 'rgba(190, 198, 210, 0.75)';
        ctx.lineWidth = Math.max(road.width * SCALE * 0.9, 1.2);
        ctx.beginPath();
        const n = road.points.length / 2;
        for (let i = 0; i < n; i++) {
          const x = (road.points[i * 2]! - this.originX) * SCALE;
          const y = (road.points[i * 2 + 1]! - this.originZ) * SCALE;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        if (road.loop) ctx.closePath();
        ctx.stroke();
      }
    };
    pass(false);
    pass(true);
  }
}
