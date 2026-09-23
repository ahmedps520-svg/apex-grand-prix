import { CARS, type CarModel } from '../../sim/vehicle/cars';

/**
 * The traffic fleet: which car fills each traffic slot and what colour it wears. Both the
 * simulation worker (which drives the slots) and the renderer (which draws them) read it, so
 * a slot's body and paint agree without anything crossing the thread boundary.
 */

/** Everyday cars only: sedans, street cars and SUVs, never the racing classes. */
export const TRAFFIC_MODELS: readonly CarModel[] = CARS.filter(
  (c) => c.className === 'Street' || c.className === 'Touring' || c.className === 'SUV',
);

/** Plain paints, the way real traffic looks: mostly white, silver, grey and black. */
export const TRAFFIC_PAINTS: readonly number[] = [
  0xe8e9ea, 0xc4c8cc, 0x2a2c30, 0x6a6e73, 0x1f3a6b, 0xb3231d, 0xd9cfb8, 0x2f5d3a, 0xeeeff0,
  0x8d9298, 0x3b3d42, 0x5d4a3a,
];

export function trafficModel(slot: number): CarModel {
  return TRAFFIC_MODELS[(slot * 7) % TRAFFIC_MODELS.length] ?? CARS[0]!;
}

export function trafficPaint(slot: number): number {
  return TRAFFIC_PAINTS[(slot * 5) % TRAFFIC_PAINTS.length]!;
}

/** Traffic slots for a detail level (how many cars share the world with the player). */
export function trafficSlotsFor(chunks: number): number {
  return chunks <= 2 ? 8 : chunks === 3 ? 14 : 20;
}
