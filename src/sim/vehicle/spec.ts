/**
 * Car specification types. Body frame convention (used by all car data):
 *   x = right, y = up, z = backwards (so the car's nose points along -z).
 * Distances are metres, forces newtons, torques N·m, angles radians.
 */

export interface TyreSpec {
  /** Peak friction coefficients (longitudinal / lateral) at the reference load. */
  muX: number;
  muY: number;
  /** Magic Formula shape factors: B = stiffness, C = shape, E = curvature. */
  bX: number;
  cX: number;
  eX: number;
  bY: number;
  cY: number;
  eY: number;
  /** Fraction of friction lost per +100 % load above the reference load. */
  loadSensitivity: number;
}

export interface AxleSpec {
  /** Distance from the centre of gravity to the axle along the car: front > 0, rear < 0. */
  offset: number;
  halfTrack: number;
  wheelRadius: number;
  /** Rotational inertia of one wheel + tyre + brake disc. */
  wheelInertia: number;
  /** Suspension length (hardpoint → wheel centre) at full droop. */
  maxLength: number;
  /** Total wheel travel. Full bump is at maxLength - travel. */
  travel: number;
  /** Suspension length at static load; together with cogHeight this sets the ride height. */
  staticLength: number;
  /** Spring rate at the wheel, N/m. */
  springRate: number;
  bumpDamping: number;
  reboundDamping: number;
  bumpStopRate: number;
  /** Travel before full bump at which the bump stop starts to engage. */
  bumpStopRange: number;
  /** Anti-roll bar: force per metre of left/right travel difference. */
  antiRollRate: number;
  /** Height above the ground where tyre forces act on the body (roll-centre approximation). */
  rollCentreHeight: number;
  /** Maximum steering angle at the wheel (0 = not steered). */
  maxSteer: number;
  /** 0 = parallel steering … 1 = full Ackermann. */
  ackermann: number;
  /** Brake torque per wheel at full pedal. */
  brakeTorque: number;
  /** Handbrake torque per wheel. */
  handbrakeTorque: number;
  driven: boolean;
  tyre: TyreSpec;
}

export interface EngineSpec {
  /** Full-throttle torque curve as [rpm, N·m] points, rpm ascending. */
  torqueCurve: ReadonlyArray<readonly [number, number]>;
  idleRpm: number;
  /** Fuel is cut above this speed. */
  limiterRpm: number;
  /** Engine + flywheel rotational inertia. */
  inertia: number;
  /** Engine braking torque at zero throttle: base + perRpm × rpm. */
  frictionBase: number;
  frictionPerRpm: number;
}

export interface GearboxSpec {
  ratios: readonly number[];
  reverseRatio: number;
  finalDrive: number;
  efficiency: number;
  /** Seconds without drive while shifting. */
  shiftTime: number;
  upshiftRpm: number;
  downshiftRpm: number;
}

export interface AeroSpec {
  /** Drag coefficient × frontal area, m². */
  dragArea: number;
  /** Downforce coefficient × area, m² (positive = downforce). */
  downforceArea: number;
  /** Share of downforce on the front axle. */
  frontShare: number;
}

export interface BodySpec {
  /** Collision box, body frame, relative to the centre of gravity. */
  halfWidth: number;
  front: number;
  rear: number;
  floor: number;
  roof: number;
}

export interface CarSpec {
  name: string;
  mass: number;
  /** Principal moments of inertia about the body axes. */
  inertia: { pitch: number; yaw: number; roll: number };
  /** Height of the centre of gravity above the ground at static ride height. */
  cogHeight: number;
  front: AxleSpec;
  rear: AxleSpec;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  aero: AeroSpec;
  body: BodySpec;
  /** Viscous coupling between the driven wheels, N·m per rad/s of speed difference. */
  diffViscous: number;
}

/**
 * Round 1 test car: a GT-style mule used to prove the architecture. The full vehicle model and
 * proper tuning arrive in Round 2.
 */
export const TEST_MULE: CarSpec = {
  name: 'Test Mule GT',
  mass: 1300,
  inertia: { pitch: 2100, yaw: 2300, roll: 560 },
  cogHeight: 0.46,
  front: {
    offset: 1.45,
    halfTrack: 0.83,
    wheelRadius: 0.34,
    wheelInertia: 1.1,
    maxLength: 0.17,
    travel: 0.1,
    staticLength: 0.125,
    springRate: 125_000,
    bumpDamping: 5_200,
    reboundDamping: 8_500,
    bumpStopRate: 350_000,
    bumpStopRange: 0.015,
    antiRollRate: 45_000,
    rollCentreHeight: 0.06,
    maxSteer: 0.5,
    ackermann: 0.5,
    brakeTorque: 2_700,
    handbrakeTorque: 0,
    driven: false,
    tyre: {
      muX: 1.65,
      muY: 1.6,
      bX: 20,
      cX: 1.45,
      eX: 0.1,
      bY: 17,
      cY: 1.35,
      eY: 0.15,
      loadSensitivity: 0.12,
    },
  },
  rear: {
    offset: -1.25,
    halfTrack: 0.81,
    wheelRadius: 0.35,
    wheelInertia: 1.3,
    maxLength: 0.17,
    travel: 0.1,
    staticLength: 0.125,
    springRate: 140_000,
    bumpDamping: 5_600,
    reboundDamping: 9_000,
    bumpStopRate: 350_000,
    bumpStopRange: 0.015,
    antiRollRate: 30_000,
    rollCentreHeight: 0.1,
    maxSteer: 0,
    ackermann: 0,
    brakeTorque: 1_800,
    handbrakeTorque: 3_500,
    driven: true,
    tyre: {
      muX: 1.65,
      muY: 1.62,
      bX: 20,
      cX: 1.45,
      eX: 0.1,
      bY: 17,
      cY: 1.35,
      eY: 0.15,
      loadSensitivity: 0.12,
    },
  },
  engine: {
    torqueCurve: [
      [800, 330],
      [1500, 380],
      [2500, 450],
      [3500, 520],
      [4500, 575],
      [5500, 605],
      [6500, 590],
      [7300, 555],
      [7800, 520],
      [8200, 480],
    ],
    idleRpm: 900,
    limiterRpm: 8000,
    inertia: 0.22,
    frictionBase: 25,
    frictionPerRpm: 0.008,
  },
  gearbox: {
    ratios: [3.1, 2.3, 1.82, 1.5, 1.27, 1.1],
    reverseRatio: 2.9,
    finalDrive: 3.2,
    efficiency: 0.9,
    shiftTime: 0.07,
    upshiftRpm: 7750,
    downshiftRpm: 3900,
  },
  aero: { dragArea: 1.0, downforceArea: 3.0, frontShare: 0.42 },
  body: { halfWidth: 0.98, front: 2.3, rear: 2.25, floor: -0.37, roof: 0.74 },
  diffViscous: 60,
};
