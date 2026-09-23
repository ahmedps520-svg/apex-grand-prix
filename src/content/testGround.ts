/**
 * Layout of the proving ground: a painted loop, a 1 km drag strip and a skidpad on a large
 * asphalt pad. Shared by the simulation (spawn points) and the renderer (markings, cones).
 * Coordinates are world metres on the ground plane (x right, z towards the camera at spawn).
 */

import type { SpawnPoint } from '../shared/protocol';

/** The asphalt pad is a rectangle: ±PAD_HALF_X by ±PAD_HALF_Z metres. */
export const PAD_HALF_X = 420;
export const PAD_HALF_Z = 720;

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

/** Spawn on the loop's start line, facing along the main straight (-z). Yaw 0 = facing -z. */
export const SPAWN = { x: 0, z: 120, yaw: 0 } as const;

/** A slalom row of cones beside the main straight, metres. */
export const SLALOM = { x: -30, zStart: 100, zEnd: -120, spacing: 18 } as const;

/**
 * Drag strip: 1 km from the start line (at zStart) towards -z, boards every 100 m, then a
 * braking zone to the end of the pad.
 */
export const DRAG_STRIP = {
  x: -110,
  zStart: 640,
  length: 1000,
  halfWidth: 7,
  /** Painted boards every this many metres. */
  markerSpacing: 100,
} as const;

/** Constant-radius circle for steady-state cornering tests (radius of the painted line). */
export const SKIDPAD = { x: -290, z: -420, radius: 60, halfWidth: 5 } as const;

/** Where each teleport key puts the car. */
export const SPAWNS: Record<SpawnPoint, { x: number; z: number; yaw: number }> = {
  loop: SPAWN,
  drag: { x: DRAG_STRIP.x, z: DRAG_STRIP.zStart + 6, yaw: 0 },
  // On the circle's east side, facing -z: driving forward goes anticlockwise seen from above,
  // which is a left-hand turn.
  skidpad: { x: SKIDPAD.x + SKIDPAD.radius, z: SKIDPAD.z, yaw: 0 },
};
