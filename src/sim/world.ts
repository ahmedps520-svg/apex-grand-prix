import { SPAWN, SPAWNS } from '../content/testGround';
import {
  CAR_STRIDE,
  neutralInput,
  type DriverAids,
  type DriverInput,
  type SpawnPoint,
} from '../shared/protocol';
import { TestGround, type Surface } from './track/surface';
import { Car, type Spawn } from './vehicle/car';
import { TEST_MULE } from './vehicle/spec';

/** Everything that is simulated: the ground and the cars. Pure logic, no DOM or rendering. */
export class World {
  readonly surface: Surface;
  readonly cars: Car[];
  /** Messages for the main thread (e.g. a car was reset after invalid numbers). */
  readonly warnings: string[] = [];
  private readonly neutral = neutralInput();

  constructor(playerCount = 1, surface: Surface = new TestGround(), spawn: Spawn = SPAWN) {
    this.surface = surface;
    this.cars = [];
    for (let i = 0; i < Math.max(playerCount, 1); i++) {
      const at = { x: spawn.x + i * 6, z: spawn.z, yaw: spawn.yaw };
      this.cars.push(new Car(TEST_MULE, at, surface));
    }
  }

  setInputs(inputs: readonly DriverInput[]): void {
    for (let i = 0; i < this.cars.length; i++) this.cars[i]!.setInput(inputs[i] ?? this.neutral);
  }

  setAids(car: number, aids: DriverAids): void {
    this.cars[car]?.setAids(aids);
  }

  teleport(car: number, to: SpawnPoint): void {
    const spawn = SPAWNS[to];
    this.cars[car]?.teleport({ x: spawn.x + car * 6, z: spawn.z, yaw: spawn.yaw });
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
