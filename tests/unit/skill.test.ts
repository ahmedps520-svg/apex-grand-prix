import { describe, expect, it } from 'vitest';
import { Skill } from '../../src/app/Skill';
import { createCarRenderState, type CarRenderState } from '../../src/render/interpolate';
import { FLAG_HAZARDS } from '../../src/shared/protocol';

const DT = 1 / 60;

const car = (): CarRenderState => {
  const s = createCarRenderState();
  for (const w of s.wheels) w.contact = true;
  return s;
};

const run = (
  skill: Skill,
  seconds: number,
  player: CarRenderState,
  others: CarRenderState[] = [],
) => {
  const cars = [player, ...others];
  for (let i = 0; i < Math.round(seconds / DT); i++) skill.update(DT, player, cars, cars.length);
};

describe('arcade skill points', () => {
  it('scores a drift once it ends, by speed and angle', () => {
    const skill = new Skill();
    const player = car();
    player.speed = 20;
    player.wheels[2]!.slipAngle = 0.3;
    player.wheels[3]!.slipAngle = 0.3;
    run(skill, 2, player);
    expect(skill.score).toBe(0);
    player.wheels[2]!.slipAngle = 0;
    player.wheels[3]!.slipAngle = 0;
    run(skill, 1, player);
    const events = skill.take();
    expect(events.map((e) => e.kind)).toEqual(['drift']);
    expect(events[0]!.points).toBeGreaterThan(100);
    expect(skill.score).toBe(events[0]!.points);
    expect(skill.combo).toBe(1);
  });

  it('scores a near miss once per car passing close, but not a hit', () => {
    const skill = new Skill();
    const player = car();
    player.speed = 20;
    player.vel.z = -20;
    const other = car();
    other.pos.x = 1.8;
    run(skill, 0.5, player, [other]);
    expect(skill.take().map((e) => e.kind)).toEqual(['nearMiss']);
    // The same car, still beside us, doesn't pay again straight away.
    run(skill, 0.5, player, [other]);
    expect(skill.take()).toEqual([]);
    // A car we hit (its hazards are on) never counts.
    const hit = car();
    hit.pos.x = -1.8;
    hit.flags = FLAG_HAZARDS;
    run(skill, 0.5, player, [hit]);
    expect(skill.take()).toEqual([]);
  });

  it('chains events into a growing multiplier, and a crash loses it', () => {
    const skill = new Skill();
    skill.award('smash', 100, 'SMASH');
    skill.award('smash', 100, 'SMASH');
    skill.award('smash', 100, 'SMASH');
    expect(skill.combo).toBe(3);
    expect(skill.multiplier).toBeCloseTo(1.75);
    expect(skill.score).toBe(100 + 125 + 150);
    const player = car();
    player.accelLong = -40;
    run(skill, 0.1, player);
    expect(skill.combo).toBe(0);
    expect(skill.multiplier).toBe(1);
    expect(skill.take().some((e) => e.kind === 'crash')).toBe(true);
    expect(skill.score).toBe(375);
  });

  it('pays for holding speed and for air time', () => {
    const skill = new Skill();
    const player = car();
    player.speed = 50;
    run(skill, 4.2, player);
    expect(skill.take().map((e) => e.kind)).toEqual(['speed']);
    player.speed = 20;
    for (const w of player.wheels) w.contact = false;
    run(skill, 0.8, player);
    for (const w of player.wheels) w.contact = true;
    run(skill, 0.1, player);
    const events = skill.take();
    expect(events.map((e) => e.kind)).toEqual(['air']);
    expect(events[0]!.points).toBeGreaterThan(100);
  });
});
