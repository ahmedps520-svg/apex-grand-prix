import { describe, expect, it } from 'vitest';
import { TRACKS } from '../../src/content/tracks';
import {
  PIT_BOX,
  PIT_ENTRY,
  PIT_EXIT,
  PIT_LENGTH,
  PIT_TIME,
  laneShare,
} from '../../src/shared/pitLane';
import { SIM_DT } from '../../src/shared/protocol';
import { PIT_WEAR, Pits, type PitRace } from '../../src/sim/race/Pits';
import { Track } from '../../src/sim/track/Track';
import { Car } from '../../src/sim/vehicle/car';
import { TEST_MULE } from '../../src/sim/vehicle/spec';

const track = new Track(TRACKS[0]!);

/** A car just before the lane's entry, rolling along the track. */
function approaching(): Car {
  const car = new Car(TEST_MULE, track.gridSlot(0), track);
  const p = track.at(track.length - PIT_ENTRY - 5);
  const yaw = Math.atan2(-p.tx, -p.tz);
  car.teleport({ x: p.x, z: p.z, yaw });
  car.vel.x = p.tx * 40;
  car.vel.z = p.tz * 40;
  return car;
}

const racing: PitRace = { phase: 'racing', laps: 5, cars: [{ lap: 1, finished: false }] };

describe('the pit lane', () => {
  it('leaves the track, runs beside it and rejoins', () => {
    expect(laneShare(0)).toBe(0);
    expect(laneShare(35)).toBeGreaterThan(0.3);
    expect(laneShare(35)).toBeLessThan(0.7);
    expect(laneShare(200)).toBe(1);
    expect(laneShare(PIT_LENGTH)).toBe(0);
    expect(PIT_ENTRY - PIT_BOX).toBeGreaterThan(0);
  });

  it('takes a car in at the entry, stops it at the box for new tyres, and hands it back', () => {
    const car = approaching();
    car.wearRate = 1;
    for (const w of car.wheels) w.wear = 0.5;
    const pits = new Pits(track, 1, [false]);
    expect(pits.info(0).phase).toBe('none');
    pits.arm(0, true);
    expect(pits.info(0).phase).toBe('armed');
    pits.update(SIM_DT, [car], racing);
    expect(pits.info(0).phase).toBe('in');
    expect(car.onRails).toBe(true);
    let t = 0;
    const run = (until: () => boolean, limit: number) => {
      while (!until() && t < limit) {
        pits.update(SIM_DT, [car], racing);
        t += SIM_DT;
      }
    };
    run(() => pits.info(0).phase !== 'in', 60);
    expect(pits.info(0).phase).toBe('stop');
    // Stopped at the box, in the lane, tyres still worn.
    const atBox = track.project(car.pos.x, car.pos.z);
    expect(Math.abs(atBox.s - (track.length - PIT_BOX))).toBeLessThan(3);
    expect(Math.abs(atBox.lateral - pits.lateral)).toBeLessThan(0.5);
    expect(Math.hypot(car.vel.x, car.vel.z)).toBeLessThan(0.01);
    expect(car.tyreWear).toBeCloseTo(0.5, 6);
    const stoppedAt = t;
    run(() => pits.info(0).phase !== 'stop', 60);
    expect(t - stoppedAt).toBeCloseTo(PIT_TIME, 1);
    expect(pits.info(0).phase).toBe('out');
    expect(car.tyreWear).toBe(0);
    run(() => pits.info(0).phase === 'none', 120);
    expect(pits.info(0).phase).toBe('none');
    expect(car.onRails).toBe(false);
    // Back on the track just after the line, rolling at the lane's limit.
    const out = track.project(car.pos.x, car.pos.z);
    expect(Math.abs(out.s - PIT_EXIT)).toBeLessThan(3);
    expect(Math.abs(out.lateral)).toBeLessThan(0.5);
    expect(Math.hypot(car.vel.x, car.vel.z)).toBeGreaterThan(10);
    expect(t).toBeLessThan(60);
  });

  it('has the AI box once its tyres are gone, with laps enough left', () => {
    const car = approaching();
    car.wearRate = 1;
    for (const w of car.wheels) w.wear = PIT_WEAR + 0.1;
    const ai = new Pits(track, 1, [true]);
    ai.update(SIM_DT, [car], { ...racing, cars: [{ lap: 4, finished: false }] });
    expect(ai.info(0).phase).toBe('none');
    ai.update(SIM_DT, [car], racing);
    expect(['armed', 'in']).toContain(ai.info(0).phase);
    // The player's car is never boxed for them, and fresh tyres never ask for it.
    const player = new Pits(track, 1, [false]);
    player.update(SIM_DT, [car], racing);
    expect(player.info(0).phase).toBe('none');
    for (const w of car.wheels) w.wear = 0.2;
    const fresh = new Pits(track, 1, [true]);
    fresh.update(SIM_DT, [car], racing);
    expect(fresh.info(0).phase).toBe('none');
  });
});
