import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import { PIT_ENTRY } from '../../src/shared/pitLane';
import { defaultAids, neutralInput, SIM_DT, type SessionConfig } from '../../src/shared/protocol';
import {
  SAFETY_CAR_AFTER,
  SAFETY_CAR_PENALTY,
  SAFETY_CAR_SPEED,
} from '../../src/sim/race/SafetyCar';
import { World } from '../../src/sim/world';

const config = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
  mode: 'race',
  trackId: TRACKS[0]!.id,
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  opponents: 2,
  laps: 4,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 3,
  conditions: { time: 'midday', weather: 'clear' },
  rules: true,
  safetyCar: true,
  ...extra,
});

const run = (world: World, seconds: number): void => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) world.step(SIM_DT);
};

/** From the grid to the race under way. */
const startRace = (world: World): void => {
  run(world, 8);
  expect(world.director!.status.phase).toBe('racing');
};

/** Puts every racer on the track `s` metres round the lap, a few metres apart, and lets the director see it. */
const lineUp = (world: World, s: number): void => {
  const track = world.track!;
  world.cars.forEach((car, i) => {
    const p = track.at(s - i * 30);
    car.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
  });
  world.step(SIM_DT);
};

describe('the safety car', () => {
  it('waits in its box with the race rules, and has no place in an elimination race or a qualifying', () => {
    const world = World.forSession(config());
    const sc = world.safetyCar!;
    expect(sc).not.toBeNull();
    expect(sc.status.phase).toBe('none');
    expect(sc.car.retired).toBe(true);
    expect(world.snapshotCount).toBe(4);
    expect(world.director!.status.safetyCar).toBe(sc.status);
    expect(World.forSession(config({ safetyCar: undefined })).safetyCar).toBeNull();
    expect(World.forSession(config({ elimination: 20 })).safetyCar).toBeNull();
    expect(World.forSession(config({ qualifying: 1 })).safetyCar).toBeNull();
    expect(World.forSession(config({ safetyCar: undefined })).snapshotCount).toBe(3);
  });

  it('comes out ahead of the leader once a yellow has stood, and the field holds station at its speed', () => {
    const world = World.forSession(config());
    startRace(world);
    // A rival stops on the track: its sector goes yellow, and after a while the safety car is called.
    const stopped = world.cars[2]!;
    world.drivers[2] = null;
    stopped.setInput({ ...neutralInput(), brake: 1 });
    run(world, 2);
    const status = world.director!.status;
    // Rolling to a stop, the yellow, then the wait for the call.
    run(world, 30);
    expect(status.yellow).toBeGreaterThanOrEqual(0);
    const sc = world.safetyCar!;
    expect(sc.status.phase).toBe('out');
    expect(sc.status.deployments).toBe(1);
    expect(sc.car.retired).toBe(false);
    expect(sc.active).toBe(true);
    // Just ahead of the leader on the track, and everyone running is shown the board.
    const track = world.track!;
    const leader = status.order.find((i) => !status.cars[i]!.finished)!;
    const leaderS = track.project(world.cars[leader]!.pos.x, world.cars[leader]!.pos.z).s;
    const scS = track.project(sc.car.pos.x, sc.car.pos.z).s;
    const ahead = (scS - leaderS + track.length) % track.length;
    expect(ahead).toBeGreaterThan(0);
    expect(ahead).toBeLessThan(400);
    expect(status.cars[0]!.flag).toBe('safety');
    expect(status.cars[1]!.flag).toBe('safety');
    expect(world.drivers[1]!.limit).toBe(SAFETY_CAR_SPEED);
    expect(world.drivers[1]!.holdStation).toBe(true);
    // The safety car keeps to its speed.
    run(world, 10);
    expect(sc.car.forwardSpeed()).toBeLessThanOrEqual(SAFETY_CAR_SPEED + 1);
    expect(sc.car.forwardSpeed()).toBeGreaterThan(5);
    expect(world.cars[1]!.forwardSpeed()).toBeLessThanOrEqual(SAFETY_CAR_SPEED + 2);
    expect(SAFETY_CAR_AFTER).toBeGreaterThan(0);
  });

  it('penalises the player for passing a car under it', () => {
    const world = World.forSession(config());
    startRace(world);
    const track = world.track!;
    lineUp(world, 600);
    expect(world.deploySafetyCar()).toBeUndefined();
    const status = world.director!.status;
    expect(status.safetyCar!.phase).toBe('out');
    run(world, 0.5);
    // The player, just behind the last car, jumps ahead of it (and of nobody else).
    const rival = track.project(world.cars[2]!.pos.x, world.cars[2]!.pos.z).s;
    const behind = track.at(rival - 20);
    world.cars[0]!.teleport({ x: behind.x, z: behind.z, yaw: Math.atan2(-behind.tx, -behind.tz) });
    run(world, 0.25);
    expect(status.cars[0]!.penalty).toBe(0);
    const p = track.at(rival + 12);
    world.cars[0]!.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
    run(world, 0.25);
    expect(status.cars[0]!.penalty).toBe(SAFETY_CAR_PENALTY);
    expect(status.cars[0]!.penaltyFor).toBe('safetyCar');
  });

  it('comes in after its laps: into the pit lane, the race goes green and it is back in its box', () => {
    const world = World.forSession(config());
    startRace(world);
    const track = world.track!;
    const sc = world.safetyCar!;
    // Lined up just before the pit entry, so a lead of no laps ends at once.
    lineUp(world, track.length - PIT_ENTRY - 220);
    sc.lapsToLead = 0;
    world.deploySafetyCar();
    const status = world.director!.status;
    expect(status.safetyCar!.phase).toBe('out');
    run(world, 0.5);
    expect(status.safetyCar!.phase).toBe('in');
    expect(status.cars[0]!.flag).toBe('safety');
    // To the entry, and onto the rails: green.
    let green = false;
    for (let t = 0; t < 40 && !green; t += 0.5) {
      run(world, 0.5);
      green = status.safetyCar!.phase === 'none';
    }
    expect(green).toBe(true);
    expect(sc.active).toBe(true);
    expect(sc.car.onRails).toBe(true);
    expect(world.drivers[1]!.limit).toBe(Infinity);
    expect(world.drivers[1]!.holdStation).toBe(false);
    expect(status.cars[0]!.flag).not.toBe('safety');
    // Down the lane to its box, out of sight.
    run(world, 25);
    expect(sc.active).toBe(false);
    expect(sc.car.retired).toBe(true);
    expect(sc.status.deployments).toBe(1);
    // A restart empties the count.
    world.restartSession(0);
    expect(sc.status.deployments).toBe(0);
    expect(sc.status.phase).toBe('none');
  });
});
