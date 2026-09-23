import { describe, expect, it } from 'vitest';
import { Festival, formatTime, medalFor } from '../../src/app/Festival';
import { festivalEvents, rampOf } from '../../src/content/city/events';
import { cityMap } from '../../src/content/city/map';
import { createCarRenderState, type CarRenderState } from '../../src/render/interpolate';
import { CitySurface } from '../../src/sim/city/CitySurface';
import { rayHit } from '../../src/sim/track/surface';

const map = cityMap();
const events = festivalEvents(map);

const car = (): CarRenderState => {
  const s = createCarRenderState();
  for (const w of s.wheels) w.contact = true;
  return s;
};

describe('festival events', () => {
  it('puts cameras, jumps, drift zones and races on the roads', () => {
    const count = (kind: string) => events.filter((e) => e.kind === kind).length;
    expect(count('camera')).toBeGreaterThanOrEqual(4);
    expect(count('jump')).toBeGreaterThanOrEqual(2);
    expect(count('drift')).toBeGreaterThanOrEqual(3);
    expect(count('race')).toBeGreaterThanOrEqual(3);
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    // On a road: on the ground, or up on the orbital's deck.
    const onRoad = (x: number, z: number) => map.paved(x, z) || map.deckAt(x, z) !== null;
    for (const e of events) {
      expect(onRoad(e.x, e.z)).toBe(true);
      expect(Math.hypot(e.tx, e.tz)).toBeCloseTo(1, 5);
      if (e.kind === 'race') {
        expect(e.checkpoints.length).toBeGreaterThanOrEqual(3);
        expect(e.length).toBeGreaterThan(300);
        expect(e.par).toBeGreaterThan(0);
        for (const cp of e.checkpoints) expect(onRoad(cp.x, cp.z)).toBe(true);
      }
      if (e.kind === 'drift') {
        expect(e.zone!.s1).toBeGreaterThan(e.zone!.s0);
        expect(e.zone!.pieces.length).toBeGreaterThan(0);
      }
      if (e.kind === 'jump') expect(e.ramp!.length).toBeGreaterThan(0);
    }
  });
});

describe("the festival's rules", () => {
  it('times a race through its checkpoints and awards a medal', () => {
    const race = events.find((e) => e.id === 'race-avenue')!;
    const fest = new Festival(events, {});
    const p = car();
    p.speed = 20;
    p.vel.x = race.tx * 20;
    p.vel.z = race.tz * 20;
    p.pos.y = race.y;
    // Approach the start line from behind and cross it.
    p.pos.x = race.x - race.tx * 10;
    p.pos.z = race.z - race.tz * 10;
    fest.update(0.05, 0, p);
    p.pos.x = race.x + race.tx * 5;
    p.pos.z = race.z + race.tz * 5;
    fest.update(0.05, 0.05, p);
    expect(fest.view.active?.kind).toBe('race');
    let t = 0.05;
    for (let i = 1; i < race.checkpoints.length; i++) {
      const cp = race.checkpoints[i]!;
      t += 5;
      p.pos.x = cp.x;
      p.pos.z = cp.z;
      p.pos.y = cp.y;
      fest.update(0.05, t, p);
    }
    expect(fest.view.active).toBeNull();
    const notice = fest.notices.at(-1)!;
    expect(notice.event.id).toBe('race-avenue');
    expect(notice.best).toBe(true);
    const time = fest.records['race-avenue']!;
    expect(time).toBeCloseTo(t - 0.05, 1);
    expect(notice.medal).toBe(medalFor(race, time));
    expect(notice.text).toContain(formatTime(time));
  });

  it('registers the speed at a camera when its line is crossed', () => {
    const cam = events.find((e) => e.id === 'cam-avenue')!;
    const fest = new Festival(events, {});
    const p = car();
    p.speed = 40;
    p.pos.y = cam.y;
    p.pos.x = cam.x - cam.tx * 8;
    p.pos.z = cam.z - cam.tz * 8;
    fest.update(0.05, 0, p);
    p.pos.x = cam.x + cam.tx * 8;
    p.pos.z = cam.z + cam.tz * 8;
    fest.update(0.05, 0.05, p);
    expect(fest.records['cam-avenue']).toBeCloseTo(144, 0);
    expect(fest.notices[0]!.text).toContain('144 km/h');
    // Sitting on the line doesn't fire again.
    fest.update(0.05, 0.1, p);
    expect(fest.notices.length).toBe(1);
  });

  it('tallies a drift zone and banks it on leaving', () => {
    const zone = events.find((e) => e.kind === 'drift')!;
    const fest = new Festival(events, {});
    const mid = map.pointAlong(zone.zone!.road, (zone.zone!.s0 + zone.zone!.s1) / 2)!;
    const p = car();
    p.pos.x = mid.x;
    p.pos.z = mid.z;
    p.pos.y = mid.y;
    p.speed = 20;
    p.wheels[2]!.slipAngle = 0.3;
    p.wheels[3]!.slipAngle = 0.3;
    let t = 0;
    for (let i = 0; i < 40; i++) fest.update(0.05, (t += 0.05), p);
    expect(fest.view.active?.kind).toBe('drift');
    p.pos.x += 600;
    for (let i = 0; i < 40; i++) fest.update(0.05, (t += 0.05), p);
    expect(fest.view.active).toBeNull();
    expect(fest.records[zone.id]).toBeGreaterThan(100);
    expect(fest.notices.at(-1)!.text).toContain('Drift zone');
  });

  it('measures a jump from the ramp lip to the landing', () => {
    const jump = events.find((e) => e.kind === 'jump')!;
    const fest = new Festival(events, {});
    const p = car();
    p.speed = 25;
    p.pos.y = jump.y;
    // On the ramp, then in the air past the lip, then down 20 m beyond it.
    p.pos.x = jump.x + jump.tx * 6;
    p.pos.z = jump.z + jump.tz * 6;
    fest.update(0.05, 0, p);
    expect(fest.view.active?.kind).toBe('jump');
    for (const w of p.wheels) w.contact = false;
    const lipX = jump.x + jump.tx * jump.ramp!.length;
    const lipZ = jump.z + jump.tz * jump.ramp!.length;
    for (let i = 1; i <= 12; i++) {
      p.pos.x = lipX + (jump.tx * (20 * i)) / 12;
      p.pos.z = lipZ + (jump.tz * (20 * i)) / 12;
      fest.update(0.05, i * 0.05, p);
    }
    for (const w of p.wheels) w.contact = true;
    fest.update(0.05, 0.7, p);
    expect(fest.records[jump.id]).toBeCloseTo(20, 0);
    expect(fest.notices.at(-1)!.text).toContain('Jump');
  });

  it('formats times and picks medals', () => {
    expect(formatTime(65.5)).toBe('1:05.50');
    const race = { ...events.find((e) => e.kind === 'race')!, par: 40 };
    expect(medalFor(race, 40)).toBe('gold');
    expect(medalFor(race, 45)).toBe('silver');
    expect(medalFor(race, 52)).toBe('bronze');
    expect(medalFor(race, 60)).toBeNull();
  });
});

describe('ramps in the city surface', () => {
  it('lifts a wheel up the ramp and lets it fly off the lip', () => {
    const surface = new CitySurface(map);
    const jump = events.find((e) => e.kind === 'jump')!;
    surface.ramps.push(rampOf(jump)!);
    const ramp = jump.ramp!;
    const half = ramp.length / 2;
    const x = jump.x + jump.tx * half;
    const z = jump.z + jump.tz * half;
    expect(surface.heightAt(x, z)).toBeCloseTo(jump.y + ramp.rise / 2, 2);
    const hit = rayHit();
    expect(surface.raycast(x, jump.y + 3, z, 0, -1, 0, 6, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(3 - ramp.rise / 2, 2);
    expect(hit.ny).toBeLessThan(1);
    expect(hit.ny).toBeGreaterThan(0.95);
    const beyondX = jump.x + jump.tx * (ramp.length + 3);
    const beyondZ = jump.z + jump.tz * (ramp.length + 3);
    expect(surface.heightAt(beyondX, beyondZ)).toBeCloseTo(map.groundHeight(beyondX, beyondZ), 3);
  });
});
