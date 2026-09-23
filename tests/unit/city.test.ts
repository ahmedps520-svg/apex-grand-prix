import { describe, expect, it } from 'vitest';
import { CityMap, DECK_HEIGHT, cityMap, type RoadKind } from '../../src/content/city/map';
import { defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { CitySurface } from '../../src/sim/city/CitySurface';
import { SURFACE, rayHit } from '../../src/sim/track/surface';
import { World } from '../../src/sim/world';

describe('free roam session', () => {
  const config = (roamStart: SessionConfig['roamStart']): SessionConfig => ({
    mode: 'roam',
    trackId: '',
    carId: 'gt',
    location: 'loop',
    roamStart,
    opponents: 0,
    laps: 0,
    difficulty: 'medium',
    gridSlot: 0,
    aids: defaultAids(),
    seed: 1,
  });

  it('starts up on the orbital deck, and on the ground downtown', () => {
    const up = World.forSession(config('highway'));
    expect(up.surface).toBeInstanceOf(CitySurface);
    expect(up.cars[0]!.pos.y).toBeGreaterThan(DECK_HEIGHT);
    const down = World.forSession(config('downtown'));
    expect(down.cars[0]!.pos.y).toBeLessThan(1.5);
    for (let i = 0; i < 400; i++) up.step(1 / 400);
    expect(up.cars[0]!.pos.y).toBeGreaterThan(DECK_HEIGHT);
  });
});

describe('city map', () => {
  const map = cityMap();

  it('builds the same map every time', () => {
    const other = new CityMap();
    expect(other.roads.length).toBe(map.roads.length);
    expect(other.lots.length).toBe(map.lots.length);
    expect(other.pieces[100]!.ax).toBe(map.pieces[100]!.ax);
    expect(map.roads.length).toBeGreaterThan(40);
  });

  it('has every kind of road and hundreds of junctions', () => {
    const kinds = new Set(map.roads.map((r) => r.kind));
    const wanted: RoadKind[] = [
      'street',
      'avenue',
      'highway',
      'ramp',
      'mountain',
      'circuit',
      'access',
      'port',
      'suburb',
    ];
    for (const k of wanted) expect(kinds.has(k)).toBe(true);
    expect(map.junctions.length).toBeGreaterThan(100);
    expect(map.junctions.some((j) => j.control === 'signal')).toBe(true);
  });

  it('starts every spawn on a road of its level', () => {
    for (const [name, spawn] of Object.entries(map.spawns)) {
      const elevated = spawn.y !== undefined && spawn.y > 3;
      const p = map.project(spawn.x, spawn.z, { level: elevated });
      expect(p, name).not.toBeNull();
      expect(Math.abs(p!.lateral), name).toBeLessThan(p!.piece.halfWidth);
    }
  });

  it('ramps climb from the ground to the deck', () => {
    const ramps = map.roads.filter((r) => r.kind === 'ramp');
    expect(ramps.length).toBe(16);
    for (const r of ramps) {
      expect(Math.min(...r.heights)).toBe(0);
      expect(Math.max(...r.heights)).toBe(DECK_HEIGHT);
      expect(r.oneWay).toBe(true);
    }
  });

  it('keeps the mountain road under a 10 % grade and takes it up the ridge', () => {
    const road = map.roads.find((r) => r.kind === 'mountain')!;
    for (let i = 1; i < road.heights.length; i++) {
      const run = Math.hypot(
        road.points[i * 2]! - road.points[i * 2 - 2]!,
        road.points[i * 2 + 1]! - road.points[i * 2 - 1]!,
      );
      expect(Math.abs(road.heights[i]! - road.heights[i - 1]!) / run).toBeLessThanOrEqual(0.101);
    }
    expect(Math.max(...road.heights)).toBeGreaterThan(60);
    expect(road.heights[0]).toBe(0);
  });

  it('keeps buildings off the roads', () => {
    for (const lot of map.lots) {
      if (lot.style === 'container' || lot.style === 'crane' || lot.style === 'warehouse') continue;
      expect(map.paved(lot.x, lot.z), `${lot.style} at ${lot.x}, ${lot.z}`).toBe(false);
    }
  });
});

describe('city surface', () => {
  const surface = new CitySurface(cityMap());

  it('finds the ground under a wheel, and the deck only from above it', () => {
    const hit = rayHit();
    expect(surface.raycast(5.4, 2, 380, 0, -1, 0, 5, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(2, 3);
    expect(hit.surface).toBe(SURFACE.ASPHALT);
    const x = -100;
    const z = -607;
    expect(surface.raycast(x, DECK_HEIGHT + 1, z, 0, -1, 0, 5, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(1, 3);
    expect(hit.surface).toBe(SURFACE.ASPHALT);
    expect(surface.raycast(x, 1, z, 0, -1, 0, 5, hit)).toBe(true);
    expect(hit.distance).toBeCloseTo(1, 3);
    expect(surface.heightAt(x, z, DECK_HEIGHT + 0.3)).toBe(DECK_HEIGHT);
    expect(surface.heightAt(x, z, 0.3)).toBe(0);
  });

  it('is asphalt on the roads and grass beside them', () => {
    expect(surface.surfaceAt(5, 380)).toBe(SURFACE.ASPHALT);
    const tower = cityMap().lots.find((l) => l.style === 'tower')!;
    expect(surface.surfaceAt(tower.x, tower.z)).toBe(SURFACE.GRASS);
  });

  it('walls the deck edges and median, buildings and the quay', () => {
    const out = { nx: 0, nz: 0 };
    const y = DECK_HEIGHT + 0.3;
    expect(surface.wallContact(-100, -607, out, y)).toBe(0);
    expect(surface.wallContact(-100, -610.8, out, y)).toBeGreaterThan(0);
    expect(out.nz).toBeGreaterThan(0);
    expect(surface.wallContact(-100, -600.3, out, y)).toBeGreaterThan(0);
    const tower = cityMap().lots.find((l) => l.style === 'tower')!;
    expect(surface.wallContact(tower.x, tower.z, out, 0.4)).toBeGreaterThan(0);
    expect(surface.wallContact(tower.x + tower.w / 2 + 1.5, tower.z, out, 0.4)).toBe(0);
    expect(surface.wallContact(1449, 0, out, 0.4)).toBeGreaterThan(0);
    expect(out.nx).toBe(-1);
  });
});
