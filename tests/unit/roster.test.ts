import { describe, expect, it } from 'vitest';
import { SIM_DT, defaultAids, neutralInput, type DriverInput } from '../../src/shared/protocol';
import { TestGround } from '../../src/sim/track/surface';
import { Car } from '../../src/sim/vehicle/car';
import { CARS } from '../../src/sim/vehicle/cars';

const kmh = (car: Car): number => car.forwardSpeed() * 3.6;

function run(car: Car, ground: TestGround, seconds: number, input: Partial<DriverInput>): void {
  car.setInput({ ...neutralInput(), ...input });
  for (let i = 0; i < seconds / SIM_DT; i++) car.step(SIM_DT, ground);
}

/** Every car in the roster accelerates, turns and brakes without the physics misbehaving. */
describe('car roster', () => {
  for (const model of CARS) {
    it(`${model.name} drives`, () => {
      const ground = new TestGround(1e7, 1e7);
      const car = new Car(model.spec, { x: 0, z: 0, yaw: 0 }, ground);
      car.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high', abs: 'high' });
      run(car, ground, 8, { throttle: 1 });
      const fast = kmh(car);
      run(car, ground, 3, { throttle: 0.6, steer: 0.4 });
      run(car, ground, 4, { brake: 1 });
      expect(car.isFinite()).toBe(true);
      expect(fast).toBeGreaterThan(120);
      expect(Math.abs(kmh(car))).toBeLessThan(40);
      // Still on its wheels.
      const q = car.rot;
      const upY = 1 - 2 * (q.x * q.x + q.z * q.z);
      expect(upY).toBeGreaterThan(0.9);
    });
  }
});
