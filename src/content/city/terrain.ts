/**
 * The open world's ground: where each district lies and the natural height of the land before
 * the roads cut into it. Pure functions (no three.js), shared by the simulation and the renderer,
 * so both see exactly the same ground.
 *
 * Axes: x east, z south (three.js: +z towards the viewer); "north" is −z.
 */

export type DistrictKind =
  'downtown' | 'suburb' | 'port' | 'hills' | 'circuit' | 'fields' | 'water';

/** The map's edges (a soft wall keeps the car inside). */
export const MAP_MIN_X = -1800;
export const MAP_MAX_X = 1800;
export const MAP_MIN_Z = -2800;
export const MAP_MAX_Z = 1800;
/** The quay: sea east of this. */
export const WATER_X = 1450;
/** Sea level (the ground drops below it past the quay). */
export const WATER_Y = -0.8;

/** Downtown's core (towers) and its outskirts, which reach the orbital highway. */
export const DOWNTOWN_HALF = 450;
export const RING_HALF = 600;

export const smooth01 = (t: number): number => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

export function districtAt(x: number, z: number): DistrictKind {
  if (x > WATER_X) return 'water';
  if (Math.abs(x) <= RING_HALF && Math.abs(z) <= RING_HALF) return 'downtown';
  if (x >= -1600 && x <= -750 && z >= -650 && z <= 750) return 'suburb';
  if (x >= 750 && x <= WATER_X && z >= -550 && z <= 550) return 'port';
  if (z < -750 && Math.abs(x) <= 1000) return 'hills';
  if (z > 750 && z < 1700 && x >= -600 && x <= 700) return 'circuit';
  return 'fields';
}

/**
 * Natural ground height, metres: flat through the city, the port and the suburbs, rising to a
 * ridge in the north (the mountain road climbs it) and dropping into the sea past the quay.
 */
export function terrainHeight(x: number, z: number): number {
  let h = 0;
  if (z < -700) {
    // 0 at the interchange, 1 at the ridge; the flanks fall away east and west.
    const t = smooth01((-z - 700) / 1800);
    const flank = smooth01(1 - (Math.abs(x) - 600) / 500);
    h += 150 * t * t * (0.35 + 0.65 * flank);
    // Rolling detail, fading in past the interchange so the approach stays flat.
    const detail = smooth01((-z - 800) / 200);
    h +=
      detail *
      (6 * Math.sin(x * 0.011) * Math.sin(z * 0.013) + 3 * Math.sin(x * 0.031 + z * 0.017));
  }
  if (x > WATER_X) h -= 6 * smooth01((x - WATER_X) / 30);
  return h;
}
