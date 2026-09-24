import { describe, expect, it } from 'vitest';
import {
  CAREER_TIERS,
  advanceCareer,
  freshCareer,
  isCareerSave,
  type CareerSave,
} from '../../src/content/career';
import { TRACKS } from '../../src/content/tracks';
import { CAR_CLASSES } from '../../src/sim/vehicle/cars';

describe('the career', () => {
  it('is a ladder of series in real classes, each a season that can be run', () => {
    expect(CAREER_TIERS.length).toBeGreaterThanOrEqual(5);
    for (const t of CAREER_TIERS) {
      expect(CAR_CLASSES).toContain(t.className);
      expect(t.races).toBeGreaterThan(0);
      expect(t.races).toBeLessThanOrEqual(TRACKS.length);
      expect(t.promote).toBeGreaterThanOrEqual(1);
      expect(t.promote).toBeLessThanOrEqual(t.opponents + 1);
    }
    expect(CAREER_TIERS[0]!.className).toBe('Street');
    expect(CAREER_TIERS[CAREER_TIERS.length - 1]!.className).toBe('Formula');
  });

  it('moves up on a finish good enough, keeps the latest attempt, and completes at the top', () => {
    const start = freshCareer();
    // Too low: the tier stays, the result is kept.
    const miss = advanceCareer(start, 0, CAREER_TIERS[0]!.promote + 1, 20);
    expect(miss.promoted).toBe(false);
    expect(miss.career.tier).toBe(0);
    expect(miss.career.results).toEqual([{ tier: 0, position: 4, points: 20 }]);
    // Good enough: up a tier, the earlier attempt replaced.
    const up = advanceCareer(miss.career, 0, 1, 75);
    expect(up.promoted).toBe(true);
    expect(up.career.tier).toBe(1);
    expect(up.career.results).toEqual([{ tier: 0, position: 1, points: 75 }]);
    // A season at a tier already passed changes nothing about the tier.
    const again = advanceCareer(up.career, 0, 8, 5);
    expect(again.promoted).toBe(false);
    expect(again.career.tier).toBe(1);
    // Winning the last series completes the career.
    let career: CareerSave = { tier: CAREER_TIERS.length - 1, results: [] };
    career = advanceCareer(career, CAREER_TIERS.length - 1, 1, 100).career;
    expect(career.tier).toBe(CAREER_TIERS.length);
  });

  it('checks a stored career before trusting it', () => {
    expect(isCareerSave(freshCareer())).toBe(true);
    expect(isCareerSave({ tier: 2, results: [{ tier: 0, position: 2, points: 40 }] })).toBe(true);
    expect(isCareerSave({ tier: 99, results: [] })).toBe(false);
    expect(isCareerSave({ tier: 1, results: [{ tier: 'a' }] })).toBe(false);
    expect(isCareerSave(null)).toBe(false);
    expect(isCareerSave('career')).toBe(false);
  });
});
