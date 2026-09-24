/**
 * The pit lane every circuit has beside its start straight, as the simulation drives it and
 * the scenery draws it: it leaves the track before the line, runs on the left past the box,
 * and rejoins after the line.
 */

/** Metres before the line the lane leaves the track, the box sits, and (after) it rejoins. */
export const PIT_ENTRY = 300;
export const PIT_BOX = 90;
export const PIT_EXIT = 80;
/** Metres over which the lane moves across, at each end. */
export const PIT_BLEND = 70;
/** How far beyond the track's half width the lane's centre runs, to the left. */
export const PIT_OFFSET = 4.5;
export const PIT_LANE_HALF_WIDTH = 2.2;
/** The lane's speed limit, m/s, and the stop's length, s. */
export const PIT_SPEED = 22;
export const PIT_TIME = 4;
/** Metres of lane from the entry to the exit. */
export const PIT_LENGTH = PIT_ENTRY + PIT_EXIT;

export type PitPhase = 'none' | 'armed' | 'in' | 'stop' | 'out';

/** A car's pit stop as the HUD sees it. */
export interface PitInfo {
  phase: PitPhase;
  /** Seconds left in the stop. */
  timer: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** How far across the lane is `d` metres from its entry: 0 on the track, 1 in the lane. */
export function laneShare(d: number): number {
  if (d <= 0) return 0;
  if (d < PIT_BLEND) return smooth(d / PIT_BLEND);
  if (d <= PIT_LENGTH - PIT_BLEND) return 1;
  if (d < PIT_LENGTH) return smooth((PIT_LENGTH - d) / PIT_BLEND);
  return 0;
}
