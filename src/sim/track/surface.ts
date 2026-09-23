/**
 * Ground surfaces the physics can query. Round 1 only has the flat test ground; Round 4 adds the
 * spline-based track surface behind the same interface.
 */

export const SURFACE = {
  ASPHALT: 0,
  GRASS: 1,
} as const;
export type SurfaceId = (typeof SURFACE)[keyof typeof SURFACE];

export interface SurfaceProps {
  name: string;
  /** Multiplier on tyre peak friction. */
  grip: number;
  /** Rolling-resistance coefficient (force = coefficient × normal load). */
  rollingResistance: number;
}

export const SURFACE_PROPS: Record<SurfaceId, SurfaceProps> = {
  [SURFACE.ASPHALT]: { name: 'asphalt', grip: 1, rollingResistance: 0.012 },
  [SURFACE.GRASS]: { name: 'grass', grip: 0.6, rollingResistance: 0.07 },
};

export interface RayHit {
  /** Distance from the ray origin to the ground along the ray. */
  distance: number;
  /** Ground normal (unit length). */
  nx: number;
  ny: number;
  nz: number;
  surface: SurfaceId;
}

export const rayHit = (): RayHit => ({
  distance: 0,
  nx: 0,
  ny: 1,
  nz: 0,
  surface: SURFACE.ASPHALT,
});

export interface Surface {
  /**
   * Casts a ray (direction must be unit length). Returns false if the ground is further than
   * maxDist. If the origin is already below the ground, reports a hit at distance 0.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    hit: RayHit,
  ): boolean;
  heightAt(x: number, z: number): number;
  surfaceAt(x: number, z: number): SurfaceId;
}

/** Flat test ground: a square asphalt pad surrounded by grass, all at height 0. */
export class TestGround implements Surface {
  constructor(readonly padHalfSize = 350) {}

  heightAt(): number {
    return 0;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    return Math.abs(x) <= this.padHalfSize && Math.abs(z) <= this.padHalfSize
      ? SURFACE.ASPHALT
      : SURFACE.GRASS;
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
    let t: number;
    if (oy <= 0) {
      t = 0;
    } else {
      if (dy >= -1e-6) return false;
      t = oy / -dy;
      if (t > maxDist) return false;
    }
    hit.distance = t;
    hit.nx = 0;
    hit.ny = 1;
    hit.nz = 0;
    hit.surface = this.surfaceAt(ox + dx * t, oz + dz * t);
    return true;
  }
}
