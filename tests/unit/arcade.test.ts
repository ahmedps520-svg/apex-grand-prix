import { describe, expect, it } from 'vitest';
import { rotateV } from '../../src/shared/math';
import {
  C,
  CAR_STRIDE,
  FLAG_NITRO,
  SIM_DT,
  defaultAids,
  neutralInput,
  type DriverInput,
  type HandlingMode,
  type SessionConfig,
} from '../../src/shared/protocol';
import { arcadePace } from '../../src/sim/race/AiDriver';
import type { Car } from '../../src/sim/vehicle/car';
import { World } from '../../src/sim/world';

const config = (): SessionConfig => ({
  mode: 'free',
  trackId: '',
  carId: 'gt',
  location: 'loop',
  opponents: 0,
  laps: 0,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 1,
});

const world = (handling: HandlingMode): World => {
  const w = World.forSession(config());
  w.setHandling(handling);
  return w;
};

const drive = (w: World, seconds: number, input: Partial<DriverInput>): void => {
  w.setInputs([{ ...neutralInput(), ...input }]);
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) w.step(SIM_DT);
};

const heading = (car: Car): number => {
  const f = rotateV({ x: 0, y: 0, z: 0 }, car.rot, { x: 0, y: 0, z: -1 });
  return Math.atan2(-f.x, -f.z);
};

const turned = (a: number, b: number): number => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d);
};

describe('arcade handling', () => {
  it('leaves the sim alone: no nitro, nothing in the snapshot', () => {
    const w = world('sim');
    drive(w, 1, { throttle: 1, nitro: true });
    const car = w.cars[0]!;
    expect(car.arcade).toBe(false);
    expect(car.nitroOn).toBe(false);
    const buf = new Float32Array(CAR_STRIDE);
    car.writeSnapshot(buf, 0);
    expect(buf[C.NITRO]).toBe(-1);
  });

  it('burns nitro while the button is held on the throttle, then refills it', () => {
    const w = world('arcade');
    drive(w, 2, { throttle: 1, nitro: true });
    const car = w.cars[0]!;
    expect(car.nitroOn).toBe(true);
    expect(car.nitro).toBeLessThan(0.7);
    const buf = new Float32Array(CAR_STRIDE);
    car.writeSnapshot(buf, 0);
    expect(buf[C.NITRO]).toBeCloseTo(car.nitro, 3);
    expect(buf[C.FLAGS]! & FLAG_NITRO).toBeTruthy();
    const left = car.nitro;
    drive(w, 3, { throttle: 1, nitro: false });
    expect(car.nitroOn).toBe(false);
    expect(car.nitro).toBeGreaterThan(left);
  });

  it('is quicker off the line on nitro than the sim car', () => {
    const sim = world('sim');
    const arcade = world('arcade');
    drive(sim, 4, { throttle: 1, nitro: true });
    drive(arcade, 4, { throttle: 1, nitro: true });
    const simSpeed = Math.abs(sim.cars[0]!.forwardSpeed());
    const arcadeSpeed = Math.abs(arcade.cars[0]!.forwardSpeed());
    expect(arcadeSpeed).toBeGreaterThan(simSpeed * 1.05);
  });

  it('turns harder at speed, and holds a slide instead of spinning', () => {
    const sim = world('sim');
    const arcade = world('arcade');
    for (const w of [sim, arcade]) drive(w, 5, { throttle: 1 });
    const results = [sim, arcade].map((w) => {
      const car = w.cars[0]!;
      const before = heading(car);
      drive(w, 2, { throttle: 0.6, steer: 0.7 });
      return turned(before, heading(car));
    });
    expect(results[1]).toBeGreaterThan(results[0]!);
    // Two seconds of hard steering never spins the arcade car round.
    expect(results[1]).toBeLessThan(Math.PI);
  });
});

describe('the arcade rubber band', () => {
  it("bends a rival's pace by its gap to the player, within limits", () => {
    expect(arcadePace(0)).toBe(1);
    expect(arcadePace(0.1)).toBeCloseTo(1.035, 6);
    expect(arcadePace(-0.1)).toBeCloseTo(0.965, 6);
    expect(arcadePace(2)).toBe(1.1);
    expect(arcadePace(-2)).toBe(0.9);
    expect(arcadePace(Number.NaN)).toBe(1);
  });

  it('pulls the rivals in an arcade race and leaves a sim race alone', () => {
    const race = (handling: 'sim' | 'arcade'): World => {
      const world = World.forSession({
        mode: 'race',
        trackId: 'merriford-park',
        carId: 'gt',
        location: 'loop',
        opponents: 2,
        laps: 2,
        difficulty: 'medium',
        gridSlot: 0,
        aids: defaultAids(),
        seed: 3,
        handling,
      });
      world.setHandling(handling);
      return world;
    };
    for (const handling of ['sim', 'arcade'] as const) {
      const world = race(handling);
      const status = world.director!.status;
      // Racing, with the player half a lap up the road.
      status.phase = 'racing';
      status.cars[0]!.progress = 1.5;
      status.cars[1]!.progress = 1.0;
      status.cars[2]!.progress = 1.7;
      world.rubberBand();
      const scales = [1, 2].map((i) => world.drivers[i]!.paceScale);
      if (handling === 'arcade') {
        expect(scales[0]).toBeGreaterThan(1);
        expect(scales[1]).toBeLessThan(1);
      } else {
        expect(scales).toEqual([1, 1]);
      }
    }
  });
});
