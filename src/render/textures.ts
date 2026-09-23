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
