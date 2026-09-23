import type { Conditions } from '../content/conditions';
import type { RaceStatus } from '../sim/race/RaceDirector';

/**
 * Messages between the main thread and the simulation worker, plus the layout of the snapshot
 * buffer. Snapshots are Float32Arrays handed back and forth (transferred, never copied); the
 * main thread returns each buffer with a later `tick` so the worker can reuse it.
 */

export const SIM_HZ = 400;
export const SIM_DT = 1 / SIM_HZ;
/**
 * The most simulated time one tick may catch up. Frames up to 250 ms (4 fps) are simulated in
 * full so the game stays real-time on slow devices; a longer stall (debugger, tab switch) is
 * dropped instead, so a hitch can never snowball into more and more steps.
 */
export const MAX_FRAME_DELTA = 0.25;

/** Where steering input comes from; the simulation treats each differently. */
export type SteerMode = 'keyboard' | 'pad' | 'wheel';

/** One human driver's controls, sampled on the main thread once per display frame. */
export interface DriverInput {
  steerMode: SteerMode;
  /** Keyboard / pad: -1 = full left … +1 = full right (already shaped by the input layer). */
  steer: number;
  /** Wheel: steering-wheel angle in radians (+ = right), mapped 1:1 through the steering rack. */
  wheelAngle: number;
  /** 0…1 */
  throttle: number;
  /** 0…1 */
  brake: number;
  /** 0…1 */
  handbrake: number;
  /** Clutch pedal, 0 = released (engaged) … 1 = fully pressed. 0 when no clutch pedal is bound. */
  clutch: number;
  /** Gear-change presses since the previous frame (manual gearbox). */
  shiftUp: number;
  shiftDown: number;
  /** DRS and ERS boost presses since the previous frame (cars that have them). */
  drs: number;
  boost: number;
  /** Light switch presses since the previous frame: headlights, indicators, hazards. */
  lights: number;
  indicatorLeft: number;
  indicatorRight: number;
  hazards: number;
  /** The horn is held. */
  horn: boolean;
}

export const neutralInput = (): DriverInput => ({
  steerMode: 'pad',
  steer: 0,
  wheelAngle: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  clutch: 0,
  shiftUp: 0,
  shiftDown: 0,
  drs: 0,
  boost: 0,
  lights: 0,
  indicatorLeft: 0,
  indicatorRight: 0,
  hazards: 0,
  horn: false,
});

export type AidLevel = 'off' | 'low' | 'high';
export type GearboxMode = 'auto' | 'manual';
export type SteerSmoothing = 'low' | 'medium' | 'high';

/** Driver aids and steering feel, set from the settings / quick menu. */
export interface DriverAids {
  abs: AidLevel;
  tc: AidLevel;
  gearbox: GearboxMode;
  /** Pad/keyboard steering: scales the speed-sensitive steering range (0.5 … 1.5). */
  steerSensitivity: number;
  /** Pad steering smoothing. */
  steerSmoothing: SteerSmoothing;
}

export const defaultAids = (): DriverAids => ({
  abs: 'high',
  tc: 'high',
  gearbox: 'auto',
  steerSensitivity: 1,
  steerSmoothing: 'medium',
});

/** Named places on the proving ground to jump to. */
export type SpawnPoint = 'loop' | 'drag' | 'skidpad';

export type GameMode = 'race' | 'timeTrial' | 'free' | 'roam';
/** Where a free-roam drive starts in the open world. */
export type RoamStart = 'downtown' | 'highway' | 'suburbs' | 'port' | 'mountain' | 'circuit';
export type Difficulty = 'easy' | 'medium' | 'hard' | 'expert';

/** Everything the simulation needs to set up a session. Car 0 is always the player. */
export interface SessionConfig {
  mode: GameMode;
  /** Circuit for races and time trials ('' = the proving ground). */
  trackId: string;
  /** Car model for every car in the session (see sim/vehicle/cars). */
  carId: string;
  /** Mixed fields: the car model for each car by index (car 0 is the player's). */
  fieldCars?: string[];
  /** Free drive start on the proving ground. */
  location: SpawnPoint;
  /** Free roam start in the open world. */
  roamStart?: RoamStart;
  /** Free roam: traffic cars sharing the world (slots after the player in the snapshot). */
  traffic?: number;
  opponents: number;
  laps: number;
  difficulty: Difficulty;
  /** Player's grid position, 0 = pole. */
  gridSlot: number;
  aids: DriverAids;
  seed: number;
  /** Menu background: the AI drives every car, including car 0. */
  attract?: boolean;
  /** Track grip for the weather: 1 dry, lower when wet. */
  grip?: number;
  /** How much impacts damage the cars: 0 = off, 0.5 = light, 1 = full. */
  damage?: number;
  /** Time of day and weather, for the scenery (the simulation only uses `grip`). */
  conditions?: Conditions;
}

export type SimCommand =
  | { kind: 'resetCar'; car: number }
  | { kind: 'teleport'; car: number; to: SpawnPoint }
  | { kind: 'setAids'; car: number; aids: DriverAids }
  | { kind: 'restart' }
  /** Keeps the cars on the grid (true) or lets the start sequence run (false). */
  | { kind: 'holdStart'; hold: boolean };

export type MainToWorker =
  | { type: 'init'; session: SessionConfig }
  | { type: 'session'; session: SessionConfig }
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
  /** Race state for the HUD (null in free drive). */
  race: RaceStatus | null;
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
  /** Longitudinal slip ratio (+ = spinning, - = locking). */
  SLIP_RATIO: 9,
  /** Slip angle in radians (+ = contact patch sliding right). */
  SLIP_ANGLE: 10,
  /** Surface id under the tyre (see SURFACE in sim/track/surface). */
  SURFACE: 11,
  /** Camber relative to the road in radians (- = top of the wheel leaning inwards). */
  CAMBER: 12,
} as const;
export const WHEEL_STRIDE = 13;
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
  /** Throttle and brake as applied to the car (after smoothing), 0…1. */
  THROTTLE: 20,
  BRAKE: 21,
  /** Steering actually applied, as a fraction of full steering lock (-1…1). */
  STEER: 22,
  HANDBRAKE: 23,
  /** Bit flags, see FLAG_*. */
  FLAGS: 24,
  /** Acceleration felt by the driver in the car's frame, m/s² (forward +, right +). */
  ACCEL_LONG: 25,
  ACCEL_LAT: 26,
  /** Average front road-wheel angle, radians. */
  STEER_ANGLE: 27,
  /** Largest road-wheel angle the steering allows right now (pads: speed-sensitive). */
  STEER_AUTHORITY: 28,
  /** Clutch engagement, 0 = open … 1 = fully engaged. */
  CLUTCH: 29,
  /** 1 = manual gearbox. */
  GEARBOX_MANUAL: 30,
  /** Aid levels: 0 = off, 1 = low, 2 = high. */
  TC_LEVEL: 31,
  ABS_LEVEL: 32,
  /** Damage, 0 … 1 (steering signed: + = pulls right). */
  DAMAGE_AERO: 33,
  DAMAGE_ENGINE: 34,
  DAMAGE_STEER: 35,
  /** DRS: 0 = none here, 1 = allowed, 2 = open. */
  DRS: 36,
  /** ERS battery (0 … 1, or -1 for cars without one) and 1 while boosting. */
  ERS: 37,
  ERS_BOOST: 38,
  WHEELS: 39,
} as const;
export const CAR_STRIDE = C.WHEELS + WHEEL_COUNT * WHEEL_STRIDE;

export const FLAG_ABS = 1;
export const FLAG_TC = 2;
export const FLAG_SHIFTING = 4;
export const FLAG_UPSIDE_DOWN = 8;
export const FLAG_LIMITER = 16;
/** A downshift was refused because it would over-rev the engine. */
export const FLAG_SHIFT_DENIED = 32;
/** Lights and horn (free roam): headlights on, indicators, hazards, horn sounding. */
export const FLAG_HEADLIGHTS = 64;
export const FLAG_INDICATOR_LEFT = 128;
export const FLAG_INDICATOR_RIGHT = 256;
export const FLAG_HAZARDS = 512;
export const FLAG_HORN = 1024;

export const aidLevelNumber = (level: AidLevel): number =>
  level === 'off' ? 0 : level === 'low' ? 1 : 2;

export const snapshotFloats = (carCount: number): number => carCount * CAR_STRIDE;
export const snapshotBytes = (carCount: number): number =>
  snapshotFloats(carCount) * Float32Array.BYTES_PER_ELEMENT;

/** Wheel order used everywhere: front-left, front-right, rear-left, rear-right. */
export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;
