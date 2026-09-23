import * as THREE from 'three/webgpu';
import type { RacingLine } from '../sim/race/racingLine';
import type { Track } from '../sim/track/Track';
import { el, setText } from '../ui/dom';
import './school.css';

/**
 * The driving school: short lessons with a controller or key prompt instead of paragraphs —
 * accelerate, brake, steer, follow the racing line, brake in the braking zones, DRS and the
 * ERS boost. Each lesson checks what the car does and moves on by itself.
 */

export type Lesson = 'throttle' | 'brake' | 'steer' | 'line' | 'braking' | 'drs' | 'ers';
export const LESSONS: readonly Lesson[] = [
  'throttle',
  'brake',
  'steer',
  'line',
  'braking',
  'drs',
  'ers',
];

export type Glyphs = 'playstation' | 'xbox' | 'keyboard' | 'touch';

const PROMPTS: Record<Lesson, { text: string; glyph: Record<Glyphs, string> }> = {
  throttle: {
    text: 'Accelerate',
    glyph: { playstation: 'R2', xbox: 'RT', keyboard: 'W', touch: 'GAS' },
  },
  brake: { text: 'Brake', glyph: { playstation: 'L2', xbox: 'LT', keyboard: 'S', touch: 'BRAKE' } },
  steer: {
    text: 'Stay on track',
    glyph: { playstation: 'L', xbox: 'LS', keyboard: 'A D', touch: '⟷' },
  },
  line: {
    text: 'Follow the line',
    glyph: { playstation: 'L', xbox: 'LS', keyboard: 'A D', touch: '⟷' },
  },
  braking: {
    text: 'Brake in the red',
    glyph: { playstation: 'L2', xbox: 'LT', keyboard: 'S', touch: 'BRAKE' },
  },
  drs: { text: 'Open DRS', glyph: { playstation: '□', xbox: 'X', keyboard: 'F', touch: 'DRS' } },
  ers: { text: 'Boost', glyph: { playstation: 'L3', xbox: 'LS', keyboard: 'B', touch: 'ERS' } },
};

/** What the school reads from the car each frame. */
export interface SchoolFrame {
  /** km/h */
  speed: number;
  brake: number;
  /** Metres driven this frame. */
  distance: number;
  onTrack: boolean;
  /** Distance from the racing line, m. */
  offLine: number;
  /** In a braking zone of the racing line. */
  inBrakingZone: boolean;
  drs: number;
  ersBoost: boolean;
  dt: number;
}

export class DrivingSchool {
  readonly root = el('div', 'school');
  lesson = 0;
  finished = false;
  private progress = 0;
  private peak = 0;
  private zoneBraked = false;
  private wasInZone = false;
  private glyphs: Glyphs = 'keyboard';
  private readonly card = el('div', 'school-card');
  private readonly glyph = el('span', 'school-glyph');
  private readonly text = el('span', 'school-text');
  private readonly bar = el('span', 'school-fill');
  private readonly dots: HTMLElement[] = [];
  /** Called when a lesson is passed (sound, rumble). */
  onPass: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    const head = el('div', 'school-head');
    head.append(this.glyph, this.text);
    const track = el('div', 'school-bar');
    track.appendChild(this.bar);
    const dots = el('div', 'school-dots');
    for (let i = 0; i < LESSONS.length; i++) {
      const dot = el('span');
      dots.appendChild(dot);
      this.dots.push(dot);
    }
    this.card.append(head, track, dots);
    this.root.appendChild(this.card);
    parent.appendChild(this.root);
    this.show();
  }

  setGlyphs(glyphs: Glyphs): void {
    if (glyphs === this.glyphs) return;
    this.glyphs = glyphs;
    this.show();
  }

  update(f: SchoolFrame): void {
    if (this.finished) return;
    const lesson = LESSONS[this.lesson]!;
    switch (lesson) {
      case 'throttle':
        this.progress = f.speed / 100;
        break;
      case 'brake':
        this.peak = Math.max(this.peak, f.speed);
        this.progress = this.peak > 60 ? (this.peak - f.speed) / (this.peak - 20) : 0;
        break;
      case 'steer':
        this.progress = f.onTrack ? this.progress + f.distance / 500 : 0;
        break;
      case 'line':
        if (f.offLine < 3) this.progress += f.distance / 800;
        else if (f.offLine > 6) this.progress = Math.max(this.progress - f.distance / 400, 0);
        break;
      case 'braking':
        if (f.inBrakingZone && f.brake > 0.4) this.zoneBraked = true;
        if (this.wasInZone && !f.inBrakingZone) {
          if (this.zoneBraked) this.progress += 1 / 3;
          this.zoneBraked = false;
        }
        this.wasInZone = f.inBrakingZone;
        break;
      case 'drs':
        if (f.drs === 2) this.progress = 1;
        break;
      case 'ers':
        if (f.ersBoost) this.progress += f.dt / 2;
        break;
    }
    this.progress = Math.min(Math.max(this.progress, 0), 1);
    this.bar.style.width = `${Math.round(this.progress * 100)}%`;
    if (this.progress >= 1) this.pass();
  }

  dispose(): void {
    this.root.remove();
  }

  private pass(): void {
    this.onPass?.();
    this.dots[this.lesson]?.classList.add('done');
    this.lesson++;
    this.progress = 0;
    this.peak = 0;
    this.card.classList.remove('pass');
    void this.card.offsetWidth;
    this.card.classList.add('pass');
    if (this.lesson >= LESSONS.length) {
      this.finished = true;
      setText(this.glyph, '✓');
      setText(this.text, 'Graduated!');
      this.bar.style.width = '100%';
      return;
    }
    this.show();
  }

  private show(): void {
    const lesson = LESSONS[this.lesson];
    if (!lesson) return;
    const prompt = PROMPTS[lesson];
    setText(this.glyph, prompt.glyph[this.glyphs]);
    setText(this.text, prompt.text);
    this.dots.forEach((d, i) => d.classList.toggle('now', i === this.lesson));
  }
}

/**
 * The racing line drawn on the road: green where the line accelerates, red where it brakes (the
 * braking zones), from the AI's planned speeds.
 */
export function racingLineMesh(line: RacingLine): { mesh: THREE.Mesh; braking: boolean[] } {
  const n = line.x.length;
  const positions: number[] = [];
  const colors: number[] = [];
  const braking: boolean[] = [];
  const green = new THREE.Color(0x39d98a);
  const red = new THREE.Color(0xff3b2f);
  for (let i = 0; i < n; i++) {
    const next = (i + 6) % n;
    braking.push(line.speed[next]! < line.speed[i]! - 0.4);
  }
  const width = 0.35;
  for (let i = 0; i <= n; i++) {
    const a = i % n;
    const b = (i + 1) % n;
    const dx = line.x[b]! - line.x[a]!;
    const dz = line.z[b]! - line.z[a]!;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const c = braking[a] ? red : green;
    for (const side of [-1, 1]) {
      positions.push(line.x[a]! + nx * width * side, 0.035, line.z[a]! + nz * width * side);
      colors.push(c.r, c.g, c.b);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = i * 2;
    index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(index);
  const material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  return { mesh, braking };
}

/** Index of the racing line point nearest to (x, z), searching around `hint`. */
export function nearestLinePoint(line: RacingLine, x: number, z: number, hint: number): number {
  const n = line.x.length;
  let best = hint < 0 ? 0 : hint;
  let bestD = Infinity;
  const span = hint < 0 ? n : 40;
  for (let k = -span; k <= span; k++) {
    const i = ((((hint < 0 ? 0 : hint) + k) % n) + n) % n;
    const d = (line.x[i]! - x) ** 2 + (line.z[i]! - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Distance from the track's centre line at which a car counts as off track, m. */
export function offTrack(track: Track, lateral: number): boolean {
  return Math.abs(lateral) > track.halfWidth + 1;
}
