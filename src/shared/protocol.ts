/**
 * Messages between the main thread and the simulation worker, plus the layout of the snapshot
 * buffer. Snapshots are Float32Arrays handed back and forth (transferred, never copied); the
 * main thread returns each buffer with a later `tick` so the worker can reuse it.
 */

export const SIM_HZ = 400;
export const SIM_DT = 1 / SIM_HZ;
/**
 * The most simulated time one tick may catch up. A longer stall (debugger, slow frame) is
 * dropped instead of simulated, so a hitch can never snowball into more and more steps.
 */
export const MAX_FRAME_DELTA = 0.1;

/** One human driver's controls, sampled on the main thread once per display frame. */
export interface DriverInput {
  /** -1 = full left … +1 = full right. */
  steer: number;
  /** 0…1 */
  throttle: number;
  /** 0…1 */
  brake: number;
  /** 0…1 */
  handbrake: number;
  /** True when steering comes from on/off keys, so the sim should ramp it smoothly. */
  steerIsDigital: boolean;
}

export const neutralInput = (): DriverInput => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  steerIsDigital: false,
});

export type SimCommand = { kind: 'resetCar'; car: number };

export type MainToWorker =
  | { type: 'init'; playerCount: number }
  | { type: 'tick'; time: number; inputs: DriverInput[]; buffers: ArrayBuffer[] }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'command'; command: SimCommand };

export interface SnapshotMessage {
  type: 'snapshot';
  /** Simulated seconds since the session started. */
  simTime: number;
  /** Total fixed steps executed since the session started. */
  totalSteps: number;
  /** Steps executed for this tick. */
  steps: number;
  /** Blend factor between the previous and current state, always in [0, 1). */
  alpha: number;
  /** Average cost of one world step over the last second, in microseconds. */
  stepCostUs: number;
  carCount: number;
  buffer: ArrayBuffer;
}

export type WorkerToMain =
  | { type: 'ready'; carCount: number }
  | SnapshotMessage
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; stack?: string };

/** Per-wheel block inside a car block. */
export const W = {
  /** Suspension length (hardpoint → wheel centre) in metres, previous / current step. */
  PREV_LENGTH: 0,
  LENGTH: 1,
  /** Steer angle in radians (+ = right). */
  PREV_STEER: 2,
  STEER: 3,
  /** Wheel rotation angle in radians, wrapped to [0, 2π). */
  PREV_SPIN: 4,
  SPIN: 5,
  /** Combined slip: 0 = full grip … ≥ 1 = sliding. Used for effects, audio and rumble. */
  SLIP: 6,
  /** Tyre normal load in newtons. */
  LOAD: 7,
  /** 1 when the tyre touches the ground. */
  CONTACT: 8,
} as const;
export const WHEEL_STRIDE = 9;
export const WHEEL_COUNT = 4;

/** Per-car block. Poses are in world space: x right, y up, z towards the camera. */
export const C = {
  PREV_POS: 0, // 3
  PREV_ROT: 3, // 4 (quaternion x, y, z, w)
  POS: 7, // 3
  ROT: 10, // 4
  VEL: 14, // 3, world-space linear velocity (current)
  /** Signed forward speed in m/s. */
  SPEED: 17,
  RPM: 18,
  /** -1 = reverse, 0 = neutral, 1…n = forward gears. */
  GEAR: 19,
  THROTTLE: 20,
  BRAKE: 21,
  /** Steering actually applied after filtering, -1…1. */
  STEER: 22,
  HANDBRAKE: 23,
  /** Bit flags, see FLAG_*. */
  FLAGS: 24,
  WHEELS: 25,
} as const;
export const CAR_STRIDE = C.WHEELS + WHEEL_COUNT * WHEEL_STRIDE;

export const FLAG_ABS = 1;
export const FLAG_TC = 2;
export const FLAG_SHIFTING = 4;
export const FLAG_UPSIDE_DOWN = 8;
export const FLAG_LIMITER = 16;

export const snapshotFloats = (carCount: number): number => carCount * CAR_STRIDE;
export const snapshotBytes = (carCount: number): number =>
  snapshotFloats(carCount) * Float32Array.BYTES_PER_ELEMENT;

/** Wheel order used everywhere: front-left, front-right, rear-left, rear-right. */
export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;
