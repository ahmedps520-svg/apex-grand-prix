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
  /**
   * Distance the tyre rolls to build up its sideways force (carcass relaxation length). Gives
   * realistic, slightly delayed responses and lets a parked tyre act like a spring.
   */
  relaxationLength: number;
  /** Camber thrust: equivalent slip-angle shift per radian of lean. */
  camberThrust: number;
  /** Grip lost per radian² away from the ideal camber when cornering. */
  camberGripLoss: number;
  /** Ideal lean into the corner for maximum cornering grip, radians (positive). */
  idealCamber: number;
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
  /** Static camber, radians (negative = top of the wheel leaning inwards). */
  camber: number;
  /** Camber change per metre of bump travel from static (negative = more negative camber). */
  camberGain: number;
  /** Static toe per wheel, radians (positive = toe-in). */
  toe: number;
  /** Maximum steering angle at the road wheels (0 = not steered). */
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
  /** Automatic mode: shift up above / down below these engine speeds. */
  upshiftRpm: number;
  downshiftRpm: number;
  /** Automatic mode while braking: downshift early so the right gear is ready for the exit. */
  brakingDownshiftRpm: number;
}

/** Clutch-pack limited-slip differential. */
/** Hybrid race cars: a drag-reduction flap and an energy store with an electric motor. */
export interface HybridSpec {
  /** Share of drag and of downforce the open DRS flap removes. */
  drsDrag: number;
  drsDownforce: number;
  /** Electric motor power while boosting, and the battery, W and J. */
  ersPower: number;
  ersCapacity: number;
  /** Power recovered under braking, W. */
  harvestPower: number;
}

/** Where the engine's torque goes; without it, the axles marked `driven` share it. */
export interface DriveSpec {
  /** Share of the torque sent to the front axle: 0 = rear drive, 1 = front drive. */
  frontShare: number;
  /** Centre coupling's locking torque on top of the split, as a fraction of drive torque. */
  centreLock: number;
}

export interface DiffSpec {
  /** Locking torque that is always there, N·m. */
  preload: number;
  /** Extra locking torque as a fraction of the torque going through the diff, on/off power. */
  powerLock: number;
  coastLock: number;
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
  /** Steering-wheel angle per road-wheel angle (a wheel's 1:1 mapping uses this). */
  steeringRatio: number;
  front: AxleSpec;
  rear: AxleSpec;
  engine: EngineSpec;
  gearbox: GearboxSpec;
  diff: DiffSpec;
  /** All-wheel drive split (optional; rear drive when absent and only the rear is driven). */
  drive?: DriveSpec;
  /** DRS and ERS (formula and prototype cars). */
  hybrid?: HybridSpec;
  aero: AeroSpec;
  body: BodySpec;
}

const deg = (d: number): number => (d * Math.PI) / 180;

const SLICK: TyreSpec = {
  muX: 1.65,
  muY: 1.6,
  bX: 20,
  cX: 1.45,
  eX: 0.1,
  bY: 17,
  cY: 1.35,
  eY: 0.15,
  loadSensitivity: 0.12,
  relaxationLength: 0.32,
  camberThrust: 0.12,
  camberGripLoss: 12,
  idealCamber: deg(1.5),
};

/**
 * Test car for Rounds 1–2: a GT3-style mule used to build and tune the vehicle model. Proper
 * cars per class arrive from Round 6.
 */
export const TEST_MULE: CarSpec = {
  name: 'Test Mule GT',
  mass: 1300,
  inertia: { pitch: 2100, yaw: 2300, roll: 560 },
  cogHeight: 0.46,
  // 540° lock to lock at the steering wheel for 26.5° at the road wheels.
  steeringRatio: 10.2,
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
    camber: deg(-3),
    camberGain: deg(-60),
    toe: deg(-0.05),
    maxSteer: deg(26.5),
    ackermann: 0.5,
    brakeTorque: 2_700,
    handbrakeTorque: 0,
    driven: false,
    tyre: SLICK,
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
    camber: deg(-2),
    camberGain: deg(-40),
    toe: deg(0.15),
    maxSteer: 0,
    ackermann: 0,
    brakeTorque: 1_800,
    handbrakeTorque: 3_500,
    driven: true,
    tyre: { ...SLICK, muY: 1.62 },
  },
  engine: {
    torqueCurve: [
      [800, 300],
      [1500, 350],
      [2500, 415],
      [3500, 480],
      [4500, 530],
      [5500, 555],
      [6500, 545],
      [7300, 515],
      [7800, 485],
      [8200, 450],
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
    shiftTime: 0.06,
    upshiftRpm: 7750,
    downshiftRpm: 3900,
    brakingDownshiftRpm: 5600,
  },
  diff: { preload: 60, powerLock: 0.35, coastLock: 0.2 },
  aero: { dragArea: 1.0, downforceArea: 3.0, frontShare: 0.42 },
  body: { halfWidth: 0.98, front: 2.3, rear: 2.25, floor: -0.37, roof: 0.74 },
};
