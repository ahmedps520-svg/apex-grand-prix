import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/shared/protocol';
import { AiDriver } from '../../src/sim/race/AiDriver';
import { resolveCarContacts } from '../../src/sim/race/collisions';
import { RaceDirector } from '../../src/sim/race/RaceDirector';
import { computeRacingLine } from '../../src/sim/race/racingLine';
import { SURFACE } from '../../src/sim/track/surface';
import { Track, type TrackDef } from '../../src/sim/track/Track';
import { Car } from '../../src/sim/vehicle/car';
import { TEST_MULE } from '../../src/sim/vehicle/spec';

/** A straight (turn 0) or an arc of radius `size` turning `turn` degrees (+ = right). */
type Segment = readonly [size: number, turn: number];

/** Turtle walk from (0, 0) heading +x, with a point every ~8 m. */
function trace(segments: readonly Segment[]) {
  let x = 0;
  let z = 0;
  let heading = 0;
  const points: Array<[number, number]> = [];
  for (const [size, turn] of segments) {
    const angle = (turn * Math.PI) / 180;
    const length = turn === 0 ? size : Math.abs(angle) * size;
    const count = Math.max(Math.round(length / 8), 1);
    for (let i = 0; i < count; i++) {
      points.push([x, z]);
      const d = angle / count;
      const chord = turn === 0 ? length / count : 2 * size * Math.sin(Math.abs(d) / 2);
      x += Math.cos(heading + d / 2) * chord;
      z += Math.sin(heading + d / 2) * chord;
      heading += d;
    }
  }
  return { points, x, z };
}

/**
 * ~800 × 300 m rounded rectangle: a main straight, two quick right-handers, a back straight
 * with a kink, then a hook down past the start with an 18 m hairpin and a left-hander back onto
 * the main straight. The last two straights are sized so the loop closes.
 */
function testTrack(): Track {
  const layout = (west: number, main: number): Segment[] => [
    [300, 0],
    [60, 90],
    [150, 0],
    [50, 90],
    [300, 0],
    [150, -20],
    [150, 20],
    [250, 0],
    [40, 90],
    [west, 0],
    [18, 180],
    [30, 0],
    [40, -90],
    [main, 0],
  ];
  const open = trace(layout(0, 0));
  const def: TrackDef = {
    id: 'test-loop',
    name: 'Test Loop',
    description: 'Unit-test circuit',
    location: 'Nowhere',
    points: trace(layout(open.z, -open.x)).points,
    width: 12,
    runoff: 8,
    laps: 3,
    theme: {
      grass: 0x335522,
      runoffSurface: 'grass',
      sunElevation: 40,
      sunAzimuth: 120,
      fog: 0xcccccc,
      trees: 0,
      barrier: 0xffffff,
    },
  };
  return new Track(def);
}

const track = testTrack();
const line = computeRacingLine(track);

/** Steps AI cars the way the game does; `onStep` sees every step after the director. */
function race(
  cars: Car[],
  drivers: AiDriver[],
  director: RaceDirector | null,
  seconds: number,
  onStep: (t: number) => boolean | void,
): void {
  for (let step = 0, t = 0; step < seconds / SIM_DT; step++, t += SIM_DT) {
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i]!;
      car.setInput(drivers[i]!.drive(car, cars, SIM_DT));
      car.holdForStart = director?.holding(i) ?? false;
      car.step(SIM_DT, track);
    }
    resolveCarContacts(cars);
    director?.update(SIM_DT, cars);
    if (onStep(t)) return;
  }
}

describe('racing line', () => {
  it('stays on the road with finite, positive target speeds', () => {
    const n = track.samples.length;
    expect(line.lateral.length).toBe(n);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(line.lateral[i]!)).toBeLessThanOrEqual(track.halfWidth - 1.4 + 1e-4);
      const v = line.speed[i]!;
      expect(Number.isFinite(v) && v > 5 && v <= 85).toBe(true);
      const p = track.project(line.x[i]!, line.z[i]!, i);
      expect(Math.abs(p.lateral - line.lateral[i]!)).toBeLessThan(0.05);
    }
    // Faster than driving the centre line at the same grip; slowest in the hairpin.
    expect(line.lapTime).toBeGreaterThan(40);
    expect(line.lapTime).toBeLessThan(60);
    expect(Math.min(...line.speed)).toBeLessThan(20);
  });
});

describe('AI driver', () => {
  it('laps cleanly: no barriers, (almost) no grass, at a plausible pace', () => {
    const car = new Car(TEST_MULE, track.gridSlot(0), track);
    const ai = new AiDriver(track, line, { skill: 0.95, seed: 7 });
    const director = new RaceDirector(track, 1, 'free', 0);
    let grass = 0;
    let wall = 0;
    race([car], [ai], director, 150, () => {
      if (car.wheels.some((w) => w.contact && w.surface === SURFACE.GRASS)) grass += SIM_DT;
      if (car.impactForce > 0) wall++;
      expect(ai.needsReset).toBe(false);
      return director.status.cars[0]!.lap >= 2;
    });
    const state = director.status.cars[0]!;
    expect(state.lap).toBe(2);
    expect(wall).toBe(0);
    expect(grass).toBeLessThan(0.5);
    // Flying lap: well over 25 m/s on average, within 8 % of the line's plan at 95 % pace.
    expect(track.length / state.lastLap).toBeGreaterThan(25);
    expect(state.lastLap).toBeLessThan(line.lapTime * 1.08);
    expect(state.bestLap).toBeGreaterThan(line.lapTime);
  });
});

describe('race director', () => {
  it('counts down, starts, counts laps and orders the finish', () => {
    const count = 3;
    const cars: Car[] = [];
    const drivers: AiDriver[] = [];
    for (let i = 0; i < count; i++) {
      cars.push(new Car(TEST_MULE, track.gridSlot(i), track));
      drivers.push(new AiDriver(track, line, { skill: 0.97 - i * 0.04, seed: 100 + i }));
    }
    const director = new RaceDirector(track, count, 'race', 1, 5);
    director.restart(cars, 1);
    const status = director.status;
    // Player (car 0) in slot 1, the others fill slots 0 and 2.
    expect(status.order).toEqual([1, 0, 2]);
    expect(director.holding(0)).toBe(true);
    let maxLights = 0;
    let goAt = -1;
    let heldMoved = 0;
    race(cars, drivers, director, 140, (t) => {
      maxLights = Math.max(maxLights, status.lights);
      if (goAt < 0 && status.go) goAt = t;
      if (goAt < 0) heldMoved = Math.max(heldMoved, Math.hypot(cars[0]!.vel.x, cars[0]!.vel.z));
      return status.phase === 'finished';
    });
    expect(maxLights).toBe(5);
    // 2 s on the grid, a light a second, then 0.4–1.4 s to lights out.
    expect(goAt).toBeGreaterThan(6.4);
    expect(goAt).toBeLessThan(7.5);
    expect(heldMoved).toBeLessThan(0.2);
    expect(status.phase).toBe('finished');
    const finish = status.order.map((i) => status.cars[i]!);
    expect(finish.map((c) => c.position)).toEqual([1, 2, 3]);
    for (const c of finish) {
      expect(c.finished).toBe(true);
      expect(c.lap).toBe(1);
      expect(c.sectorTimes.every((s) => s > 0)).toBe(true);
      expect(c.lastLap).toBeCloseTo(c.finishTime, 6);
    }
    expect(finish[0]!.finishTime).toBeLessThan(finish[1]!.finishTime);
    expect(finish[1]!.finishTime).toBeLessThan(finish[2]!.finishTime);
  });
});

describe('car contacts', () => {
  it('pushes overlapping cars apart without invalid numbers', () => {
    const p = track.at(100);
    const yaw = Math.atan2(-p.tx, -p.tz);
    const a = new Car(TEST_MULE, { x: p.x, z: p.z, yaw }, track);
    // Half a car width to the side, overlapping.
    const b = new Car(TEST_MULE, { x: p.x - p.tz * 1.2, z: p.z + p.tx * 1.2, yaw }, track);
    for (let i = 0; i < 800; i++) {
      a.step(SIM_DT, track);
      b.step(SIM_DT, track);
      resolveCarContacts([a, b]);
    }
    expect(a.isFinite() && b.isFinite()).toBe(true);
    const gap = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
    expect(gap).toBeGreaterThan(2 * TEST_MULE.body.halfWidth - 0.05);
    expect(Math.hypot(a.vel.x, a.vel.z)).toBeLessThan(2);
  });
});
