import * as THREE from 'three/webgpu';
import {
  clamp,
  float,
  mix,
  normalMap,
  positionWorld,
  smoothstep,
  texture,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { mulberry32 } from '../shared/math';
import { reflective } from './Effects';
import { tileableNoise } from './textures';

/** How a scene lays its roads: the plain textures, or the detailed asphalt at a map size. */
export interface RoadLook {
  detailed: boolean;
  /** Asphalt map size, 512 or 1024. */
  size: number;
}

export const PLAIN_ROAD: RoadLook = { detailed: false, size: 512 };

/** Metres of road one tile of the asphalt maps covers. */
export const ASPHALT_TILE = 7;
/** Metres per tile of the noise that decides where water stands on a wet road. */
const PUDDLE_TILE = 37;

/** Baked asphalt: RGBA bytes, `size` × `size`, tileable in both directions. */
export interface AsphaltData {
  size: number;
  /** sRGB colour: a dark, weathered binder with the aggregate showing through. */
  albedo: Uint8Array;
  /** Tangent-space normal, 0–255 per axis (128 = flat). */
  normal: Uint8Array;
  /** Linear roughness (every colour channel; three reads green). */
  rough: Uint8Array;
}

const byte = (v: number): number => Math.min(255, Math.max(0, Math.round(v)));

/**
 * Asphalt as it is laid: stones of aggregate (5–25 mm, grey to buff, polished by the tyres)
 * set in a dark bitumen binder with its own grain, over a soft tonal wander. Deterministic.
 */
export function bakeAsphalt(size: number, seed = 7): AsphaltData {
  const n = size * size;
  const rand = mulberry32(seed);
  // Pixels per 6.8 mm (a 1024 map over a 7 m tile).
  const px = size / 1024;
  const soft = tileableNoise(size, seed + 1, 4, 4);
  const grain = tileableNoise(size, seed + 2, 2, Math.max(16, size / 4));
  const stone = new Float32Array(n);
  const tone = new Float32Array(n);
  const tint = new Float32Array(n);
  const height = new Float32Array(n);
  const count = Math.round(n / 34);
  for (let k = 0; k < count; k++) {
    const cx = rand() * size;
    const cy = rand() * size;
    // Mostly small stones and a few large ones.
    const r = (0.9 + 3 * rand() * rand() * rand()) * Math.max(px, 0.5);
    const exposed = 0.35 + 0.65 * rand();
    const bright = rand();
    const warm = rand() * 2 - 1;
    const proud = exposed * Math.min(1, r / (2 * Math.max(px, 0.5)));
    const reach = Math.ceil(r + 1);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    for (let dy = -reach; dy <= reach; dy++) {
      const y = y0 + dy;
      const fy = y + 0.5 - cy;
      const row = (((y % size) + size) % size) * size;
      for (let dx = -reach; dx <= reach; dx++) {
        const x = x0 + dx;
        const fx = x + 0.5 - cx;
        const d = Math.sqrt(fx * fx + fy * fy);
        const cover = Math.min(Math.max(r + 0.5 - d, 0), 1) * exposed;
        if (cover <= 0) continue;
        const i = row + (((x % size) + size) % size);
        if (cover > stone[i]!) {
          stone[i] = cover;
          tone[i] = bright;
          tint[i] = warm;
        }
        const dome = d < r ? Math.sqrt(1 - (d * d) / (r * r)) * proud : 0;
        if (dome > height[i]!) height[i] = dome;
      }
    }
  }
  const albedo = new Uint8Array(n * 4);
  const rough = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = soft[i]!;
    const g = grain[i]!;
    const st = stone[i]!;
    const binder = 62 + (s - 0.5) * 20 + (g - 0.5) * 14;
    // The stones under a film of binder and road dirt: lighter, but not white.
    const bright = 80 + tone[i]! * 60;
    const v = binder + (bright - binder) * st * 0.75;
    const t = tint[i]! * st;
    albedo[i * 4] = byte(v * (1 + 0.05 * t));
    albedo[i * 4 + 1] = byte(v * (1 + 0.01 * t));
    albedo[i * 4 + 2] = byte(v * (1 - 0.06 * t));
    albedo[i * 4 + 3] = 255;
    // The binder dull, the aggregate polished by the tyres.
    const r = 0.94 - st * (0.22 + 0.12 * tone[i]!) + (g - 0.5) * 0.06;
    const rb = byte(r * 255);
    rough[i * 4] = rb;
    rough[i * 4 + 1] = rb;
    rough[i * 4 + 2] = rb;
    rough[i * 4 + 3] = 255;
    height[i] = height[i]! + (s - 0.5) * 0.25 + (g - 0.5) * 0.3;
  }
  const normal = new Uint8Array(n * 4);
  const k = 1;
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size;
    const down = ((y + 1) % size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const left = (x + size - 1) % size;
      const right = (x + 1) % size;
      const dx = (height[row + right]! - height[row + left]!) * k;
      const dy = (height[down + x]! - height[up + x]!) * k;
      const len = Math.sqrt(dx * dx + dy * dy + 1);
      const i = (row + x) * 4;
      normal[i] = byte((-dx / len) * 127.5 + 127.5);
      normal[i + 1] = byte((-dy / len) * 127.5 + 127.5);
      normal[i + 2] = byte((1 / len) * 127.5 + 127.5);
      normal[i + 3] = 255;
    }
  }
  return { size, albedo, normal, rough };
}

/** The asphalt's textures: `size` 512 or 1024. */
export interface AsphaltMaps {
  albedo: THREE.DataTexture;
  normal: THREE.DataTexture;
  rough: THREE.DataTexture;
}

function dataTexture(data: Uint8Array, width: number, height: number, srgb: boolean) {
  const t = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Baked once per size and kept for the whole visit (the circuits and the city share them). */
const maps = new Map<number, AsphaltMaps>();

export function asphaltMaps(size: number): AsphaltMaps {
  let m = maps.get(size);
  if (!m) {
    const d = bakeAsphalt(size);
    m = {
      albedo: dataTexture(d.albedo, size, size, true),
      normal: dataTexture(d.normal, size, size, false),
      rough: dataTexture(d.rough, size, size, false),
    };
    maps.set(size, m);
  }
  return m;
}

/** Lateral texels across the road in the rubber map. */
export const RUBBER_ACROSS = 32;
/** The widest the rubber map runs along the lap (texture width limit). */
const RUBBER_ALONG_MAX = 4096;

/** What the rubber is laid from: the racing line, sample by sample, and the grid. */
export interface RubberInput {
  /** Lap length, metres. */
  length: number;
  /** Half the width the map covers (the road and its kerbs), metres. */
  apron: number;
  /** The line's offset from the centre line per sample, metres (> 0 = right). */
  lateral: ArrayLike<number>;
  /** The line's speed per sample, m/s. */
  speed: ArrayLike<number>;
  /** Grid boxes: distance along the lap and offset from the centre line. */
  grid?: ReadonlyArray<{ s: number; lateral: number }>;
}

/** The rubber map: `along` × RUBBER_ACROSS amounts, 0 … 1 (bytes). */
export interface RubberData {
  along: number;
  across: number;
  amount: Uint8Array;
}

const gauss = (d: number, sigma: number) => Math.exp((-d * d) / (2 * sigma * sigma));

/**
 * The racing line rubbered in: a band where the cars run, darkest along the two wheel tracks,
 * heavier where they brake hard and through the apexes, with launch marks on the grid.
 */
export function bakeRubber(input: RubberInput): RubberData {
  const samples = input.lateral.length;
  const along = Math.min(samples, RUBBER_ALONG_MAX);
  const across = RUBBER_ACROSS;
  const step = input.length / samples;
  // How hard the cars work the road at each sample: braking and cornering lay more rubber.
  const work = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const v = input.speed[i]!;
    const next = input.speed[(i + 1) % samples]!;
    const decel = (v * v - next * next) / (2 * step);
    work[i] = 0.62 + 0.38 * Math.min(Math.max(decel / 10, 0), 1);
  }
  // Rubber builds up over a stretch, not a sample: smooth it along the lap.
  const smooth = new Float32Array(samples);
  const window = Math.max(1, Math.round(12 / step));
  for (let i = 0; i < samples; i++) {
    let sum = 0;
    for (let k = -window; k <= window; k++) sum += work[(i + k + samples) % samples]!;
    smooth[i] = sum / (2 * window + 1);
  }
  const amount = new Uint8Array(along * across * 4);
  const put = (a: number, j: number, value: number) => {
    const o = (j * along + a) * 4;
    const b = byte(Math.min(1, value) * 255);
    if (b <= amount[o]!) return;
    amount[o] = b;
    amount[o + 1] = b;
    amount[o + 2] = b;
    amount[o + 3] = 255;
  };
  for (let a = 0; a < along; a++) {
    const i = Math.min(samples - 1, Math.floor(((a + 0.5) / along) * samples));
    const centre = input.lateral[i]!;
    const w = smooth[i]!;
    for (let j = 0; j < across; j++) {
      const lat = -input.apron + ((j + 0.5) / across) * 2 * input.apron;
      const d = lat - centre;
      const tracks = Math.max(gauss(d - 0.8, 0.38), gauss(d + 0.8, 0.38));
      put(a, j, w * (0.5 * gauss(d, 1.2) + 0.55 * tracks));
    }
  }
  // Launch marks: the rear wheels spun up off every grid box.
  for (const slot of input.grid ?? []) {
    for (let m = -2; m <= 10; m += step / 2) {
      const s = (((slot.s + m) % input.length) + input.length) % input.length;
      const a = Math.min(along - 1, Math.floor((s / input.length) * along));
      const fade = 1 - (m + 2) / 12;
      for (let j = 0; j < across; j++) {
        const lat = -input.apron + ((j + 0.5) / across) * 2 * input.apron;
        const d = lat - slot.lateral;
        const tracks = Math.max(gauss(d - 0.8, 0.25), gauss(d + 0.8, 0.25));
        put(a, j, 0.85 * fade * tracks);
      }
    }
  }
  return { along, across, amount };
}

export function rubberTexture(data: RubberData): THREE.DataTexture {
  const t = dataTexture(data.amount, data.along, data.across, false);
  // Along the lap it wraps; across the road it stops at the kerbs.
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  return t;
}

export interface RoadOptions {
  maps: AsphaltMaps;
  /** Road wetness, 0 dry … 1 standing water. */
  wet: THREE.UniformNode<'float', number>;
  /** Tileable noise: where water stands, and the tone and patches across the road. */
  puddles: THREE.Texture;
  noise: THREE.Texture;
  /**
   * The mesh's UVs are metres / `tile` (along the lap, across the road): the maps follow
   * the road and the rubber can be found. Without it the maps are laid in world space.
   */
  tile?: number;
  rubber?: { texture: THREE.Texture; length: number; apron: number };
  /** Material parameters (the flat layers' polygon offset). */
  params?: THREE.MeshStandardNodeMaterialParameters;
}

/**
 * Realistic road: the baked asphalt twice over (a second look-up, turned and scaled, blended in
 * patches so the tiles never repeat), a tonal wander and the odd darker repair, the racing line
 * rubbered in and streaked along the direction of travel, and in the wet a darker, glossy
 * surface with standing water in the dips. The surface asks for screen-space reflections by
 * how wet it is.
 */
export function detailedRoad(o: RoadOptions): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0, ...o.params });
  const metres = o.tile ? uv().mul(o.tile) : positionWorld.xz;
  const t1 = metres.div(ASPHALT_TILE);
  const t2 = vec2(t1.x.mul(0.8).sub(t1.y.mul(0.6)), t1.x.mul(0.6).add(t1.y.mul(0.8)))
    .mul(0.71)
    .add(vec2(0.37, 0.19));
  const wander = texture(o.noise, positionWorld.xz.div(61)).r;
  const patches = texture(o.noise, positionWorld.xz.div(23).add(0.5)).r;
  const blend = smoothstep(0.4, 0.6, wander);
  const albedo = mix(texture(o.maps.albedo, t1).rgb, texture(o.maps.albedo, t2).rgb, blend);
  const baseRough = mix(texture(o.maps.rough, t1).g, texture(o.maps.rough, t2).g, blend);
  let bumps = mix(texture(o.maps.normal, t1).xyz, texture(o.maps.normal, t2).xyz, blend);
  const repair = smoothstep(0.66, 0.7, patches).mul(0.22);
  let colour = albedo.mul(mix(0.86, 1.12, wander)).mul(float(1).sub(repair));
  let rough = baseRough.add(wander.sub(0.5).mul(0.06)).sub(repair.mul(0.1));
  if (o.rubber && o.tile) {
    const r = o.rubber;
    const along = uv().x.mul(o.tile / r.length);
    const across = uv()
      .y.mul(o.tile)
      .add(r.apron)
      .div(2 * r.apron);
    const laid = texture(r.texture, vec2(along, across)).r;
    // Streaks along the direction of travel, where the tyres wipe the rubber on.
    const streak = texture(o.noise, vec2(uv().x.mul(o.tile / 29), uv().y.mul(o.tile / 0.55))).r;
    const rubber = clamp(laid.mul(streak.mul(0.9).add(0.45)), 0, 1);
    colour = colour.mul(mix(1, 0.3, rubber));
    rough = mix(rough, 0.62, rubber.mul(0.7));
    bumps = mix(bumps, vec3(0.5, 0.5, 1), rubber.mul(0.6));
  }
  const water = texture(o.puddles, positionWorld.xz.div(PUDDLE_TILE)).r;
  const puddle = smoothstep(0.64, 0.8, water).mul(smoothstep(0.5, 1, o.wet));
  m.colorNode = colour.mul(mix(1, 0.5, o.wet)).mul(mix(1, 0.72, puddle));
  const roughness = mix(rough, mix(0.2, 0.04, puddle), o.wet);
  m.roughnessNode = roughness;
  // Standing water lies flat over the stones.
  m.normalNode = normalMap(bumps, vec2(float(0.7).mul(float(1).sub(puddle))));
  reflective(m, float(0.03).add(o.wet.mul(0.5)).add(puddle.mul(0.35)), roughness);
  return m;
}
