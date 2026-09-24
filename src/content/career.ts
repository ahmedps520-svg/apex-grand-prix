import type { Difficulty } from '../shared/protocol';

/**
 * The career: a ladder of series, one class each, from street cars to formula cars. Each is a
 * championship season; finish it high enough and the next series opens.
 */
export interface CareerTier {
  id: string;
  name: string;
  className: string;
  races: number;
  laps: number;
  opponents: number;
  difficulty: Difficulty;
  /** Finish the season this high (or better) to move up. */
  promote: number;
}

export const CAREER_TIERS: readonly CareerTier[] = [
  {
    id: 'street',
    name: 'Street Series',
    className: 'Street',
    races: 3,
    laps: 2,
    opponents: 7,
    difficulty: 'easy',
    promote: 3,
  },
  {
    id: 'suv',
    name: 'Dune Cup',
    className: 'SUV',
    races: 3,
    laps: 2,
    opponents: 7,
    difficulty: 'easy',
    promote: 3,
  },
  {
    id: 'touring',
    name: 'Touring Championship',
    className: 'Touring',
    races: 4,
    laps: 3,
    opponents: 9,
    difficulty: 'medium',
    promote: 3,
  },
  {
    id: 'gt',
    name: 'GT Challenge',
    className: 'GT',
    races: 5,
    laps: 3,
    opponents: 11,
    difficulty: 'medium',
    promote: 2,
  },
  {
    id: 'prototype',
    name: 'Endurance Prototypes',
    className: 'Prototype',
    races: 5,
    laps: 4,
    opponents: 11,
    difficulty: 'hard',
    promote: 2,
  },
  {
    id: 'formula',
    name: 'Formula Apex',
    className: 'Formula',
    races: 6,
    laps: 4,
    opponents: 11,
    difficulty: 'hard',
    promote: 1,
  },
];

/** How a season went: the tier, the player's final position and points. */
export interface CareerResult {
  tier: number;
  position: number;
  points: number;
}

export interface CareerSave {
  /** The tier being raced (an index into CAREER_TIERS; the length once every series is won). */
  tier: number;
  results: CareerResult[];
}

export const freshCareer = (): CareerSave => ({ tier: 0, results: [] });

/**
 * The career after a season at `tier` ends with the player in `position`: the result kept (the
 * latest attempt at a tier replaces the one before), and a tier up when the finish earns it.
 */
export function advanceCareer(
  career: CareerSave,
  tier: number,
  position: number,
  points: number,
): { career: CareerSave; promoted: boolean } {
  const t = CAREER_TIERS[tier];
  const results = [...career.results.filter((r) => r.tier !== tier), { tier, position, points }];
  const promoted = t !== undefined && career.tier === tier && position <= t.promote;
  return { career: { tier: promoted ? tier + 1 : career.tier, results }, promoted };
}

export function isCareerSave(value: unknown): value is CareerSave {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<CareerSave>;
  const count = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  return (
    count(c.tier) &&
    c.tier! <= CAREER_TIERS.length &&
    Array.isArray(c.results) &&
    c.results.every(
      (r) =>
        r !== null &&
        typeof r === 'object' &&
        count((r as CareerResult).tier) &&
        count((r as CareerResult).position) &&
        count((r as CareerResult).points),
    )
  );
}
