import { describe, expect, it } from 'vitest';
import { nextInDirection, type Rect } from '../../src/ui/menu/spatial';

const box = (x: number, y: number, w = 100, h = 40): Rect => ({ x, y, w, h });

describe('spatial menu navigation', () => {
  // A vertical list of five buttons.
  const list = [0, 1, 2, 3, 4].map((i) => box(0, i * 50));

  it('moves up and down a list and stops at the ends', () => {
    expect(nextInDirection(list[0]!, list, 'down')).toBe(1);
    expect(nextInDirection(list[2]!, list, 'up')).toBe(1);
    expect(nextInDirection(list[4]!, list, 'down')).toBe(-1);
    expect(nextInDirection(list[0]!, list, 'up')).toBe(-1);
    expect(nextInDirection(list[2]!, list, 'left')).toBe(-1);
  });

  it('wraps around a list when asked', () => {
    expect(nextInDirection(list[4]!, list, 'down', true)).toBe(0);
    expect(nextInDirection(list[0]!, list, 'up', true)).toBe(4);
  });

  // A 3 × 3 grid with gaps.
  const grid: Rect[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) grid.push(box(col * 120, row * 60));
  }

  it('moves within rows and columns of a grid', () => {
    const centre = grid[4]!;
    expect(nextInDirection(centre, grid, 'up')).toBe(1);
    expect(nextInDirection(centre, grid, 'down')).toBe(7);
    expect(nextInDirection(centre, grid, 'left')).toBe(3);
    expect(nextInDirection(centre, grid, 'right')).toBe(5);
    expect(nextInDirection(grid[8]!, grid, 'right')).toBe(-1);
    expect(nextInDirection(grid[8]!, grid, 'right', true)).toBe(6);
  });

  it('prefers staying in the column over a closer item off to the side', () => {
    const from = box(0, 0);
    const straightBelowButFar = box(0, 200);
    const diagonalButClose = box(300, 50);
    expect(nextInDirection(from, [from, diagonalButClose, straightBelowButFar], 'down')).toBe(2);
  });

  it('moves between a tab bar and the content below it', () => {
    const tabs = [box(0, 0, 80, 30), box(90, 0, 80, 30), box(180, 0, 80, 30)];
    const rows = [box(0, 60, 400, 40), box(0, 110, 400, 40)];
    const all = [...tabs, ...rows];
    expect(nextInDirection(tabs[1]!, all, 'down')).toBe(3);
    // Up from the content lands on the nearest tab, or on the selected tab if there is one.
    expect(nextInDirection(rows[0]!, all, 'up')).toBe(2);
    expect(nextInDirection(rows[0]!, all, 'up', false, new Set([0]))).toBe(0);
    expect(nextInDirection(tabs[0]!, all, 'right')).toBe(1);
  });

  it('ignores items that overlap the current one backwards', () => {
    const from = box(0, 100);
    const above = box(0, 60); // overlaps upwards, so it isn't "below"
    expect(nextInDirection(from, [from, above], 'down')).toBe(-1);
  });
});
