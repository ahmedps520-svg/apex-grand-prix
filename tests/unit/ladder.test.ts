import { afterEach, describe, expect, it, vi } from 'vitest';
import { LADDER, ladderStanding } from '../../src/content/ladder';
import { loadProgress, saveProgress } from '../../src/app/records';

const fakeStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
};

describe("the festival's ladder", () => {
  it('climbs level by level, each with a title, from nothing to Legend', () => {
    expect(LADDER[0]).toEqual({ level: 1, title: 'Rookie', points: 0 });
    for (let i = 1; i < LADDER.length; i++) {
      expect(LADDER[i]!.points).toBeGreaterThan(LADDER[i - 1]!.points);
      expect(LADDER[i]!.level).toBe(i + 1);
      expect(LADDER[i]!.title.length).toBeGreaterThan(0);
    }
    const titles = new Set(LADDER.map((l) => l.title));
    expect(titles.size).toBe(LADDER.length);
  });

  it('places any number of points on it', () => {
    const start = ladderStanding(0);
    expect(start).toEqual({
      level: 1,
      title: 'Rookie',
      points: 0,
      into: 0,
      toNext: 1500,
      share: 0,
    });
    const almost = ladderStanding(1499);
    expect(almost.level).toBe(1);
    expect(almost.toNext).toBe(1);
    expect(almost.share).toBeCloseTo(1499 / 1500, 6);
    const up = ladderStanding(1500);
    expect(up.level).toBe(2);
    expect(up.title).toBe('Newcomer');
    expect(up.into).toBe(0);
    expect(up.toNext).toBe(2500);
    const mid = ladderStanding(10000);
    expect(mid.level).toBe(4);
    expect(mid.into).toBe(2000);
    expect(mid.share).toBeCloseTo(2000 / 6000, 6);
    const top = ladderStanding(250000);
    expect(top.level).toBe(10);
    expect(top.title).toBe('Legend');
    expect(top.toNext).toBeNull();
    expect(top.share).toBe(1);
    // Bad input is nothing.
    expect(ladderStanding(-40).level).toBe(1);
    expect(ladderStanding(Number.NaN).points).toBe(0);
    expect(ladderStanding(1500.9).level).toBe(2);
  });
});

describe("the festival's tallies", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trip through storage, repair bad data and are nothing without storage', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadProgress()).toEqual({ skill: 0, wins: 0 });
    saveProgress({ skill: 12400, wins: 3 });
    expect(loadProgress()).toEqual({ skill: 12400, wins: 3 });
    localStorage.setItem('apex-gp.progress', JSON.stringify({ skill: 'lots', wins: -2 }));
    expect(loadProgress()).toEqual({ skill: 0, wins: 0 });
    localStorage.setItem('apex-gp.progress', JSON.stringify({ skill: 99.7, wins: 1.2 }));
    expect(loadProgress()).toEqual({ skill: 99, wins: 1 });
    localStorage.setItem('apex-gp.progress', '{nope');
    expect(loadProgress()).toEqual({ skill: 0, wins: 0 });
    vi.stubGlobal('localStorage', undefined);
    expect(loadProgress()).toEqual({ skill: 0, wins: 0 });
    expect(() => saveProgress({ skill: 1, wins: 0 })).not.toThrow();
  });
});
