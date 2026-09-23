import * as THREE from 'three/webgpu';
import { mulberry32 } from '../shared/math';

/** Procedural textures drawn once at startup, so the build ships no image files. */

/** The UI's font stack: system fonts are always loaded, so text can be drawn right away. */
const LABEL_FONT =
  "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

function makeCanvas(width: number, height = width): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [canvas, ctx];
}

/** Tileable multi-octave value noise in [0, 1]. */
function tileableNoise(
  size: number,
  seed: number,
  octaves: number,
  baseCells: number,
): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);
  let amplitude = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cells = baseCells << o;
    const grid = new Float32Array(cells * cells);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < size; y++) {
      const gy = (y / size) * cells;
      const y0 = Math.floor(gy);
      const fy = gy - y0;
      const sy = fy * fy * (3 - 2 * fy);
      const row0 = (y0 % cells) * cells;
      const row1 = ((y0 + 1) % cells) * cells;
      for (let x = 0; x < size; x++) {
        const gx = (x / size) * cells;
        const x0 = Math.floor(gx);
        const fx = gx - x0;
        const sx = fx * fx * (3 - 2 * fx);
        const x1 = (x0 + 1) % cells;
        const a = grid[row0 + (x0 % cells)]!;
        const b = grid[row0 + x1]!;
        const c = grid[row1 + (x0 % cells)]!;
        const d = grid[row1 + x1]!;
        const v = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
        out[y * size + x]! += v * amplitude;
      }
    }
    total += amplitude;
    amplitude *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i]! /= total;
  return out;
}

function toTexture(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  srgb: boolean,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = 8;
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Tileable asphalt; repeats are tiles across the surface's u (x) and v (y) directions. */
export function asphaltTexture(repeatX: number, repeatY = repeatX): THREE.CanvasTexture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const noise = tileableNoise(size, 7, 5, 8);
  const rand = mulberry32(11);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    let v = 58 + noise[i]! * 34;
    // Aggregate speckles: a few light stones and dark pits.
    const r = rand();
    if (r > 0.985) v += 38 * rand();
    else if (r < 0.02) v -= 22 * rand();
    image.data[i * 4] = v * 1.02;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v * 0.96;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return toTexture(canvas, repeatX, repeatY, true);
}

export function grassTexture(repeat: number): THREE.CanvasTexture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const noise = tileableNoise(size, 3, 5, 4);
  const blades = tileableNoise(size, 5, 2, 64);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = noise[i]!;
    const b = blades[i]!;
    image.data[i * 4] = 52 + n * 40 + b * 18;
    image.data[i * 4 + 1] = 92 + n * 52 + b * 22;
    image.data[i * 4 + 2] = 38 + n * 22;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return toTexture(canvas, repeat, repeat, true);
}

export function checkerTexture(columns: number, rows: number): THREE.CanvasTexture {
  const cell = 32;
  const canvas = document.createElement('canvas');
  canvas.width = columns * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f2f2f2' : '#161616';
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

export interface LabelOptions {
  /** Canvas size in pixels; match the aspect ratio of the surface it goes on. Default 512×256. */
  width?: number;
  height?: number;
  /** CSS colours of the panel and the text. Default: near-black on off-white. */
  background?: string;
  color?: string;
}

/** A sign face: bold text, as large as fits, centred on a plain panel. */
export function labelTexture(text: string, options: LabelOptions = {}): THREE.CanvasTexture {
  const { width = 512, height = 256, background = '#f4f4f0', color = '#141414' } = options;
  const [canvas, ctx] = makeCanvas(width, height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  // Most of the panel's height, narrowed if the text would run into the sides.
  let size = height * 0.72;
  ctx.font = `800 ${size}px ${LABEL_FONT}`;
  const fit = (width * 0.86) / ctx.measureText(text).width;
  if (fit < 1) {
    size *= fit;
    ctx.font = `800 ${size}px ${LABEL_FONT}`;
  }
  // Centre the ink rather than the em box, so digits sit in the middle of the panel.
  const metrics = ctx.measureText(text);
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(
    text,
    width / 2,
    (height + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2,
  );
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// ---------------------------------------------------------------- race tracks

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/**
 * Neutral, near-grey turf to tint with a material colour, so every track's grass shares one
 * texture. `userData.mean` is its average linear brightness, to divide out of the tint.
 */
export function turfTexture(): THREE.CanvasTexture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  // Mostly fine detail: broad patches would repeat visibly with the tile, so they come from
  // the ground mesh's vertex colours instead.
  const patches = tileableNoise(size, 13, 4, 8);
  const blades = tileableNoise(size, 17, 2, 64);
  const image = ctx.createImageData(size, size);
  let sum = 0;
  for (let i = 0; i < size * size; i++) {
    const n = patches[i]!;
    const v = Math.min(146 + n * 52 + blades[i]! * 56, 255);
    // Patches drift a little towards straw or a cooler green, around neutral.
    const warm = (n - 0.5) * 20;
    image.data[i * 4] = v + warm;
    image.data[i * 4 + 1] = v;
    image.data[i * 4 + 2] = v - warm * 1.5;
    image.data[i * 4 + 3] = 255;
    sum += srgbToLinear(v / 255);
  }
  ctx.putImageData(image, 0, 0);
  const texture = toTexture(canvas, 1, 1, true);
  texture.userData.mean = sum / (size * size);
  return texture;
}

/** Tileable gravel trap: tan stones of mixed sizes and shades on a sandy base. */
export function gravelTexture(): THREE.CanvasTexture {
  const size = 512;
  const [canvas, ctx] = makeCanvas(size);
  const noise = tileableNoise(size, 19, 4, 8);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const v = 0.72 + noise[i]! * 0.36;
    image.data[i * 4] = 176 * v;
    image.data[i * 4 + 1] = 156 * v;
    image.data[i * 4 + 2] = 122 * v;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  const rand = mulberry32(29);
  for (let k = 0; k < 3400; k++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 1.3 + rand() * rand() * 4.5;
    const squash = 0.55 + rand() * 0.45;
    const angle = rand() * Math.PI;
    const shade = 0.62 + rand() * 0.6;
    const warm = rand() * 14;
    const stone = `rgb(${(188 + warm) * shade}, ${170 * shade}, ${(138 - warm) * shade})`;
    // Wrapped copies near the edges keep the tile seamless.
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const cx = x + ox;
        const cy = y + oy;
        if (cx < -r - 2 || cx > size + r + 2 || cy < -r - 2 || cy > size + r + 2) continue;
        ctx.fillStyle = 'rgba(40, 32, 24, 0.35)';
        ctx.beginPath();
        ctx.ellipse(cx + 0.9, cy + 0.9, r, r * squash, angle, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = stone;
        ctx.beginPath();
        ctx.ellipse(cx, cy, r, r * squash, angle, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  return toTexture(canvas, 1, 1, true);
}

/**
 * Barrier wall: panels in `color` under a red and white band along the top. One tile spans a
 * red and a white block along the wall (u) and the wall from its foot (v = 0) to its top (v = 1).
 */
export function barrierTexture(color: number): THREE.CanvasTexture {
  const width = 256;
  const height = 128;
  const [canvas, ctx] = makeCanvas(width, height);
  const band = Math.round(height * 0.26);
  const joint = width / 4;
  const noise = tileableNoise(width, 31, 3, 16);
  // Every pixel computed here and written once: reading a canvas back is slow on some GPUs.
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    // Grime thrown up from the track darkens the foot of the wall.
    const grime = Math.max(0, (y - height * 0.55) / (height * 0.45)) * 0.38;
    for (let x = 0; x < width; x++) {
      let r = (color >> 16) & 255;
      let g = (color >> 8) & 255;
      let b = color & 255;
      if (y < band) {
        // The band: a red block, then a white one.
        [r, g, b] = x < width / 2 ? [212, 42, 32] : [241, 241, 236];
      } else if (y < band + 2 || x % joint < 2) {
        // Shadow under the band, and the joints between metre-wide panels.
        r *= 0.68;
        g *= 0.68;
        b *= 0.68;
      }
      const m = 0.9 + noise[y * width + x]! * 0.2;
      const k = (y * width + x) * 4;
      image.data[k] = (r * (1 - grime) + 20 * grime) * m;
      image.data[k + 1] = (g * (1 - grime) + 18 * grime) * m;
      image.data[k + 2] = (b * (1 - grime) + 16 * grime) * m;
      image.data[k + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = toTexture(canvas, 1, 1, true);
  // The top face samples the band's top row: don't let it wrap round to the foot.
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

/** Seats per crowd tile, and how wide one seat is on the grandstand, metres. */
export const CROWD_SEATS = 16;
export const CROWD_SEAT_WIDTH = 0.5;

/**
 * Spectators on grandstand seating: `rows` rows of `CROWD_SEATS` seats per tile, front row at the
 * bottom (v = 0), shirts and faces in random colours with a few empty seats.
 */
export function crowdTexture(rows: number): THREE.CanvasTexture {
  const seat = 32;
  const width = seat * CROWD_SEATS;
  const height = seat * rows;
  const [canvas, ctx] = makeCanvas(width, height);
  const rand = mulberry32(37);
  const shirts = [
    '#d62828',
    '#f2f2f2',
    '#1d4ed8',
    '#facc15',
    '#f97316',
    '#16a34a',
    '#111827',
    '#e11d48',
    '#0ea5e9',
    '#9ca3af',
    '#7c3aed',
    '#fb7185',
  ];
  const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#ffdbac', '#d9a066'];
  const pick = (list: readonly string[]): string => list[Math.floor(rand() * list.length)]!;
  ctx.fillStyle = '#262c36';
  ctx.fillRect(0, 0, width, height);
  for (let row = 0; row < rows; row++) {
    const floor = (row + 1) * seat;
    // Step edge under each row.
    ctx.fillStyle = '#59606b';
    ctx.fillRect(0, floor - 3, width, 3);
    for (let col = 0; col < CROWD_SEATS; col++) {
      const cx = col * seat + seat / 2 + (rand() - 0.5) * 6;
      if (rand() < 0.12) {
        // Empty seat.
        ctx.fillStyle = '#2f4f86';
        ctx.fillRect(cx - 9, floor - 17, 18, 13);
        continue;
      }
      ctx.fillStyle = pick(shirts);
      ctx.fillRect(cx - 10, floor - 18, 20, 15);
      if (rand() < 0.1) {
        // An arm in the air.
        ctx.fillRect(cx + 7, floor - 31, 4, 14);
      }
      ctx.fillStyle = pick(skins);
      ctx.beginPath();
      ctx.arc(cx + (rand() - 0.5) * 2, floor - 23, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return toTexture(canvas, 1, 1, true);
}

/** Soft round glow for lamps: white, fading out from the centre (in alpha, for additive use). */
export function glowTexture(): THREE.CanvasTexture {
  const size = 128;
  const [canvas, ctx] = makeCanvas(size);
  const half = size / 2;
  const glow = ctx.createRadialGradient(half, half, 0, half, half, half);
  glow.addColorStop(0, 'rgba(255, 255, 255, 1)');
  glow.addColorStop(0.18, 'rgba(255, 255, 255, 0.6)');
  glow.addColorStop(0.45, 'rgba(255, 255, 255, 0.14)');
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
