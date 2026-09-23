import type { CarRenderState } from '../render/interpolate';

/**
 * Time trial ghosts: the player's best lap on each circuit, recorded as a car pose every 50 ms
 * and replayed as a see-through car. The best ghost per circuit is kept in this browser.
 */

const HZ = 20;
/** Floats per sample: position (3) and rotation (4). */
const STRIDE = 7;
/** Laps longer than this aren't recorded (keeps storage bounded). */
const MAX_SECONDS = 600;
const KEY = 'apex-gp.ghost.';

export interface GhostLap {
  trackId: string;
  carId: string;
  paint: number;
  lapTime: number;
  /** Poses at 20 Hz from the start of the lap: x, y, z, qx, qy, qz, qw. */
  data: Float32Array;
}

/** Records the lap being driven. */
export class GhostRecorder {
  private data = new Float32Array(MAX_SECONDS * HZ * STRIDE);
  private count = 0;

  /** Starts a new lap. */
  reset(): void {
    this.count = 0;
  }

  /** `lapTime` is the time on the lap being driven; samples are taken every 50 ms. */
  record(lapTime: number, state: CarRenderState): void {
    const index = Math.floor(lapTime * HZ);
    if (index < this.count || index >= MAX_SECONDS * HZ) return;
    // Fill every slot up to now, so a slow frame doesn't leave holes.
    while (this.count <= index) {
      const o = this.count * STRIDE;
      const d = this.data;
      d[o] = state.pos.x;
      d[o + 1] = state.pos.y;
      d[o + 2] = state.pos.z;
      d[o + 3] = state.rot.x;
      d[o + 4] = state.rot.y;
      d[o + 5] = state.rot.z;
      d[o + 6] = state.rot.w;
      this.count++;
    }
  }

  /** The recorded lap, or null if it was too short to be a real lap. */
  finish(trackId: string, carId: string, paint: number, lapTime: number): GhostLap | null {
    if (this.count < HZ * 5 || lapTime <= 0) return null;
    return { trackId, carId, paint, lapTime, data: this.data.slice(0, this.count * STRIDE) };
  }
}

/** Puts the ghost's pose at `time` into `out` (position and rotation only). */
export function sampleGhost(ghost: GhostLap, time: number, out: CarRenderState): boolean {
  const samples = ghost.data.length / STRIDE;
  if (samples < 2 || time < 0 || time > ghost.lapTime) return false;
  const f = Math.min(time * HZ, samples - 1.0001);
  const i = Math.floor(f);
  const t = f - i;
  const d = ghost.data;
  const a = i * STRIDE;
  const b = a + STRIDE;
  const mix = (k: number) => d[a + k]! + (d[b + k]! - d[a + k]!) * t;
  out.pos.x = mix(0);
  out.pos.y = mix(1);
  out.pos.z = mix(2);
  // Normalised lerp, taking the short way round.
  const dot =
    d[a + 3]! * d[b + 3]! + d[a + 4]! * d[b + 4]! + d[a + 5]! * d[b + 5]! + d[a + 6]! * d[b + 6]!;
  const s = dot < 0 ? -1 : 1;
  const qx = d[a + 3]! + (s * d[b + 3]! - d[a + 3]!) * t;
  const qy = d[a + 4]! + (s * d[b + 4]! - d[a + 4]!) * t;
  const qz = d[a + 5]! + (s * d[b + 5]! - d[a + 5]!) * t;
  const qw = d[a + 6]! + (s * d[b + 6]! - d[a + 6]!) * t;
  const n = Math.hypot(qx, qy, qz, qw) || 1;
  out.rot.x = qx / n;
  out.rot.y = qy / n;
  out.rot.z = qz / n;
  out.rot.w = qw / n;
  const dx = d[b]! - d[a]!;
  const dz = d[b + 2]! - d[a + 2]!;
  out.speed = Math.hypot(dx, dz) * HZ;
  return true;
}

function encode(data: Float32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function decode(text: string): Float32Array | null {
  const raw = atob(text);
  if (raw.length % 4 !== 0) return null;
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const data = new Float32Array(bytes.buffer);
  return data.length % STRIDE === 0 && data.every(Number.isFinite) ? data : null;
}

/** The stored ghost for a circuit, or null. */
export function loadGhost(trackId: string): GhostLap | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY + trackId) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const g = raw as Record<string, unknown>;
    if (
      typeof g.carId !== 'string' ||
      typeof g.lapTime !== 'number' ||
      typeof g.data !== 'string'
    ) {
      return null;
    }
    const data = decode(g.data);
    if (!data || !(g.lapTime > 0)) return null;
    const paint = typeof g.paint === 'number' ? g.paint : 0xffffff;
    return { trackId, carId: g.carId, paint, lapTime: g.lapTime, data };
  } catch {
    return null;
  }
}

export function saveGhost(ghost: GhostLap): void {
  try {
    const { trackId, carId, paint, lapTime, data } = ghost;
    localStorage.setItem(
      KEY + trackId,
      JSON.stringify({ carId, paint, lapTime, data: encode(data) }),
    );
  } catch {
    // Storage full or blocked: the ghost lasts for this session only.
  }
}
