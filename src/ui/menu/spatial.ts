/**
 * Spatial navigation for menus: from the focused item, pick the nearest item in the direction
 * the player pushed (D-pad, stick or arrow keys). Pure geometry so it can be unit tested; the
 * focus manager feeds it element rectangles.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Direction = 'up' | 'down' | 'left' | 'right';

/** How much a candidate may overlap backwards and still count as "in that direction", px. */
const TOLERANCE = 2;
/** Sideways offset costs this many times more than distance along the direction. */
const SIDEWAYS_WEIGHT = 3;
/** Items this close to the nearest one along the direction count as the same row or column. */
const SAME_LINE = 8;

interface Axis {
  /** Start and end of the rect along the direction of travel, sign-adjusted so "ahead" is +. */
  near: (r: Rect) => number;
  far: (r: Rect) => number;
  /** Extent across the direction of travel. */
  across: (r: Rect) => [number, number];
}

const AXES: Record<Direction, Axis> = {
  down: { near: (r) => r.y, far: (r) => r.y + r.h, across: (r) => [r.x, r.x + r.w] },
  up: { near: (r) => -(r.y + r.h), far: (r) => -r.y, across: (r) => [r.x, r.x + r.w] },
  right: { near: (r) => r.x, far: (r) => r.x + r.w, across: (r) => [r.y, r.y + r.h] },
  left: { near: (r) => -(r.x + r.w), far: (r) => -r.x, across: (r) => [r.y, r.y + r.h] },
};

/** Gap between two ranges (0 when they overlap). */
function rangeGap(a: [number, number], b: [number, number]): number {
  if (a[1] < b[0]) return b[0] - a[1];
  if (b[1] < a[0]) return a[0] - b[1];
  return 0;
}

/**
 * Index of the best candidate in `direction` from `from`, or -1 if there is none. Candidates
 * must lie beyond the current item's far edge; among those, the one closest along the direction
 * wins, with sideways offset weighted more heavily so moving down a column stays in the column.
 * With `wrap`, moving past the last item in a row or column jumps to the first one.
 * `preferred` items (e.g. the selected tab) win when they are in the row or column reached.
 */
export function nextInDirection(
  from: Rect,
  candidates: readonly Rect[],
  direction: Direction,
  wrap = false,
  preferred?: ReadonlySet<number>,
): number {
  const axis = AXES[direction];
  const fromFar = axis.far(from);
  const fromAcross = axis.across(from);
  let best = -1;
  let bestScore = Infinity;
  candidates.forEach((c, i) => {
    if (c === from) return;
    const ahead = axis.near(c) - fromFar;
    if (ahead < -TOLERANCE) return;
    const sideways = rangeGap(fromAcross, axis.across(c));
    const score = Math.max(ahead, 0) + sideways * SIDEWAYS_WEIGHT + centreOffset(from, c) * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  if (best >= 0 && preferred && preferred.size > 0 && !preferred.has(best)) {
    const line = axis.near(candidates[best]!);
    for (const i of preferred) {
      const c = candidates[i];
      if (c && c !== from && Math.abs(axis.near(c) - line) <= SAME_LINE) return i;
    }
  }
  if (best >= 0 || !wrap) return best;

  // Wrap: the item furthest back in the same row or column.
  let furthest = Infinity;
  candidates.forEach((c, i) => {
    if (c === from || rangeGap(fromAcross, axis.across(c)) > 0) return;
    const position = axis.near(c);
    if (position < furthest) {
      furthest = position;
      best = i;
    }
  });
  return best;
}

function centreOffset(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
}
