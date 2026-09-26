import type { Track } from '../sim/track/Track';
import { el } from './dom';
import './minimap.css';

/** A car on the minimap: world position on the ground plane and a CSS colour. */
export interface MinimapCar {
  x: number;
  z: number;
  color: string;
  player: boolean;
  /** Off the map: out of the race, or the safety car waiting in its box. */
  hidden?: boolean;
}

/** Space between the track's extremes and the edge of the map, CSS pixels. */
const PADDING = 13;
const CAR_RADIUS = 3.2;
const PLAYER_RADIUS = 4.6;

/**
 * Track map in the top-right corner, north (−z) up. The outline is drawn once to an offscreen
 * canvas; each frame copies it and draws a dot per car, the player's larger with a white ring.
 */
export class Minimap {
  readonly root = el('div', 'minimap');
  private readonly canvas = el('canvas', 'minimap-canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly outline = document.createElement('canvas');
  private readonly observer: ResizeObserver | null = null;
  private visible = true;
  private needsLayout = true;
  /** Map size in CSS pixels (0 until laid out) and the pixel ratio it was drawn for. */
  private size = 0;
  private ratio = 1;
  private observedSize = -1;
  /** World → map: map = world × scale + offset. */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;

  constructor(
    parent: HTMLElement,
    private readonly track: Track,
  ) {
    this.root.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    parent.appendChild(this.root);
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) this.observedSize = box.width;
        this.needsLayout = true;
      });
      this.observer.observe(this.canvas);
    }
  }

  /** Redraws the map with these cars. Cheap enough to call every frame. */
  update(cars: ReadonlyArray<MinimapCar>): void {
    const ctx = this.ctx;
    if (!this.visible || !ctx) return;
    if (this.needsLayout || this.ratio !== (window.devicePixelRatio || 1)) this.layout();
    if (this.size <= 0) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.outline, 0, 0);
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    for (const car of cars) if (!car.player && !car.hidden) this.drawCar(ctx, car);
    // The player last, on top of everyone else.
    for (const car of cars) if (car.player) this.drawCar(ctx, car);
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
    this.ratio = window.devicePixelRatio || 1;
    // The observer reports the size without forcing a layout; fall back to measuring.
    const size = this.observedSize >= 0 ? this.observedSize : this.canvas.clientWidth;
    // With an observer, wait for it to report a size; without one, keep trying.
    this.needsLayout = this.observer === null;
    this.size = size;
    if (size <= 0) return;
    const pixels = Math.round(size * this.ratio);
    this.canvas.width = pixels;
    this.canvas.height = pixels;
    this.outline.width = pixels;
    this.outline.height = pixels;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.track.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(maxX - minX, maxZ - minZ, 1);
    this.scale = Math.max(size - 2 * PADDING, 1) / span;
    this.offsetX = size / 2 - ((minX + maxX) / 2) * this.scale;
    this.offsetY = size / 2 - ((minZ + maxZ) / 2) * this.scale;
    this.drawOutline();
  }

  private drawOutline(): void {
    const ctx = this.outline.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const p of this.track.samples) ctx.lineTo(this.mapX(p.x), this.mapY(p.z));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 7;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(236, 240, 246, 0.92)';
    ctx.lineWidth = 3.5;
    ctx.stroke();

    // Start line: a short tick across the track (right of the driving direction is (−tz, tx)).
    const start = this.track.samples[0];
    if (!start) return;
    const x = this.mapX(start.x);
    const y = this.mapY(start.z);
    const reach = 6.5;
    ctx.beginPath();
    ctx.moveTo(x + start.tz * reach, y - start.tx * reach);
    ctx.lineTo(x - start.tz * reach, y + start.tx * reach);
    ctx.lineCap = 'butt';
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.lineWidth = 4.5;
    ctx.stroke();
    ctx.strokeStyle = '#ff3b2f';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  private drawCar(ctx: CanvasRenderingContext2D, car: MinimapCar): void {
    const x = this.mapX(car.x);
    const y = this.mapY(car.z);
    const radius = car.player ? PLAYER_RADIUS : CAR_RADIUS;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = car.color;
    ctx.fill();
    if (car.player) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
      // A dark halo keeps the white ring visible over the light track outline.
      ctx.beginPath();
      ctx.arc(x, y, radius + 1.6, 0, Math.PI * 2);
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.stroke();
    } else {
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)';
      ctx.stroke();
    }
  }

  private mapX(x: number): number {
    return x * this.scale + this.offsetX;
  }

  private mapY(z: number): number {
    return z * this.scale + this.offsetY;
  }
}
