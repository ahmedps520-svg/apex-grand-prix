import { cityMap, type CityMap } from '../../content/city/map';
import { MAP_MAX_X, MAP_MAX_Z, MAP_MIN_X, MAP_MIN_Z, WATER_X } from '../../content/city/terrain';
import { SURFACE, type RayHit, type Surface, type SurfaceId } from '../track/surface';

/** Soft boundary wall this far inside the map's edge. */
const EDGE = 40;

/** A jump ramp: a wedge rising along its direction from its foot to its lip. */
export interface Ramp {
  x: number;
  z: number;
  /** Road height at the foot. */
  y: number;
  tx: number;
  tz: number;
  length: number;
  rise: number;
  width: number;
}

/**
 * The open world as the physics sees it: a height field with the roads cut into it, the
 * orbital's deck and ramps above it (a wheel finds whichever surface is under it), buildings and
 * big props as walls, barriers along the deck edges and the median, the quay and the map's edge.
 */
export class CitySurface implements Surface {
  gripScale = 1;
  /** The festival's jump ramps (none outside the festival). */
  ramps: Ramp[] = [];

  constructor(readonly map: CityMap = cityMap()) {}

  /** The surface under a point: the deck when the point is up on one, else the ground. */
  heightAt(x: number, z: number, y?: number): number {
    if (y !== undefined && y > 2) {
      const deck = this.map.deckAt(x, z, 0.5);
      if (deck && deck.height <= y + 0.6) return deck.height;
    }
    const ramp = this.rampAt(x, z);
    if (ramp) return Math.max(ramp.height, this.map.groundHeight(x, z));
    return this.map.groundHeight(x, z);
  }

  /** The ramp under a point, with the wedge's height there, or null off every ramp. */
  rampAt(x: number, z: number): { ramp: Ramp; height: number; u: number } | null {
    for (const ramp of this.ramps) {
      const dx = x - ramp.x;
      const dz = z - ramp.z;
      const u = dx * ramp.tx + dz * ramp.tz;
      if (u < 0 || u > ramp.length) continue;
      const v = -dx * ramp.tz + dz * ramp.tx;
      if (Math.abs(v) > ramp.width / 2) continue;
      return { ramp, height: ramp.y + (ramp.rise * u) / ramp.length, u };
    }
    return null;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    return this.map.paved(x, z) ? SURFACE.ASPHALT : SURFACE.GRASS;
  }

  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    hit: RayHit,
  ): boolean {
    let found = false;
    let best = Infinity;
    let nx = 0;
    let ny = 1;
    let nz = 0;
    let surface: SurfaceId = SURFACE.GRASS;

    // The ground: a few fixed-point iterations settle the hit on the height field.
    const map = this.map;
    let gx = ox;
    let gz = oz;
    let gh = map.groundHeight(gx, gz);
    let t = -1;
    if (oy <= gh) t = 0;
    else if (dy < -1e-6) {
      for (let i = 0; i < 3; i++) {
        t = (oy - gh) / -dy;
        gx = ox + dx * t;
        gz = oz + dz * t;
        gh = map.groundHeight(gx, gz);
      }
      t = (oy - gh) / -dy;
    }
    if (t >= 0 && t <= maxDist) {
      found = true;
      best = t;
      const e = 0.5;
      const sx = map.groundHeight(gx + e, gz) - map.groundHeight(gx - e, gz);
      const sz = map.groundHeight(gx, gz + e) - map.groundHeight(gx, gz - e);
      const len = Math.hypot(sx / (2 * e), 1, sz / (2 * e));
      nx = -sx / (2 * e) / len;
      ny = 1 / len;
      nz = -sz / (2 * e) / len;
      surface = this.surfaceAt(gx, gz);
    }

    // The deck over the ray's start (wheel rays are near vertical), when the ray starts on or
    // above it; under it the ground is what counts.
    const deck = map.deckAt(ox, oz, 0.6);
    if (deck && oy >= deck.height - 0.05) {
      const p = deck.piece;
      const grade = (p.by - p.ay) / p.len;
      let dnx = -grade * p.tx;
      let dny = 1;
      let dnz = -grade * p.tz;
      const len = Math.hypot(dnx, dny, dnz);
      dnx /= len;
      dny /= len;
      dnz /= len;
      const denom = dx * dnx + dy * dny + dz * dnz;
      if (denom < -1e-6) {
        const td = Math.max(((deck.height - oy) * dny) / denom, 0);
        if (td <= maxDist && td < best) {
          found = true;
          best = td;
          nx = dnx;
          ny = dny;
          nz = dnz;
          surface = SURFACE.ASPHALT;
        }
      }
    }

    // A jump ramp under the ray's start: its sloped top face, like a small deck.
    const onRamp = this.ramps.length > 0 ? this.rampAt(ox, oz) : null;
    if (onRamp && oy >= onRamp.height - 0.05) {
      const r = onRamp.ramp;
      const grade = r.rise / r.length;
      const len = Math.hypot(grade, 1);
      const rnx = (-grade * r.tx) / len;
      const rny = 1 / len;
      const rnz = (-grade * r.tz) / len;
      const denom = dx * rnx + dy * rny + dz * rnz;
      if (denom < -1e-6) {
        const tr = Math.max(((onRamp.height - oy) * rny) / denom, 0);
        if (tr <= maxDist && tr < best) {
          found = true;
          best = tr;
          nx = rnx;
          ny = rny;
          nz = rnz;
          surface = SURFACE.ASPHALT;
        }
      }
    }

    if (!found) return false;
    hit.distance = best;
    hit.nx = nx;
    hit.ny = ny;
    hit.nz = nz;
    hit.surface = surface;
    return true;
  }

  wallContact(x: number, z: number, out: { nx: number; nz: number }, y = 0): number {
    // The map's edge.
    if (x < MAP_MIN_X + EDGE) return push(out, 1, 0, MAP_MIN_X + EDGE - x);
    if (x > MAP_MAX_X - EDGE) return push(out, -1, 0, x - (MAP_MAX_X - EDGE));
    if (z < MAP_MIN_Z + EDGE) return push(out, 0, 1, MAP_MIN_Z + EDGE - z);
    if (z > MAP_MAX_Z - EDGE) return push(out, 0, -1, z - (MAP_MAX_Z - EDGE));
    // The quay wall.
    if (x > WATER_X - 3 && y < 4) return push(out, -1, 0, x - (WATER_X - 3));

    // Up on the orbital: barriers along both edges and the median.
    if (y > 3) {
      const deck = this.map.deckAt(x, z, 1.5);
      if (!deck) return 0;
      const p = deck.piece;
      const side = deck.lateral >= 0 ? 1 : -1;
      const edge = p.halfWidth - 0.5;
      if (Math.abs(deck.lateral) > edge) {
        return push(out, side * p.tz, -side * p.tx, Math.abs(deck.lateral) - edge);
      }
      if (p.road.kind === 'highway' && Math.abs(deck.lateral) < 1) {
        return push(out, -side * p.tz, side * p.tx, 1 - Math.abs(deck.lateral));
      }
      return 0;
    }

    // Buildings and big props: rotated boxes, pushed out through the nearest face.
    for (const lot of this.map.lotsNear(x, z)) {
      if (lot.y > 0.5) continue;
      const c = Math.cos(lot.yaw);
      const s = Math.sin(lot.yaw);
      const rx = x - lot.x;
      const rz = z - lot.z;
      const lx = rx * c - rz * s;
      const lz = rx * s + rz * c;
      const px = lot.w / 2 - Math.abs(lx);
      const pz = lot.d / 2 - Math.abs(lz);
      if (px <= 0 || pz <= 0) continue;
      if (px < pz) {
        const sx = lx >= 0 ? 1 : -1;
        return push(out, sx * c, -sx * s, px);
      }
      const sz = lz >= 0 ? 1 : -1;
      return push(out, sz * s, sz * c, pz);
    }
    return 0;
  }
}

function push(out: { nx: number; nz: number }, nx: number, nz: number, depth: number): number {
  out.nx = nx;
  out.nz = nz;
  return depth;
}
