import { PAD_HALF_X, PAD_HALF_Z } from '../../content/testGround';

/**
 * Ground surfaces the physics can query. Round 1 only has the flat test ground; Round 4 adds the
 * spline-based track surface behind the same interface.
 */

export const SURFACE = {
  ASPHALT: 0,
  GRASS: 1,
  KERB: 2,
  GRAVEL: 3,
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
  [SURFACE.KERB]: { name: 'kerb', grip: 0.92, rollingResistance: 0.02 },
  [SURFACE.GRAVEL]: { name: 'gravel', grip: 0.45, rollingResistance: 0.28 },
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
  /**
   * Optional barriers: how far a body point is through a wall (0 = clear) and the horizontal
   * direction that pushes it back out.
   */
  wallContact?(x: number, z: number, out: { nx: number; nz: number }): number;
  /** Multiplier on every surface's grip (a wet track is below 1). */
  gripScale?: number;
}

/** Flat test ground: a rectangular asphalt pad surrounded by grass, all at height 0. */
export class TestGround implements Surface {
  constructor(
    readonly halfX = PAD_HALF_X,
    readonly halfZ = PAD_HALF_Z,
  ) {}

  heightAt(): number {
    return 0;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    return Math.abs(x) <= this.halfX && Math.abs(z) <= this.halfZ ? SURFACE.ASPHALT : SURFACE.GRASS;
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

/**
 * An endless asphalt slope for tests: the ground rises towards -z (a car with yaw 0 faces
 * uphill) by `grade` metres per metre.
 */
export class SlopeGround implements Surface {
  private readonly nx = 0;
  private readonly ny: number;
  private readonly nz: number;

  constructor(readonly grade: number) {
    const len = Math.sqrt(1 + grade * grade);
    this.ny = 1 / len;
    this.nz = grade / len;
  }

  heightAt(_x: number, z: number): number {
    return -this.grade * z;
  }

  surfaceAt(): SurfaceId {
    return SURFACE.ASPHALT;
  }

  raycast(
    _ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDist: number,
    hit: RayHit,
  ): boolean {
    // Plane through the origin with normal n: n·p = 0.
    const above = this.ny * oy + this.nz * oz;
    let t: number;
    if (above <= 0) {
      t = 0;
    } else {
      const along = this.ny * dy + this.nz * dz + this.nx * dx;
      if (along >= -1e-6) return false;
      t = above / -along;
      if (t > maxDist) return false;
    }
    hit.distance = t;
    hit.nx = this.nx;
    hit.ny = this.ny;
    hit.nz = this.nz;
    hit.surface = SURFACE.ASPHALT;
    return true;
  }
}
