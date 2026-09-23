/**
 * Layout of the Round 1 test ground: a painted loop on a large asphalt pad. Shared by the
 * simulation (spawn point) and the renderer (painted lines, cones).
 * Coordinates are world metres on the ground plane (x right, z towards the camera at spawn).
 */

export const PAD_HALF_SIZE = 350;

/** Closed centre line of the painted loop, in driving order. */
export const LOOP_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0, 140],
  [0, 40],
  [0, -80],
  [0, -170],
  [25, -215],
  [85, -228],
  [125, -190],
  [112, -130],
  [140, -70],
  [112, -10],
  [145, 55],
  [195, 110],
  [175, 185],
  [100, 212],
  [35, 195],
];

/** Painted road width between the edge lines. */
export const LOOP_WIDTH = 12;

/** Spawn on the start line, facing along the main straight (-z). Yaw 0 = facing -z. */
export const SPAWN = { x: 0, z: 120, yaw: 0 } as const;

/** A slalom row of cones beside the main straight, metres. */
export const SLALOM = { x: -30, zStart: 100, zEnd: -120, spacing: 18 } as const;
