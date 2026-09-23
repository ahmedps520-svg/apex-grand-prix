import { SPAWN } from '../content/testGround';
import { CAR_STRIDE, neutralInput, type DriverInput } from '../shared/protocol';
import { TestGround, type Surface } from './track/surface';
import { Car } from './vehicle/car';
import { TEST_MULE } from './vehicle/spec';

/** Everything that is simulated: the ground and the cars. Pure logic, no DOM or rendering. */
export class World {
  readonly surface: Surface;
  readonly cars: Car[];
  /** Messages for the main thread (e.g. a car was reset after invalid numbers). */
  readonly warnings: string[] = [];

  constructor(playerCount = 1, surface: Surface = new TestGround()) {
    this.surface = surface;
    this.cars = [];
    for (let i = 0; i < Math.max(playerCount, 1); i++) {
      this.cars.push(new Car(TEST_MULE, { x: SPAWN.x + i * 6, z: SPAWN.z, yaw: SPAWN.yaw }));
    }
  }

  setInputs(inputs: readonly DriverInput[]): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i]!.input = inputs[i] ?? neutralInput();
  }

  storePrevious(): void {
    for (const car of this.cars) car.storePrevious();
  }

  step(dt: number): void {
    for (const car of this.cars) {
      car.step(dt, this.surface);
      if (!car.isFinite()) {
        // Never let invalid numbers reach the renderer. This is a bug if it ever happens.
        car.reset();
        this.warnings.push('Physics produced invalid numbers; the car was reset.');
      }
    }
  }

  writeSnapshot(out: Float32Array): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i]!.writeSnapshot(out, i * CAR_STRIDE);
  }
}
