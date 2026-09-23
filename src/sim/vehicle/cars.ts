import { TEST_MULE, type CarSpec, type TyreSpec } from './spec';

/**
 * The car roster: one car per class for now, each with its own handling. All names are
 * fictional. Races put the whole field in the player's car class.
 */

export type CarStyle = 'gt' | 'formula' | 'prototype' | 'touring' | 'street' | 'suv';

export interface CarModel {
  id: string;
  name: string;
  className: string;
  description: string;
  style: CarStyle;
  spec: CarSpec;
  /** For the car select screen. */
  stats: { power: string; weight: string; topSpeed: string };
  /**
   * How much of its estimated grip the AI's racing line plans with, measured by letting the
   * AI lap the circuits (tools: the calibration run in PLAN.md §10).
   */
  aiGrip: number;
}

const deg = (d: number): number => (d * Math.PI) / 180;

const RACE_SLICK: TyreSpec = {
  muX: 1.72,
  muY: 1.68,
  bX: 20,
  cX: 1.45,
  eX: 0.1,
  bY: 17,
  cY: 1.35,
  eY: 0.15,
  loadSensitivity: 0.14,
  relaxationLength: 0.3,
  camberThrust: 0.12,
  camberGripLoss: 12,
  idealCamber: deg(1.5),
};

const TOURING_SLICK: TyreSpec = { ...RACE_SLICK, muX: 1.48, muY: 1.44, relaxationLength: 0.36 };

const STREET_TYRE: TyreSpec = {
  muX: 1.15,
  muY: 1.1,
  bX: 13,
  cX: 1.5,
  eX: 0.2,
  bY: 11,
  cY: 1.4,
  eY: 0.25,
  loadSensitivity: 0.12,
  relaxationLength: 0.5,
  camberThrust: 0.1,
  camberGripLoss: 8,
  idealCamber: deg(1),
};

const FORMULA: CarSpec = {
  name: 'Apex F2000',
  mass: 690,
  inertia: { pitch: 800, yaw: 900, roll: 230 },
  cogHeight: 0.28,
  steeringRatio: 11,
  front: {
    offset: 1.7,
    halfTrack: 0.8,
    wheelRadius: 0.33,
    wheelInertia: 0.8,
    maxLength: 0.12,
    travel: 0.07,
    staticLength: 0.095,
    springRate: 150_000,
    bumpDamping: 4_200,
    reboundDamping: 6_800,
    bumpStopRate: 400_000,
    bumpStopRange: 0.012,
    antiRollRate: 30_000,
    rollCentreHeight: 0.03,
    camber: deg(-3),
    camberGain: deg(-50),
    toe: deg(-0.05),
    maxSteer: deg(22),
    ackermann: 0.3,
    brakeTorque: 1_900,
    handbrakeTorque: 0,
    driven: false,
    tyre: { ...RACE_SLICK, muX: 1.78, muY: 1.72 },
  },
  rear: {
    offset: -1.4,
    halfTrack: 0.78,
    wheelRadius: 0.34,
    wheelInertia: 1.0,
    maxLength: 0.12,
    travel: 0.07,
    staticLength: 0.095,
    springRate: 165_000,
    bumpDamping: 4_600,
    reboundDamping: 7_200,
    bumpStopRate: 400_000,
    bumpStopRange: 0.012,
    antiRollRate: 20_000,
    rollCentreHeight: 0.06,
    camber: deg(-2),
    camberGain: deg(-35),
    toe: deg(0.2),
    maxSteer: 0,
    ackermann: 0,
    brakeTorque: 1_350,
    handbrakeTorque: 2_500,
    driven: true,
    tyre: { ...RACE_SLICK, muX: 1.78, muY: 1.74 },
  },
  engine: {
    torqueCurve: [
      [1000, 200],
      [3000, 300],
      [5000, 380],
      [7000, 425],
      [8500, 405],
      [9500, 365],
    ],
    idleRpm: 1500,
    limiterRpm: 9500,
    inertia: 0.1,
    frictionBase: 20,
    frictionPerRpm: 0.006,
  },
  gearbox: {
    ratios: [2.9, 2.2, 1.78, 1.48, 1.27, 1.12],
    reverseRatio: 2.8,
    finalDrive: 3.4,
    efficiency: 0.92,
    shiftTime: 0.04,
    upshiftRpm: 9200,
    downshiftRpm: 5200,
    brakingDownshiftRpm: 7000,
  },
  diff: { preload: 40, powerLock: 0.3, coastLock: 0.15 },
  aero: { dragArea: 1.1, downforceArea: 4.2, frontShare: 0.42 },
  hybrid: {
    drsDrag: 0.18,
    drsDownforce: 0.22,
    ersPower: 90_000,
    ersCapacity: 2_500_000,
    harvestPower: 90_000,
  },
  body: { halfWidth: 0.95, front: 2.4, rear: 1.9, floor: -0.2, roof: 0.7 },
};

const PROTOTYPE: CarSpec = {
  name: 'Nova LMP',
  mass: 950,
  inertia: { pitch: 1300, yaw: 1500, roll: 360 },
  cogHeight: 0.32,
  steeringRatio: 11,
  front: {
    ...FORMULA.front,
    offset: 1.55,
    halfTrack: 0.82,
    wheelRadius: 0.34,
    springRate: 180_000,
    bumpDamping: 5_000,
    reboundDamping: 8_000,
    antiRollRate: 35_000,
    maxSteer: deg(22),
    brakeTorque: 2_600,
    tyre: RACE_SLICK,
  },
  rear: {
    ...FORMULA.rear,
    offset: -1.45,
    halfTrack: 0.8,
    wheelRadius: 0.35,
    springRate: 200_000,
    bumpDamping: 5_400,
    reboundDamping: 8_600,
    antiRollRate: 25_000,
    brakeTorque: 1_900,
    handbrakeTorque: 3_000,
    tyre: { ...RACE_SLICK, muY: 1.7 },
  },
  engine: {
    torqueCurve: [
      [1200, 330],
      [3000, 450],
      [5000, 580],
      [6500, 620],
      [8000, 570],
      [9000, 510],
    ],
    idleRpm: 1200,
    limiterRpm: 9000,
    inertia: 0.15,
    frictionBase: 22,
    frictionPerRpm: 0.007,
  },
  gearbox: {
    ratios: [2.7, 2.05, 1.66, 1.4, 1.2, 1.06],
    reverseRatio: 2.7,
    finalDrive: 3.3,
    efficiency: 0.92,
    shiftTime: 0.04,
    upshiftRpm: 8700,
    downshiftRpm: 4800,
    brakingDownshiftRpm: 6600,
  },
  diff: { preload: 50, powerLock: 0.32, coastLock: 0.18 },
  aero: { dragArea: 0.95, downforceArea: 3.8, frontShare: 0.44 },
  hybrid: {
    drsDrag: 0.12,
    drsDownforce: 0.15,
    ersPower: 120_000,
    ersCapacity: 3_000_000,
    harvestPower: 120_000,
  },
  body: { halfWidth: 1.0, front: 2.35, rear: 2.35, floor: -0.25, roof: 0.8 },
};

const TOURING: CarSpec = {
  ...TEST_MULE,
  name: 'Stallion TR',
  mass: 1250,
  inertia: { pitch: 1900, yaw: 2100, roll: 520 },
  cogHeight: 0.5,
  front: {
    ...TEST_MULE.front,
    offset: 1.3,
    halfTrack: 0.8,
    springRate: 95_000,
    bumpDamping: 4_600,
    reboundDamping: 7_400,
    antiRollRate: 40_000,
    brakeTorque: 2_300,
    tyre: TOURING_SLICK,
  },
  rear: {
    ...TEST_MULE.rear,
    offset: -1.4,
    halfTrack: 0.79,
    springRate: 100_000,
    bumpDamping: 4_800,
    reboundDamping: 7_800,
    antiRollRate: 25_000,
    brakeTorque: 1_500,
    tyre: { ...TOURING_SLICK, muY: 1.46 },
  },
  engine: {
    torqueCurve: [
      [900, 220],
      [2000, 330],
      [3000, 400],
      [4500, 420],
      [6000, 380],
      [7000, 330],
    ],
    idleRpm: 900,
    limiterRpm: 7000,
    inertia: 0.2,
    frictionBase: 22,
    frictionPerRpm: 0.008,
  },
  gearbox: {
    ratios: [3.0, 2.2, 1.7, 1.38, 1.15, 0.98],
    reverseRatio: 2.9,
    finalDrive: 3.9,
    efficiency: 0.9,
    shiftTime: 0.06,
    upshiftRpm: 6800,
    downshiftRpm: 3400,
    brakingDownshiftRpm: 4900,
  },
  aero: { dragArea: 1.0, downforceArea: 1.0, frontShare: 0.45 },
  body: { halfWidth: 0.95, front: 2.3, rear: 2.2, floor: -0.4, roof: 0.95 },
};

const STREET: CarSpec = {
  ...TEST_MULE,
  name: 'Aurora S',
  mass: 1480,
  inertia: { pitch: 2400, yaw: 2600, roll: 600 },
  cogHeight: 0.5,
  steeringRatio: 13,
  front: {
    ...TEST_MULE.front,
    offset: 1.25,
    halfTrack: 0.79,
    maxLength: 0.2,
    travel: 0.13,
    staticLength: 0.14,
    springRate: 48_000,
    bumpDamping: 3_000,
    reboundDamping: 4_600,
    bumpStopRate: 250_000,
    antiRollRate: 22_000,
    camber: deg(-1),
    camberGain: deg(-25),
    maxSteer: deg(33),
    brakeTorque: 2_200,
    tyre: STREET_TYRE,
  },
  rear: {
    ...TEST_MULE.rear,
    offset: -1.35,
    halfTrack: 0.78,
    maxLength: 0.2,
    travel: 0.13,
    staticLength: 0.14,
    springRate: 52_000,
    bumpDamping: 3_200,
    reboundDamping: 4_900,
    bumpStopRate: 250_000,
    antiRollRate: 16_000,
    camber: deg(-1.2),
    camberGain: deg(-20),
    brakeTorque: 1_500,
    tyre: STREET_TYRE,
  },
  engine: {
    torqueCurve: [
      [800, 260],
      [1800, 480],
      [2000, 500],
      [5500, 500],
      [6500, 440],
      [7000, 400],
    ],
    idleRpm: 800,
    limiterRpm: 7000,
    inertia: 0.25,
    frictionBase: 25,
    frictionPerRpm: 0.008,
  },
  gearbox: {
    ratios: [3.6, 2.4, 1.75, 1.35, 1.1, 0.9],
    reverseRatio: 3.4,
    finalDrive: 3.5,
    efficiency: 0.88,
    shiftTime: 0.12,
    upshiftRpm: 6700,
    downshiftRpm: 3000,
    brakingDownshiftRpm: 4200,
  },
  diff: { preload: 30, powerLock: 0.25, coastLock: 0.1 },
  aero: { dragArea: 0.7, downforceArea: 0.3, frontShare: 0.5 },
  body: { halfWidth: 0.95, front: 2.2, rear: 2.3, floor: -0.35, roof: 0.9 },
};

const SUV_TYRE: TyreSpec = {
  ...STREET_TYRE,
  muX: 1.08,
  muY: 1.02,
  relaxationLength: 0.55,
  loadSensitivity: 0.14,
};

/** A big all-wheel-drive SUV: heavy, tall and softly sprung, so it leans and wallows. */
const SUV_SPEC: CarSpec = {
  ...STREET,
  name: 'Atlas Trailhawk',
  mass: 2150,
  inertia: { pitch: 4200, yaw: 4600, roll: 1150 },
  cogHeight: 0.68,
  steeringRatio: 14.5,
  front: {
    ...STREET.front,
    offset: 1.45,
    halfTrack: 0.84,
    wheelRadius: 0.38,
    wheelInertia: 1.8,
    maxLength: 0.28,
    travel: 0.18,
    staticLength: 0.2,
    springRate: 62_000,
    bumpDamping: 4_200,
    reboundDamping: 6_400,
    bumpStopRate: 300_000,
    antiRollRate: 38_000,
    rollCentreHeight: 0.12,
    camber: deg(-0.5),
    camberGain: deg(-15),
    maxSteer: deg(34),
    brakeTorque: 3_400,
    driven: true,
    tyre: SUV_TYRE,
  },
  rear: {
    ...STREET.rear,
    offset: -1.5,
    halfTrack: 0.84,
    wheelRadius: 0.38,
    wheelInertia: 1.9,
    maxLength: 0.28,
    travel: 0.18,
    staticLength: 0.2,
    springRate: 66_000,
    bumpDamping: 4_400,
    reboundDamping: 6_800,
    bumpStopRate: 300_000,
    antiRollRate: 26_000,
    rollCentreHeight: 0.15,
    camber: deg(-0.5),
    camberGain: deg(-12),
    brakeTorque: 2_400,
    handbrakeTorque: 3_000,
    driven: true,
    tyre: SUV_TYRE,
  },
  engine: {
    torqueCurve: [
      [800, 420],
      [1800, 640],
      [2200, 700],
      [4500, 700],
      [5800, 620],
      [6500, 560],
    ],
    idleRpm: 750,
    limiterRpm: 6500,
    inertia: 0.3,
    frictionBase: 30,
    frictionPerRpm: 0.01,
  },
  gearbox: {
    ratios: [4.2, 2.6, 1.8, 1.35, 1.08, 0.88],
    reverseRatio: 3.6,
    finalDrive: 3.3,
    efficiency: 0.85,
    shiftTime: 0.14,
    upshiftRpm: 6200,
    downshiftRpm: 2800,
    brakingDownshiftRpm: 3800,
  },
  diff: { preload: 40, powerLock: 0.2, coastLock: 0.1 },
  drive: { frontShare: 0.4, centreLock: 0.35 },
  aero: { dragArea: 1.25, downforceArea: 0.1, frontShare: 0.5 },
  body: { halfWidth: 1.0, front: 2.4, rear: 2.45, floor: -0.45, roof: 1.15 },
};

/** Changes from a base car, for the other cars in its class. */
interface Tweak {
  id: string;
  name: string;
  description: string;
  /** Multiplies engine torque. */
  power?: number;
  /** Multiplies mass; inertia, springs, dampers and brakes scale with it. */
  mass?: number;
  /** Multiplies tyre grip. */
  grip?: number;
  downforce?: number;
  drag?: number;
  /** Added to the aero front share (more = more front grip at speed). */
  balance?: number;
  /** Multiplies the final drive (less = longer gears, higher top speed). */
  gearing?: number;
}

type BaseModel = Omit<CarModel, 'stats' | 'aiGrip'>;

function variant(base: BaseModel, t: Tweak): BaseModel {
  const b = base.spec;
  const m = t.mass ?? 1;
  const grip = t.grip ?? 1;
  const axle = (a: CarSpec['front']): CarSpec['front'] => ({
    ...a,
    springRate: a.springRate * m,
    bumpDamping: a.bumpDamping * m,
    reboundDamping: a.reboundDamping * m,
    bumpStopRate: a.bumpStopRate * m,
    antiRollRate: a.antiRollRate * m,
    brakeTorque: a.brakeTorque * m * grip,
    tyre: { ...a.tyre, muX: a.tyre.muX * grip, muY: a.tyre.muY * grip },
  });
  const spec: CarSpec = {
    ...b,
    name: t.name,
    mass: b.mass * m,
    inertia: { pitch: b.inertia.pitch * m, yaw: b.inertia.yaw * m, roll: b.inertia.roll * m },
    front: axle(b.front),
    rear: axle(b.rear),
    engine: {
      ...b.engine,
      torqueCurve: b.engine.torqueCurve.map(([rpm, nm]) => [rpm, nm * (t.power ?? 1)] as const),
    },
    gearbox: { ...b.gearbox, finalDrive: b.gearbox.finalDrive * (t.gearing ?? 1) },
    aero: {
      dragArea: b.aero.dragArea * (t.drag ?? 1),
      downforceArea: b.aero.downforceArea * (t.downforce ?? 1),
      frontShare: b.aero.frontShare + (t.balance ?? 0),
    },
  };
  return { ...base, id: t.id, name: t.name, description: t.description, spec };
}

const RPM_PER_RAD_S = 60 / (2 * Math.PI);

/** Peak power, kW. */
export function peakPower(spec: CarSpec): number {
  const e = spec.engine;
  let best = 0;
  const curve = e.torqueCurve;
  for (let rpm = e.idleRpm; rpm <= e.limiterRpm; rpm += 50) {
    let nm = curve[curve.length - 1]![1];
    for (let i = 1; i < curve.length; i++) {
      const [r1, t1] = curve[i]!;
      if (rpm <= r1) {
        const [r0, t0] = curve[i - 1]!;
        nm = t0 + ((t1 - t0) * Math.max(rpm - r0, 0)) / (r1 - r0);
        break;
      }
    }
    best = Math.max(best, (nm * rpm) / RPM_PER_RAD_S / 1000);
  }
  return best;
}

/** Top speed, km/h: where drag and rolling resistance use all the power, or the limiter. */
export function topSpeed(spec: CarSpec): number {
  const power = peakPower(spec) * 1000 * spec.gearbox.efficiency;
  const gb = spec.gearbox;
  const top = gb.ratios[gb.ratios.length - 1]! * gb.finalDrive;
  const geared = ((spec.engine.limiterRpm / RPM_PER_RAD_S) * spec.rear.wheelRadius) / top;
  let lo = 0;
  let hi = 150;
  for (let i = 0; i < 40; i++) {
    const v = (lo + hi) / 2;
    const need = 0.5 * 1.225 * spec.aero.dragArea * v ** 3 + 0.015 * spec.mass * 9.81 * v;
    if (need > power) hi = v;
    else lo = v;
  }
  return Math.min(lo, geared) * 3.6;
}

/** Measured: the most grip each car's AI line can plan with and still lap cleanly. */
const AI_GRIP: Record<string, number> = {
  gt: 0.99,
  'gt-falco': 1,
  'gt-strada': 0.97,
  'gt-ardent': 0.97,
  'gt-monarch': 1,
  formula: 0.93,
  'formula-junior': 0.97,
  'formula-vortex': 0.97,
  'formula-helix': 0.91,
  'formula-corsa': 0.9,
  prototype: 0.93,
  'prototype-lmp2': 0.94,
  'prototype-talon': 0.91,
  'prototype-solaris': 0.96,
  'prototype-kestrel': 0.98,
  touring: 1.04,
  'touring-mistral': 1.04,
  'touring-bravo': 1.02,
  'touring-corvo': 1.04,
  'touring-ranger': 0.91,
  street: 0.85,
  'street-rs': 0.81,
  'street-lynx': 0.87,
  'street-brumby': 0.79,
  'street-zephyr': 0.73,
  suv: 0.82,
  'suv-trx': 0.83,
  'suv-kodiak': 0.81,
  'suv-dune': 0.84,
  'suv-vanta': 0.8,
};

function withStats(model: BaseModel): CarModel {
  return {
    ...model,
    aiGrip: AI_GRIP[model.id] ?? 1,
    stats: {
      power: `${Math.round(peakPower(model.spec))} kW`,
      weight: `${Math.round(model.spec.mass)} kg`,
      topSpeed: `${Math.round(topSpeed(model.spec) / 5) * 5} km/h`,
    },
  };
}

const GT: BaseModel = {
  id: 'gt',
  name: 'Veloce GT3',
  className: 'GT',
  description: 'The all-rounder: a GT3 racer with a front-mid V8 and plenty of downforce.',
  style: 'gt',
  spec: TEST_MULE,
};
const FORMULA_CAR: BaseModel = {
  id: 'formula',
  name: 'Apex F2000',
  className: 'Formula',
  description: 'Open wheels, huge downforce and 690 kg: the fastest thing on every circuit.',
  style: 'formula',
  spec: FORMULA,
};
const PROTOTYPE_CAR: BaseModel = {
  id: 'prototype',
  name: 'Nova LMP',
  className: 'Prototype',
  description: 'An endurance prototype: long, low and stable at very high speed.',
  style: 'prototype',
  spec: PROTOTYPE,
};
const TOURING_CAR: BaseModel = {
  id: 'touring',
  name: 'Stallion TR',
  className: 'Touring',
  description: 'A four-door touring saloon: rear drive, less grip, more roll, close racing.',
  style: 'touring',
  spec: TOURING,
};
const SUV_CAR: BaseModel = {
  id: 'suv',
  name: 'Atlas Trailhawk',
  className: 'SUV',
  description: 'A big all-wheel-drive SUV: heavy and tall, it leans hard but never gives up.',
  style: 'suv',
  spec: SUV_SPEC,
};
const STREET_CAR: BaseModel = {
  id: 'street',
  name: 'Aurora S',
  className: 'Street',
  description: 'A road-going coupé on street tyres: soft, forgiving and happy to slide.',
  style: 'street',
  spec: STREET,
};

/** Five classes of five cars. Races put the whole field in the player's car. */
export const CARS: readonly CarModel[] = [
  GT,
  variant(GT, {
    id: 'gt-falco',
    name: 'Falco GT3 R',
    description: 'A howling V10 with a slippery body: the quickest GT3 on a long straight.',
    power: 1.06,
    mass: 1.04,
    downforce: 0.92,
    drag: 0.94,
    gearing: 0.97,
  }),
  variant(GT, {
    id: 'gt-strada',
    name: 'Strada GT3 Evo',
    description: 'Light and nimble: gives away power but carries the most speed through corners.',
    power: 0.94,
    mass: 0.95,
    grip: 1.02,
    downforce: 1.06,
  }),
  variant(GT, {
    id: 'gt-ardent',
    name: 'Ardent GT3',
    description: 'Big wing, big grip: planted in fast corners, slower on the straights.',
    downforce: 1.18,
    drag: 1.08,
    balance: -0.02,
  }),
  variant(GT, {
    id: 'gt-monarch',
    name: 'Monarch GT3',
    description: 'A front-engined grand tourer: torquey, heavy and stable under braking.',
    power: 1.04,
    mass: 1.05,
    grip: 0.99,
    balance: 0.02,
  }),
  FORMULA_CAR,
  variant(FORMULA_CAR, {
    id: 'formula-junior',
    name: 'Apex F1600',
    description: 'The junior single-seater: less power and less wing, perfect for learning.',
    power: 0.68,
    mass: 0.94,
    grip: 0.95,
    downforce: 0.55,
    drag: 0.85,
  }),
  variant(FORMULA_CAR, {
    id: 'formula-vortex',
    name: 'Vortex FR-3',
    description: 'A regional formula car: nimble, forgiving and very close racing.',
    power: 0.82,
    downforce: 0.8,
    drag: 0.92,
  }),
  variant(FORMULA_CAR, {
    id: 'formula-helix',
    name: 'Helix F-Evo',
    description: 'More of everything: the top of the single-seater ladder.',
    power: 1.15,
    downforce: 1.1,
    drag: 1.04,
    gearing: 0.96,
  }),
  variant(FORMULA_CAR, {
    id: 'formula-corsa',
    name: 'Corsa F-X',
    description: 'An unlimited formula car: vicious, brutally fast and always on the edge.',
    power: 1.28,
    mass: 1.03,
    downforce: 1.22,
    drag: 1.1,
    gearing: 0.94,
  }),
  PROTOTYPE_CAR,
  variant(PROTOTYPE_CAR, {
    id: 'prototype-lmp2',
    name: 'Nova LMP2',
    description: 'The customer version: less power, the same beautifully balanced chassis.',
    power: 0.85,
    mass: 1.02,
    downforce: 0.92,
  }),
  variant(PROTOTYPE_CAR, {
    id: 'prototype-talon',
    name: 'Talon P1',
    description: 'A factory prototype with a twin-turbo V6 and a monster rear wing.',
    power: 1.12,
    downforce: 1.08,
    drag: 1.03,
  }),
  variant(PROTOTYPE_CAR, {
    id: 'prototype-solaris',
    name: 'Solaris Hyper',
    description: 'A heavy hypercar: huge power, less downforce, a handful in slow corners.',
    power: 1.22,
    mass: 1.14,
    downforce: 0.88,
    drag: 0.95,
    gearing: 0.95,
  }),
  variant(PROTOTYPE_CAR, {
    id: 'prototype-kestrel',
    name: 'Kestrel LMP3',
    description: 'The entry prototype: friendly, predictable and still very quick.',
    power: 0.7,
    downforce: 0.7,
    grip: 0.95,
  }),
  TOURING_CAR,
  variant(TOURING_CAR, {
    id: 'touring-mistral',
    name: 'Mistral TCR',
    description: 'A compact four-door racer, light on its tyres: loves tight, twisty circuits.',
    power: 0.92,
    mass: 0.95,
    grip: 1.02,
  }),
  variant(TOURING_CAR, {
    id: 'touring-bravo',
    name: 'Bravo DTM',
    description: 'A silhouette racer: touring-car looks with real downforce underneath.',
    power: 1.22,
    grip: 1.05,
    downforce: 1.8,
    drag: 1.1,
    gearing: 0.92,
  }),
  variant(TOURING_CAR, {
    id: 'touring-corvo',
    name: 'Corvo TC Sport',
    description: 'A club-racing saloon: modest power, narrow tyres and lots of slide.',
    power: 0.85,
    mass: 0.95,
    grip: 0.94,
  }),
  variant(TOURING_CAR, {
    id: 'touring-ranger',
    name: 'Ranger V8 Super',
    description: 'A thundering V8 four-door saloon: heavy, loud, a handful on the throttle.',
    power: 1.32,
    mass: 1.1,
    grip: 0.98,
    drag: 1.05,
    gearing: 0.9,
  }),
  STREET_CAR,
  variant(STREET_CAR, {
    id: 'street-rs',
    name: 'Aurora RS',
    description: 'The track-day special: more power, less weight, sticky tyres and a wing.',
    power: 1.15,
    mass: 0.95,
    grip: 1.06,
    downforce: 2.2,
    gearing: 0.95,
  }),
  variant(STREET_CAR, {
    id: 'street-lynx',
    name: 'Lynx Roadster',
    description: 'A tiny roadster: not much power, even less weight, and endless fun.',
    power: 0.62,
    mass: 0.7,
    grip: 0.98,
    gearing: 1.08,
  }),
  variant(STREET_CAR, {
    id: 'street-brumby',
    name: 'Brumby GT',
    description: 'A muscle car: big power, big weight, and a rear end that wants to overtake.',
    power: 1.28,
    mass: 1.1,
    grip: 0.96,
    drag: 1.05,
    gearing: 0.92,
  }),
  variant(STREET_CAR, {
    id: 'street-zephyr',
    name: 'Zephyr Hyper',
    description: 'A road-legal hypercar: savage power, active aero and a top speed to match.',
    power: 1.8,
    mass: 1.04,
    grip: 1.1,
    downforce: 3,
    drag: 1.08,
    gearing: 0.84,
  }),
  SUV_CAR,
  variant(SUV_CAR, {
    id: 'suv-trx',
    name: 'Atlas TRX-R',
    description: 'The performance SUV: a supercharged V8, stiffer tuning and big brakes.',
    power: 1.3,
    mass: 1.03,
    grip: 1.04,
    gearing: 0.95,
  }),
  variant(SUV_CAR, {
    id: 'suv-kodiak',
    name: 'Kodiak Luxe V8',
    description: 'A heavy luxury cruiser: silky, soft and surprisingly quick in a straight line.',
    power: 1.1,
    mass: 1.12,
    grip: 0.98,
  }),
  variant(SUV_CAR, {
    id: 'suv-dune',
    name: 'Sierra Dune',
    description: 'A compact crossover: light for an SUV, nimble and easy to drive.',
    power: 0.72,
    mass: 0.82,
    grip: 0.96,
    gearing: 1.05,
  }),
  variant(SUV_CAR, {
    id: 'suv-vanta',
    name: 'Vanta RS-X',
    description: 'The super-SUV: hypercar power and grip in something with five seats.',
    power: 1.55,
    grip: 1.1,
    downforce: 3,
    gearing: 0.88,
  }),
].map(withStats);

/** Car classes in display order. */
export const CAR_CLASSES: readonly string[] = [...new Set(CARS.map((c) => c.className))];

export function carById(id: string): CarModel {
  return CARS.find((c) => c.id === id) ?? CARS[0]!;
}
