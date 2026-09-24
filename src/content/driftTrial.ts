/**
 * Drift trials: laps of a circuit with arcade handling where the drifts score. The medal targets
 * scale with the lap's length and the laps run: drift points per kilometre of lap.
 */

export type DriftMedal = 'gold' | 'silver' | 'bronze';

export interface DriftTargets {
  gold: number;
  silver: number;
  bronze: number;
}

/** Drift points per kilometre of lap for each medal (a first guess, to tune from play). */
export const DRIFT_PER_KM: DriftTargets = { gold: 1400, silver: 800, bronze: 400 };

/** The medal targets for a circuit of `trackLength` metres over `laps` laps. */
export function driftTargets(trackLength: number, laps: number): DriftTargets {
  const km = (Math.max(trackLength, 500) / 1000) * Math.max(Math.floor(laps), 1);
  const round = (v: number) => Math.round(v / 50) * 50;
  return {
    gold: round(DRIFT_PER_KM.gold * km),
    silver: round(DRIFT_PER_KM.silver * km),
    bronze: round(DRIFT_PER_KM.bronze * km),
  };
}

/** The medal a score earns against the targets, or null. */
export function driftMedal(score: number, targets: DriftTargets): DriftMedal | null {
  if (score >= targets.gold) return 'gold';
  if (score >= targets.silver) return 'silver';
  if (score >= targets.bronze) return 'bronze';
  return null;
}
