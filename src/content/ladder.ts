/**
 * The festival's ladder: lifetime skill points climb it, level by level, each with a title.
 * Pure data, shared by the game, the HUD and the menus.
 */

export interface LadderLevel {
  level: number;
  title: string;
  /** Lifetime skill points the level starts at. */
  points: number;
}

export const LADDER: readonly LadderLevel[] = [
  { level: 1, title: 'Rookie', points: 0 },
  { level: 2, title: 'Newcomer', points: 1500 },
  { level: 3, title: 'Street', points: 4000 },
  { level: 4, title: 'Racer', points: 8000 },
  { level: 5, title: 'Hotshot', points: 14000 },
  { level: 6, title: 'Pro', points: 22000 },
  { level: 7, title: 'Ace', points: 32000 },
  { level: 8, title: 'Elite', points: 45000 },
  { level: 9, title: 'Star', points: 60000 },
  { level: 10, title: 'Legend', points: 80000 },
];

export interface LadderStanding {
  level: number;
  title: string;
  /** Lifetime points, and how many of them are into this level. */
  points: number;
  into: number;
  /** Points still needed for the next level (null at the top). */
  toNext: number | null;
  /** How far through the level, 0 … 1 (1 at the top). */
  share: number;
}

/** Where a number of lifetime skill points stands on the ladder. */
export function ladderStanding(points: number): LadderStanding {
  const p = Number.isFinite(points) && points > 0 ? Math.floor(points) : 0;
  let i = 0;
  while (i + 1 < LADDER.length && p >= LADDER[i + 1]!.points) i++;
  const here = LADDER[i]!;
  const next = LADDER[i + 1];
  const into = p - here.points;
  const span = next ? next.points - here.points : 0;
  return {
    level: here.level,
    title: here.title,
    points: p,
    into,
    toNext: next ? next.points - p : null,
    share: next ? Math.min(into / span, 1) : 1,
  };
}
