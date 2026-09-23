import type { Track } from '../track/Track';

/** Where a point is along the track (as `Track.project` reports it), reusable between steps. */
export interface TrackPos {
  /** Distance along the lap, metres (0 … length). */
  s: number;
  /** Signed distance from the centre line, metres (> 0 = right of the driving direction). */
  lateral: number;
  /** Nearest centre-line sample. */
  index: number;
}

export const trackPos = (): TrackPos => ({ s: 0, lateral: 0, index: -1 });

/** Further than this from the sample found near the hint, the point is looked up from scratch. */
const LOST = 40;

/**
 * `Track.project` without allocating, for points that move a little between calls: walks along
 * the centre line from sample `hint` to the nearest sample. Falls back to the full search when
 * there is no hint or the point is far from where the hint led.
 */
export function projectNear(
  track: Track,
  x: number,
  z: number,
  hint: number,
  out: TrackPos,
): TrackPos {
  const samples = track.samples;
  const n = samples.length;
  let best = -1;
  if (hint >= 0 && hint < n) {
    // The distance to a smooth centre line has a single minimum near a good hint.
    best = hint;
    let bestD = dist2(track, hint, x, z);
    for (let k = 0; k < n; k++) {
      const next = best + 1 === n ? 0 : best + 1;
      const d = dist2(track, next, x, z);
      if (d >= bestD) break;
      bestD = d;
      best = next;
    }
    if (best === hint) {
      for (let k = 0; k < n; k++) {
        const prev = best === 0 ? n - 1 : best - 1;
        const d = dist2(track, prev, x, z);
        if (d >= bestD) break;
        bestD = d;
        best = prev;
      }
    }
    if (bestD > LOST * LOST) best = -1;
  }
  if (best < 0) best = track.project(x, z).index;
  const p = samples[best]!;
  const dx = x - p.x;
  const dz = z - p.z;
  let s = p.s + dx * p.tx + dz * p.tz;
  if (s < 0) s += track.length;
  else if (s >= track.length) s -= track.length;
  out.s = s;
  out.lateral = dx * -p.tz + dz * p.tx;
  out.index = best;
  return out;
}

function dist2(track: Track, i: number, x: number, z: number): number {
  const p = track.samples[i]!;
  const dx = p.x - x;
  const dz = p.z - z;
  return dx * dx + dz * dz;
}

/** Wraps a distance difference along the lap into [-length/2, length/2). */
export function wrapDelta(ds: number, length: number): number {
  if (ds >= length / 2) return ds - length;
  if (ds < -length / 2) return ds + length;
  return ds;
}
