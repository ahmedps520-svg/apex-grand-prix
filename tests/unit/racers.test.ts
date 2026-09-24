import { describe, expect, it } from 'vitest';
import { festivalEvents } from '../../src/content/city/events';
import { SIM_DT, defaultAids, type SessionConfig } from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (): SessionConfig => ({
  mode: 'roam',
  trackId: '',
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  traffic: 6,
  police: 2,
  racers: 3,
  opponents: 0,
  laps: 0,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 11,
  conditions: { time: 'midday', weather: 'clear' },
});

const run = (world: World, seconds: number, each?: () => void) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    if (each) each();
    world.step(SIM_DT);
  }
};

/** A world with the player 60 m before a race's start line, facing it. */
function atStart(id: string): { world: World; race: ReturnType<typeof festivalEvents>[number] } {
  const world = World.forSession(config());
  const race = festivalEvents(world.traffic!.map).find((e) => e.id === id)!;
  world.cars[0]!.teleport({
    x: race.x - race.tx * 60,
    z: race.z - race.tz * 60,
    yaw: race.yaw,
    y: race.y + 0.5,
  });
  return { world, race };
}

/** Drives the player over the start line (held at 10 m/s along the route for a second). */
function crossTheLine(world: World, race: ReturnType<typeof festivalEvents>[number]): void {
  const player = world.cars[0]!;
  player.teleport({
    x: race.x - race.tx * 3,
    z: race.z - race.tz * 3,
    yaw: race.yaw,
    y: race.y + 0.5,
  });
  run(world, 1, () => {
    if (world.racers!.active?.phase !== 'grid') return;
    player.vel.x = race.tx * 10;
    player.vel.z = race.tz * 10;
  });
}

describe('street racers', () => {
  it('take slots after the police and stay out of the world until a race', () => {
    const world = World.forSession(config());
    expect(world.racers).not.toBeNull();
    expect(world.snapshotCount).toBe(1 + 6 + 2 + 3);
    const racers = world.traffic!.vehicles.filter((v) => v.racer);
    expect(racers.length).toBe(3);
    expect(racers.every((v) => v.mode === 'race' && !v.police)).toBe(true);
    run(world, 3);
    expect(racers.every((v) => !v.active)).toBe(true);
    expect(world.racers!.active).toBeNull();
    expect(world.traffic!.vehicles.filter((v) => v.active && !v.racer).length).toBeGreaterThan(0);
  });

  it('line up on a grid past the start line when the player comes up to it', () => {
    const { world, race } = atStart('race-avenue');
    run(world, 1);
    const status = world.racers!.active!;
    expect(status.id).toBe('race-avenue');
    expect(status.phase).toBe('grid');
    expect(status.count).toBe(4);
    const racers = world.traffic!.vehicles.filter((v) => v.racer);
    const map = world.traffic!.map;
    for (const v of racers) {
      expect(v.active).toBe(true);
      expect(v.v).toBe(0);
      // Past the line, on the road, in the direction of the race.
      const along = (v.x - race.x) * race.tx + (v.z - race.z) * race.tz;
      expect(along).toBeGreaterThan(8);
      expect(along).toBeLessThan(40);
      const p = map.alongRoad(race.route!.road, v.x, v.z)!;
      expect(p.dist).toBeLessThan(race.route!.road.width / 2);
      expect(Math.cos(v.yaw - race.yaw)).toBeGreaterThan(0.99);
    }
    // Apart from each other.
    for (const a of racers) {
      for (const b of racers) {
        if (a !== b) expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(2.5);
      }
    }
    // Driving off again breaks the grid up.
    world.cars[0]!.teleport({
      x: race.x - race.tx * 400,
      z: race.z - race.tz * 400,
      yaw: race.yaw,
    });
    run(world, 1);
    expect(world.racers!.active).toBeNull();
    expect(racers.every((v) => !v.active)).toBe(true);
  });

  it('put the player on the grid and hold it through the countdown, then race', () => {
    const { world, race } = atStart('race-avenue');
    run(world, 1);
    crossTheLine(world, race);
    const status = world.racers!.status;
    expect(status.phase).toBe('countdown');
    expect(status.position).toBe(4);
    const player = world.cars[0]!;
    // On its slot: just past the line, in a lane of the road, facing along it, stopped.
    const along = (player.pos.x - race.x) * race.tx + (player.pos.z - race.z) * race.tz;
    expect(along).toBeGreaterThan(8);
    expect(along).toBeLessThan(16);
    expect(Math.hypot(player.vel.x, player.vel.z)).toBeLessThan(0.5);
    const x0 = player.pos.x;
    const z0 = player.pos.z;
    expect(world.racers!.holding).toBe(true);
    // The sweep over the grid, then the count: about six seconds held in all.
    run(world, 5.3);
    expect(status.phase).toBe('countdown');
    expect(Math.hypot(player.pos.x - x0, player.pos.z - z0)).toBeLessThan(0.5);
    run(world, 0.7);
    expect(status.phase).toBe('racing');
    expect(world.racers!.holding).toBe(false);
    expect(status.time).toBeGreaterThan(0);
    // The rivals go; they stay on the road at sensible speeds and pull ahead of a parked player.
    run(world, 20);
    const racers = world.traffic!.vehicles.filter((v) => v.racer);
    const map = world.traffic!.map;
    for (const v of racers) {
      expect(v.active).toBe(true);
      expect(v.v).toBeGreaterThan(5);
      expect(v.v).toBeLessThan(60);
      const p = map.alongRoad(race.route!.road, v.x, v.z)!;
      expect(p.dist).toBeLessThan(race.route!.road.width / 2);
    }
    expect(status.rivals.every((r) => r.progress > 100)).toBe(true);
    expect(status.position).toBe(4);
    expect(status.time).toBeGreaterThan(20);
    expect(status.time).toBeLessThan(21);
    // The rubber band: far ahead of the player they wait for it.
    run(world, 25);
    for (const v of racers) expect(v.v).toBeLessThan(16);
    expect(status.finished).toBe(-1);
  });

  it('hold the player where it crossed while the screen fades, then put it on its slot', () => {
    const { world, race } = atStart('race-avenue');
    run(world, 1);
    const player = world.cars[0]!;
    player.teleport({
      x: race.x - race.tx * 2,
      z: race.z - race.tz * 2,
      yaw: race.yaw,
      y: race.y + 0.5,
    });
    // Step by step over the line.
    for (let i = 0; i < 400 && world.racers!.active?.phase === 'grid'; i++) {
      player.vel.x = race.tx * 10;
      player.vel.z = race.tz * 10;
      world.step(SIM_DT);
    }
    const status = world.racers!.status;
    expect(status.phase).toBe('countdown');
    expect(status.placed).toBe(false);
    expect(status.countdown).toBeCloseTo(3, 1);
    // Still about where it crossed, held.
    let along = (player.pos.x - race.x) * race.tx + (player.pos.z - race.z) * race.tz;
    expect(along).toBeLessThan(3);
    expect(world.racers!.holding).toBe(true);
    run(world, 0.4);
    expect(status.placed).toBe(true);
    along = (player.pos.x - race.x) * race.tx + (player.pos.z - race.z) * race.tz;
    expect(along).toBeGreaterThan(8);
    expect(along).toBeLessThan(16);
    // On the grid: the sweep first (the count waits at 3), then the count runs.
    expect(status.intro).toBe(true);
    expect(status.countdown).toBe(3);
    run(world, 3.4);
    expect(status.intro).toBe(false);
    expect(status.phase).toBe('countdown');
    expect(status.countdown).toBeLessThan(3);
    expect(status.countdown).toBeGreaterThan(2);
  });

  it('let the sweep be skipped straight to the count', () => {
    const { world, race } = atStart('race-avenue');
    run(world, 1);
    crossTheLine(world, race);
    const status = world.racers!.status;
    expect(status.phase).toBe('countdown');
    expect(status.placed).toBe(true);
    expect(status.intro).toBe(true);
    world.racers!.skipIntro();
    run(world, 0.1);
    expect(status.intro).toBe(false);
    expect(status.countdown).toBeLessThan(3);
    expect(status.countdown).toBeGreaterThan(2.7);
    run(world, 3.2);
    expect(status.phase).toBe('racing');
  });

  it('give the player its finishing time and position at the line', () => {
    const { world, race } = atStart('race-avenue');
    run(world, 1);
    crossTheLine(world, race);
    run(world, 7);
    expect(world.racers!.status.phase).toBe('racing');
    // Straight to the finish (the rivals are still on their way).
    const road = race.route!.road;
    const end = world.traffic!.map.pointAlong(road, race.route!.s1 - 30)!;
    const player = world.cars[0]!;
    player.teleport({ x: end.x, z: end.z, yaw: Math.atan2(-end.tx, -end.tz), y: end.y + 0.5 });
    run(world, 4, () => {
      player.vel.x = end.tx * 15;
      player.vel.z = end.tz * 15;
    });
    const status = world.racers!.status;
    expect(status.finished).toBeGreaterThan(0);
    expect(status.position).toBe(1);
    expect(status.rivals.every((r) => r.time === -1)).toBe(true);
  });

  it('stand down when the race is called off', () => {
    const { world, race } = atStart('race-orbital');
    run(world, 1);
    expect(world.racers!.active?.phase).toBe('grid');
    crossTheLine(world, race);
    run(world, 7);
    expect(world.racers!.active?.phase).toBe('racing');
    world.racers!.endRace();
    run(world, 0.5);
    expect(world.racers!.active).toBeNull();
    expect(world.racers!.holding).toBe(false);
    const racers = world.traffic!.vehicles.filter((v) => v.racer);
    expect(racers.every((v) => !v.active)).toBe(true);
    // Back at the line, the grid forms again.
    world.cars[0]!.teleport({
      x: race.x - race.tx * 60,
      z: race.z - race.tz * 60,
      yaw: race.yaw,
      y: race.y + 0.5,
    });
    run(world, 1);
    expect(world.racers!.active?.phase).toBe('grid');
  });
});
