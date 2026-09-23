import {
  addScaledV,
  approach,
  clamp,
  copyQ,
  copyV,
  crossV,
  dotV,
  integrateQ,
  invRotateV,
  isFiniteQuat,
  isFiniteVec,
  lerp,
  mulQ,
  normalizeV,
  quat,
  quatFromUnitVectors,
  quatFromYaw,
  rotateV,
  setV,
  subV,
  vec3,
  type Vec3,
} from '../../shared/math';
import {
  C,
  FLAG_ABS,
  FLAG_LIMITER,
  FLAG_SHIFT_DENIED,
  FLAG_SHIFTING,
  FLAG_TC,
  FLAG_UPSIDE_DOWN,
  W,
  WHEEL_STRIDE,
  aidLevelNumber,
  defaultAids,
  neutralInput,
  type AidLevel,
  type DriverAids,
  type DriverInput,
  type SteerSmoothing,
  SIM_DT,
} from '../../shared/protocol';
import { SURFACE, SURFACE_PROPS, rayHit, type Surface, type SurfaceId } from '../track/surface';
import type { AxleSpec, CarSpec } from './spec';
import { TyreModel, tyreOutput } from './tyre';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const TWO_PI = Math.PI * 2;
const RPM_PER_RAD_S = 60 / TWO_PI;
/** Speed floor for the slip-ratio formula; keeps the longitudinal tyre model stable at rest. */
const V_LONG_MIN = 2;
/** Largest slip angle the tyre carcass can wind up to (radians). */
const MAX_SLIP_ANGLE = 1.35;
/** Extra sideways damping for slow tyres so a parked or crawling car doesn't rock. */
const LOW_SPEED_DAMPING = 6_000;
const LOW_SPEED_DAMPING_BELOW = 3;
/** Brake hold: a braked wheel at a standstill grips the ground like static friction. */
const HOLD_ENGAGE_SPEED = 0.08;
const HOLD_RELEASE_SPEED = 0.35;
const HOLD_STIFFNESS = 200_000;
const HOLD_DAMPING = 12_000;
const HOLD_MIN_TORQUE = 150;
/** Body-to-ground contact (bottoming out, rollovers). */
const BODY_STIFFNESS = 250_000;
const BODY_DAMPING = 12_000;
const BODY_FRICTION = 0.55;
/** Body-to-barrier contact: stiff and well damped, with scraping friction. */
/** Impact energy per kilogram of car that does full damage, J/kg (~85 km/h into a wall). */
const DAMAGE_ENERGY_PER_KG = 280;
/** Closing speeds below this do no damage (brushes and parking bumps), m/s. */
const DAMAGE_MIN_SPEED = 2.5;
/** Fully damaged: downforce lost, extra drag, torque lost, and the toe error at the front. */
const DAMAGE_DOWNFORCE = 0.45;
const DAMAGE_DRAG = 0.15;
const DAMAGE_TORQUE = 0.35;
const DAMAGE_TOE = (1.4 * Math.PI) / 180;

/** Mechanical damage: 0 = as new … 1 = wrecked; steering is signed (+ = pulls right). */
export interface CarDamage {
  aero: number;
  engine: number;
  steering: number;
}

const WALL_STIFFNESS = 900_000;
const WALL_DAMPING = 60_000;
const WALL_FRICTION = 0.35;
/** Wheel steering is smoothed only enough to hide the display-rate input steps. */
const WHEEL_INPUT_SMOOTHING = 0.008;
/** Manual gearbox: a downshift is refused if it would put the engine this far past the limiter. */
const OVER_REV_MARGIN = 300;
/** Gear changes into or out of reverse only below this speed, m/s. */
const REVERSE_SELECT_SPEED = 1.5;

interface AssistTuning {
  /** Target slip as a fraction of the tyre's peak slip ratio. */
  fraction: number;
  /** Seconds over which the wheel speed is corrected. */
  response: number;
}

/** "Low" lets the tyre slip well past its peak before stepping in; "High" holds it just below. */
const ASSISTS: Record<'abs' | 'tc', Record<AidLevel, AssistTuning | null>> = {
  abs: {
    off: null,
    low: { fraction: 1.4, response: 0.03 },
    high: { fraction: 0.9, response: 0.02 },
  },
  tc: {
    off: null,
    low: { fraction: 1.45, response: 0.035 },
    high: { fraction: 0.9, response: 0.02 },
  },
};

/**
 * Pad steering range above the kinematic grip limit, as a fraction of the front tyre's peak
 * slip angle: full stick reaches the grip limit at any speed without going far past it.
 */
const PAD_SLIP_MARGIN = 0.5;

/** Pad steering smoothing time constants, seconds. */
const STEER_SMOOTHING: Record<SteerSmoothing, number> = { low: 0.02, medium: 0.04, high: 0.07 };

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };
const RIGHT: Vec3 = { x: 1, y: 0, z: 0 };

export interface Spawn {
  x: number;
  z: number;
  yaw: number;
}

class Wheel {
  readonly tyre: TyreModel;
  /** Hardpoint (top of the suspension) in the body frame. */
  readonly hardpoint: Vec3;
  /** Spring length at zero force. */
  readonly freeLength: number;
  readonly fullBumpLength: number;
  readonly staticLoad: number;

  length: number;
  prevLength: number;
  lengthRate = 0;
  steer = 0;
  prevSteer = 0;
  spin = 0;
  prevSpin = 0;
  omega = 0;
  contact = false;
  load = 0;
  slip = 0;
  slipRatio = 0;
  slipAngle = 0;
  /** Sideways deflection of the tyre carcass (relaxation state), metres. */
  deflection = 0;
  /** Camber relative to the road, radians (- = top leaning inwards). */
  camber = 0;
  driveTorque = 0;
  extraInertia = 0;
  /** Brake hold (static friction at a standstill) and where it is anchored. */
  hold = false;
  readonly holdPoint = vec3();

  // Per-step scratch values.
  readonly hardpointWorld = vec3();
  readonly contactPoint = vec3();
  readonly normal = vec3(0, 1, 0);
  cosAngle = 1;
  grip = 1;
  rollingResistance = 0;
  surface: SurfaceId = SURFACE.ASPHALT;

  constructor(
    readonly axle: AxleSpec,
    /** -1 = left, +1 = right. */
    readonly side: number,
    cogHeight: number,
    staticLoad: number,
  ) {
    this.tyre = new TyreModel(axle.tyre, staticLoad);
    const hardpointY = axle.wheelRadius - cogHeight + axle.staticLength;
    this.hardpoint = vec3(side * axle.halfTrack, hardpointY, -axle.offset);
    this.freeLength = axle.staticLength + staticLoad / axle.springRate;
    this.fullBumpLength = axle.maxLength - axle.travel;
    this.staticLoad = staticLoad;
    this.length = axle.staticLength;
    this.prevLength = this.length;
  }
}

/**
 * A car as a single rigid body with four raycast suspension corners. All forces are
 * accumulated in world space and integrated with semi-implicit Euler at the fixed sim rate.
 */
export class Car {
  readonly wheels: Wheel[];
  readonly pos = vec3();
  readonly rot = quat();
  readonly vel = vec3();
  readonly angVel = vec3();
  readonly prevPos = vec3();
  readonly prevRot = quat();

  input: DriverInput = neutralInput();
  aids: DriverAids = defaultAids();

  /** Steering as a fraction of the current steering range (pads) or of full lock (wheels). */
  steer = 0;
  /** Road-wheel angle the steering currently asks for, radians. */
  roadAngle = 0;
  /** Largest road-wheel angle available right now. */
  steerAuthority: number;
  throttle = 0;
  brake = 0;
  handbrake = 0;
  clutchEngagement = 1;

  gear = 1;
  engineRpm: number;
  shiftTimer = 0;
  shiftCooldown = 0;
  shiftDeniedTimer = 0;
  reverseMode = false;
  limiterActive = false;
  /** True if ABS / traction control limited a wheel during the last step. */
  absActive = false;
  tcActive = false;
  /** Felt acceleration in the car's frame (smoothed), m/s². */
  accelLong = 0;
  accelLat = 0;
  /** Actual acceleration along the car's nose during the last step, m/s² (unsmoothed). */
  private forwardAccel = 0;

  private pendingUp = 0;
  private pendingDown = 0;
  private reverseHold = 0;
  private forwardHold = 0;
  private spawn: Spawn;
  private readonly bodyPoints: Vec3[];
  /** Body corners at bumper height, for barrier contacts. */
  private readonly wallPoints: Vec3[];
  /** Largest contact force from barriers or other cars during the last step (for effects). */
  impactForce = 0;
  readonly damage: CarDamage = { aero: 0, engine: 0, steering: 0 };
  /** How much impacts hurt: 0 = no damage, 0.5 = light, 1 = full. */
  damageScale = 0;
  /** On the grid before the start: the handbrake is held on whatever the driver does. */
  holdForStart = false;
  private readonly wheelbase: number;
  private readonly frontAlphaPeak: number;

  // World-space scratch.
  private readonly up = vec3();
  private readonly fwd = vec3();
  private readonly right = vec3();
  private readonly force = vec3();
  private readonly torque = vec3();
  private readonly t0 = vec3();
  private readonly t1 = vec3();
  private readonly t2 = vec3();
  private readonly t3 = vec3();
  private readonly hit = rayHit();
  private readonly tyreOut = tyreOutput();

  constructor(
    readonly spec: CarSpec,
    spawn: Spawn,
    /** Ground used to place the car on reset (flat ground at height 0 if omitted). */
    private readonly ground: Surface | null = null,
  ) {
    this.wheelbase = spec.front.offset - spec.rear.offset;
    const frontShare = -spec.rear.offset / this.wheelbase;
    const frontLoad = (spec.mass * GRAVITY * frontShare) / 2;
    const rearLoad = (spec.mass * GRAVITY * (1 - frontShare)) / 2;
    this.wheels = [
      new Wheel(spec.front, -1, spec.cogHeight, frontLoad),
      new Wheel(spec.front, 1, spec.cogHeight, frontLoad),
      new Wheel(spec.rear, -1, spec.cogHeight, rearLoad),
      new Wheel(spec.rear, 1, spec.cogHeight, rearLoad),
    ];
    this.frontAlphaPeak = this.wheels[0]!.tyre.alphaPeak;
    this.steerAuthority = spec.front.maxSteer;
    const b = spec.body;
    this.bodyPoints = [];
    for (const x of [-b.halfWidth, b.halfWidth]) {
      for (const y of [b.floor, b.roof]) {
        for (const z of [-b.front, 0, b.rear]) this.bodyPoints.push(vec3(x, y, z));
      }
    }
    this.wallPoints = [];
    for (const x of [-b.halfWidth, b.halfWidth]) {
      for (const z of [-b.front, -b.front * 0.4, b.rear * 0.4, b.rear]) {
        this.wallPoints.push(vec3(x, 0, z));
      }
    }
    this.engineRpm = spec.engine.idleRpm;
    this.spawn = spawn;
    this.reset(spawn);
  }

  /** Takes this frame's controls. Gear-change presses are queued so none are lost. */
  setInput(input: DriverInput): void {
    this.input = input;
    this.pendingUp = Math.min(this.pendingUp + input.shiftUp, 3);
    this.pendingDown = Math.min(this.pendingDown + input.shiftDown, 3);
  }

  setAids(aids: DriverAids): void {
    const wasManual = this.aids.gearbox === 'manual';
    this.aids = { ...aids };
    // Reverse is a gear in manual mode but a brake-pedal mode in auto; carry it across.
    if (aids.gearbox === 'manual') this.reverseMode = false;
    else if (wasManual && this.gear < 0) this.reverseMode = true;
  }

  /** Moves the car to a new place; later resets return there. */
  teleport(spawn: Spawn): void {
    this.spawn = spawn;
    this.reset(spawn);
  }

  /** Places the car at rest on the ground at `spawn`, sitting flush with its slope. */
  reset(spawn: Spawn = this.spawn): void {
    this.place(spawn);
    setV(this.vel, 0, 0, 0);
    setV(this.angVel, 0, 0, 0);
    for (const w of this.wheels) {
      w.length = w.axle.staticLength;
      w.lengthRate = 0;
      w.omega = 0;
      w.steer = 0;
      w.load = 0;
      w.slip = 0;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.deflection = 0;
      w.hold = false;
    }
    this.steer = 0;
    this.roadAngle = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.gear = 1;
    this.reverseMode = false;
    this.reverseHold = 0;
    this.forwardHold = 0;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.shiftDeniedTimer = 0;
    this.pendingUp = 0;
    this.pendingDown = 0;
    this.limiterActive = false;
    this.accelLong = 0;
    this.accelLat = 0;
    this.forwardAccel = 0;
    this.engineRpm = this.spec.engine.idleRpm;
    this.storePrevious();
  }

  private place(spawn: Spawn): void {
    const normal = setV(this.t0, 0, 1, 0);
    let groundY = 0;
    const ground = this.ground;
    if (ground) {
      groundY = ground.heightAt(spawn.x, spawn.z);
      const hit = this.hit;
      if (ground.raycast(spawn.x, groundY + 2, spawn.z, 0, -1, 0, 4, hit)) {
        groundY += 2 - hit.distance;
        setV(normal, hit.nx, hit.ny, hit.nz);
      }
    }
    // Turn to the spawn heading, then tilt the car's up axis onto the ground normal.
    const yaw = quatFromYaw(quat(), spawn.yaw);
    const tilt = quatFromUnitVectors(quat(), UP, normal);
    mulQ(this.rot, tilt, yaw);
    setV(this.pos, spawn.x, groundY, spawn.z);
    addScaledV(this.pos, this.pos, normal, this.spec.cogHeight);
  }

  storePrevious(): void {
    copyV(this.prevPos, this.pos);
    copyQ(this.prevRot, this.rot);
    for (const w of this.wheels) {
      w.prevLength = w.length;
      w.prevSteer = w.steer;
      w.prevSpin = w.spin;
    }
  }

  isFinite(): boolean {
    return (
      isFiniteVec(this.pos) &&
      isFiniteQuat(this.rot) &&
      isFiniteVec(this.vel) &&
      isFiniteVec(this.angVel) &&
      Number.isFinite(this.engineRpm) &&
      this.wheels.every(
        (w) =>
          Number.isFinite(w.omega) && Number.isFinite(w.length) && Number.isFinite(w.deflection),
      )
    );
  }

  /** Signed speed along the car's nose direction, m/s. */
  forwardSpeed(): number {
    rotateV(this.fwd, this.rot, FORWARD);
    return dotV(this.vel, this.fwd);
  }

  step(dt: number, surface: Surface): void {
    rotateV(this.up, this.rot, UP);
    rotateV(this.fwd, this.rot, FORWARD);
    rotateV(this.right, this.rot, RIGHT);
    this.updateControls(dt);
    this.absActive = false;
    this.tcActive = false;
    this.impactForce = 0;
    setV(this.force, 0, -this.spec.mass * GRAVITY, 0);
    setV(this.torque, 0, 0, 0);

    for (const w of this.wheels) this.probe(w, surface, dt);
    this.suspension(this.wheels[0]!, this.wheels[1]!);
    this.suspension(this.wheels[2]!, this.wheels[3]!);
    this.drivetrain(dt);
    for (const w of this.wheels) this.tyreForces(w, dt);
    this.aero();
    this.bodyContacts(surface);
    this.measureAcceleration(dt);
    this.integrate(dt);
    this.afterStep(dt);
  }

  // ---------------------------------------------------------------- controls

  private updateControls(dt: number): void {
    const input = this.input;
    const speed = dotV(this.vel, this.fwd);
    const auto = this.aids.gearbox === 'auto';

    // Automatic gearbox only: hold the brake at a standstill to select reverse.
    if (auto && !this.reverseMode) {
      this.reverseHold =
        speed < 0.8 && input.brake > 0.6 && input.throttle < 0.1 ? this.reverseHold + dt : 0;
      if (this.reverseHold > 0.35) {
        this.reverseMode = true;
        this.gear = -1;
        this.reverseHold = 0;
      }
    } else if (auto) {
      this.forwardHold =
        speed > -0.8 && input.throttle > 0.6 && input.brake < 0.1 ? this.forwardHold + dt : 0;
      if (this.forwardHold > 0.1) {
        this.reverseMode = false;
        this.gear = 1;
        this.forwardHold = 0;
      }
    }
    const swap = auto && this.reverseMode;
    const throttleCmd = swap ? input.brake : input.throttle;
    const brakeCmd = swap ? input.throttle : input.brake;
    this.throttle = approach(this.throttle, clamp(throttleCmd, 0, 1), 10 * dt);
    this.brake = approach(this.brake, clamp(brakeCmd, 0, 1), 12 * dt);
    const handbrakeCmd = this.holdForStart ? 1 : input.handbrake;
    this.handbrake = approach(this.handbrake, clamp(handbrakeCmd, 0, 1), 12 * dt);
    this.clutchEngagement = 1 - clamp(input.clutch, 0, 1);

    this.roadAngle = input.steerMode === 'wheel' ? this.steerWheel(dt) : this.steerPad(dt, speed);
    this.applySteer(this.roadAngle);
  }

  /** Steering wheels map 1:1 through the steering rack, up to the car's steering lock. */
  private steerWheel(dt: number): number {
    const lock = this.spec.front.maxSteer;
    const target = clamp(this.input.wheelAngle / this.spec.steeringRatio, -lock, lock);
    const current = this.steer * lock;
    const angle = current + (target - current) * (1 - Math.exp(-dt / WHEEL_INPUT_SMOOTHING));
    this.steerAuthority = lock;
    this.steer = angle / lock;
    return angle;
  }

  /**
   * Pads and keys: the steering range shrinks with speed, but full stick always reaches just
   * past the grip limit (the angle for the tightest corner possible at this speed plus the
   * tyre's peak slip angle), so it is never numb. Input is smoothed and rate-limited, faster
   * when returning to centre.
   */
  private steerPad(dt: number, speed: number): number {
    const input = this.input;
    const authority = this.padAuthority(Math.abs(speed));
    const target = clamp(input.steer, -1, 1);
    let s = this.steer;
    if (input.steerMode === 'keyboard') {
      const releasing = Math.abs(target) < Math.abs(s) || target * s < 0;
      s = approach(s, target, (releasing ? 4.5 : 2.2) * dt);
    } else {
      const tau = STEER_SMOOTHING[this.aids.steerSmoothing];
      const next = s + (target - s) * (1 - Math.exp(-dt / tau));
      const returning = Math.abs(next) < Math.abs(s);
      const fast = Math.min(Math.abs(speed) / 60, 1);
      const maxDelta = (returning ? 9 : lerp(7, 3.5, fast)) * dt;
      s = clamp(next, s - maxDelta, s + maxDelta);
    }
    this.steer = s;
    this.steerAuthority = authority;
    return s * authority;
  }

  /** Road-wheel angle that full stick gives at `speed` (m/s). */
  padAuthority(speed: number): number {
    const spec = this.spec;
    const lock = spec.front.maxSteer;
    if (speed < 1) return lock;
    const downforce = 0.5 * AIR_DENSITY * spec.aero.downforceArea * speed * speed;
    const grip = spec.front.tyre.muY * 0.92;
    const lateral = grip * GRAVITY * (1 + downforce / (spec.mass * GRAVITY));
    const kinematic = Math.atan((this.wheelbase * lateral) / (speed * speed));
    const range = (kinematic + this.frontAlphaPeak * PAD_SLIP_MARGIN) * this.aids.steerSensitivity;
    return clamp(range, 0.03, lock);
  }

  private applySteer(angle: number): void {
    const front = this.spec.front;
    const abs = Math.abs(angle);
    let inner = abs;
    let outer = abs;
    if (abs > 1e-4 && front.ackermann > 0) {
      const radius = this.wheelbase / Math.tan(abs);
      const innerIdeal = Math.atan(this.wheelbase / Math.max(radius - front.halfTrack, 0.1));
      const outerIdeal = Math.atan(this.wheelbase / (radius + front.halfTrack));
      inner = abs + (innerIdeal - abs) * front.ackermann;
      outer = abs + (outerIdeal - abs) * front.ackermann;
    }
    const sign = Math.sign(angle);
    const [fl, fr, rl, rr] = this.wheels as [Wheel, Wheel, Wheel, Wheel];
    // Turning right (angle > 0): the right wheel is on the inside. Toe-in points each wheel's
    // front towards the car's centre line.
    // Bent steering: both front wheels point off to one side, so the car pulls.
    const bent = this.damage.steering * DAMAGE_TOE;
    fl.steer = sign * (angle > 0 ? outer : inner) + front.toe + bent;
    fr.steer = sign * (angle > 0 ? inner : outer) - front.toe + bent;
    rl.steer = this.spec.rear.toe;
    rr.steer = -this.spec.rear.toe;
  }

  // ---------------------------------------------------------------- suspension

  private probe(w: Wheel, surface: Surface, dt: number): void {
    const axle = w.axle;
    rotateV(this.t0, this.rot, w.hardpoint);
    addScaledV(w.hardpointWorld, this.pos, this.t0, 1);
    const maxDist = axle.maxLength + axle.wheelRadius;
    const hp = w.hardpointWorld;
    const up = this.up;
    if (surface.raycast(hp.x, hp.y, hp.z, -up.x, -up.y, -up.z, maxDist, this.hit)) {
      const hit = this.hit;
      w.contact = true;
      w.length = Math.max(hit.distance - axle.wheelRadius, 0);
      setV(w.normal, hit.nx, hit.ny, hit.nz);
      addScaledV(w.contactPoint, hp, up, -hit.distance);
      w.cosAngle = Math.max(dotV(up, w.normal), 0.2);
      // Rate of change of suspension length from the hardpoint's velocity towards the ground.
      crossV(this.t1, this.angVel, this.t0);
      addScaledV(this.t1, this.t1, this.vel, 1);
      w.lengthRate = dotV(this.t1, w.normal) / w.cosAngle;
      const props = SURFACE_PROPS[hit.surface];
      w.grip = props.grip * (surface.gripScale ?? 1);
      w.rollingResistance = props.rollingResistance;
      w.surface = hit.surface;
    } else {
      w.contact = false;
      // The wheel drops towards full droop (visual only; there is no unsprung mass yet).
      w.length = approach(w.length, axle.maxLength, 1.5 * dt);
      w.lengthRate = 0;
      w.load = 0;
      w.hold = false;
    }
  }

  private suspension(left: Wheel, right: Wheel): void {
    const axle = left.axle;
    const travelL = axle.maxLength - left.length;
    const travelR = axle.maxLength - right.length;
    const antiRoll = axle.antiRollRate * (travelL - travelR);
    this.suspensionForce(left, antiRoll);
    this.suspensionForce(right, -antiRoll);
  }

  private suspensionForce(w: Wheel, antiRoll: number): void {
    if (!w.contact) {
      w.load = 0;
      return;
    }
    const axle = w.axle;
    const compressionRate = -w.lengthRate;
    let force = Math.max(axle.springRate * (w.freeLength - w.length), 0);
    force +=
      compressionRate > 0
        ? axle.bumpDamping * compressionRate
        : axle.reboundDamping * compressionRate;
    const stopDepth = w.fullBumpLength + axle.bumpStopRange - w.length;
    if (stopDepth > 0) {
      // Progressive rubber bump stop with a little damping.
      force += axle.bumpStopRate * stopDepth * (1 + stopDepth / 0.01);
      force += 3_000 * compressionRate;
    }
    force += antiRoll;
    if (force < 0) force = 0;
    w.load = force * w.cosAngle;
    // The strut pushes along the body's up axis at the hardpoint.
    this.applyForce(this.up, force, w.hardpointWorld);
  }

  // ---------------------------------------------------------------- drivetrain

  private ratioFor(gear: number): number {
    const gb = this.spec.gearbox;
    if (gear > 0) return gb.ratios[gear - 1]! * gb.finalDrive;
    if (gear < 0) return -gb.reverseRatio * gb.finalDrive;
    return 0;
  }

  private engineTorque(rpm: number, throttle: number): number {
    const e = this.spec.engine;
    const friction = e.frictionBase + e.frictionPerRpm * rpm;
    if (this.limiterActive || rpm > e.limiterRpm) return -friction;
    const curve = e.torqueCurve;
    let full = curve[curve.length - 1]![1];
    if (rpm <= curve[0]![0]) full = curve[0]![1];
    else {
      for (let i = 1; i < curve.length; i++) {
        const [r1, t1] = curve[i]!;
        if (rpm <= r1) {
          const [r0, t0] = curve[i - 1]!;
          full = t0 + ((t1 - t0) * (rpm - r0)) / (r1 - r0);
          break;
        }
      }
    }
    return throttle * full * (1 - DAMAGE_TORQUE * this.damage.engine) - (1 - throttle) * friction;
  }

  /** Share of the drive torque going to the front axle (0 = rear drive). */
  private get frontShare(): number {
    const s = this.spec;
    if (s.drive) return clamp(s.drive.frontShare, 0, 1);
    if (s.front.driven && s.rear.driven) return 0.4;
    return s.front.driven ? 1 : 0;
  }

  /** Engine speed the driven wheels would give in `gear`. */
  drivenRpm(gear: number): number {
    const [fl, fr, rl, rr] = this.wheels as [Wheel, Wheel, Wheel, Wheel];
    const f = this.frontShare;
    const omega = (f * (fl.omega + fr.omega) + (1 - f) * (rl.omega + rr.omega)) / 2;
    return omega * this.ratioFor(gear) * RPM_PER_RAD_S;
  }

  private drivetrain(dt: number): void {
    const spec = this.spec;
    const e = spec.engine;
    const gb = spec.gearbox;
    const [fl, fr, rl, rr] = this.wheels as [Wheel, Wheel, Wheel, Wheel];
    const front = this.frontShare;
    for (const w of this.wheels) {
      w.driveTorque = 0;
      w.extraInertia = 0;
    }

    const ratio = this.ratioFor(this.gear);
    const rpmAtWheels = this.drivenRpm(this.gear);
    const throttle = this.throttle;
    const engagement = this.clutchEngagement;

    let clutchTorque = 0;
    if (ratio === 0 || this.shiftTimer > 0) {
      // Neutral or mid-shift: no drive; the engine matches the new gear's speed (a blip on
      // downshifts) or idles.
      this.engineRpm = approach(this.engineRpm, Math.max(rpmAtWheels, e.idleRpm), 20_000 * dt);
    } else if (engagement < 0.3) {
      // Clutch pedal down: the engine revs freely with the throttle.
      const free = e.idleRpm + throttle * (e.limiterRpm - e.idleRpm);
      this.engineRpm = approach(this.engineRpm, free, 15_000 * dt);
      clutchTorque = Math.max(this.engineTorque(this.engineRpm, throttle), 0) * engagement;
    } else {
      const launchRpm = e.idleRpm + throttle * (4_200 - e.idleRpm);
      if (throttle > 0.01 && rpmAtWheels < launchRpm) {
        // Clutch slipping (pulling away): the engine holds its launch rpm and the clutch passes
        // on its torque.
        this.engineRpm = approach(this.engineRpm, launchRpm, 12_000 * dt);
        clutchTorque = Math.max(this.engineTorque(this.engineRpm, throttle), 0) * engagement;
      } else if (rpmAtWheels < e.idleRpm) {
        // Coasting below idle: clutch open.
        this.engineRpm = approach(this.engineRpm, e.idleRpm, 8_000 * dt);
      } else {
        this.engineRpm = rpmAtWheels;
        clutchTorque = this.engineTorque(this.engineRpm, throttle) * engagement;
        // With the clutch closed, the engine's inertia is felt at the driven wheels.
        const reflected = (e.inertia * ratio * ratio * engagement) / 2;
        fl.extraInertia = reflected * front;
        fr.extraInertia = reflected * front;
        rl.extraInertia = reflected * (1 - front);
        rr.extraInertia = reflected * (1 - front);
      }
    }
    const axleTorque = clutchTorque * ratio * gb.efficiency;
    if (front <= 0) {
      this.axleDrive(rl, rr, axleTorque, dt);
      return;
    }
    if (front >= 1) {
      this.axleDrive(fl, fr, axleTorque, dt);
      return;
    }
    // All-wheel drive: a fixed split plus a centre coupling that resists the front and rear
    // axles turning at different speeds (so one axle can't spin away on its own).
    const lock = (spec.drive?.centreLock ?? 0.3) * Math.abs(axleTorque) + spec.diff.preload;
    const inertia =
      spec.front.wheelInertia + spec.rear.wheelInertia + fl.extraInertia + rl.extraInertia;
    const slip = (rl.omega + rr.omega - fl.omega - fr.omega) / 2;
    const centre = clamp((slip * inertia) / (4 * dt), -lock, lock);
    this.axleDrive(fl, fr, axleTorque * front + centre, dt);
    this.axleDrive(rl, rr, axleTorque * (1 - front) - centre, dt);
  }

  /**
   * One driven axle's clutch-pack limited-slip differential: it resists a speed difference
   * between the two wheels, up to a locking torque that grows with the torque through it.
   */
  private axleDrive(left: Wheel, right: Wheel, torque: number, dt: number): void {
    const diff = this.spec.diff;
    const lockTorque =
      diff.preload + (torque >= 0 ? diff.powerLock : diff.coastLock) * Math.abs(torque);
    const inertia = left.axle.wheelInertia + left.extraInertia;
    const coupling = clamp(
      ((right.omega - left.omega) * inertia) / (4 * dt),
      -lockTorque,
      lockTorque,
    );
    left.driveTorque = torque / 2 + coupling;
    right.driveTorque = torque / 2 - coupling;
  }

  // ---------------------------------------------------------------- tyres

  private tyreForces(w: Wheel, dt: number): void {
    const axle = w.axle;
    const radius = axle.wheelRadius;
    const inertia = axle.wheelInertia + w.extraInertia;
    let brakeTorque = axle.brakeTorque * this.brake;
    const handbrakeTorque = axle.handbrakeTorque * this.handbrake;

    if (!w.contact) {
      // Free wheel in the air: drive and brakes only; the carcass relaxes.
      let omega = w.omega + (dt * w.driveTorque) / inertia;
      const stop = (dt * (brakeTorque + handbrakeTorque + 5)) / inertia;
      omega = Math.abs(omega) <= stop ? 0 : omega - Math.sign(omega) * stop;
      w.omega = omega;
      w.deflection *= Math.exp(-dt / 0.05);
      w.slip = 0;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.spin = wrapAngle(w.spin + omega * dt);
      return;
    }

    // Wheel heading and right axis on the ground plane.
    const n = w.normal;
    const heading = this.t0;
    setV(heading, Math.sin(w.steer), 0, -Math.cos(w.steer));
    rotateV(heading, this.rot, heading);
    addScaledV(heading, heading, n, -dotV(heading, n));
    normalizeV(heading, heading);
    const right = crossV(this.t1, heading, n);

    // Velocity of the contact patch.
    const rel = subV(this.t2, w.contactPoint, this.pos);
    const vp = crossV(vScratch, this.angVel, rel);
    addScaledV(vp, vp, this.vel, 1);
    const vLong = dotV(vp, heading);
    const vLat = dotV(vp, right);
    const longRef = Math.max(Math.abs(vLong), V_LONG_MIN);

    // Camber: the wheel plane leans with static camber, camber gain and body roll.
    const bump = axle.staticLength - w.length;
    const bodyCamber = axle.camber + axle.camberGain * bump;
    const upWheel = setV(this.t3, w.side * Math.sin(bodyCamber), Math.cos(bodyCamber), 0);
    rotateV(upWheel, this.rot, upWheel);
    const lean = dotV(upWheel, right);
    w.camber = w.side * lean;

    // Sideways: the carcass deflects with lateral sliding and relaxes as the tyre rolls, so the
    // slip angle (and force) build up over about one relaxation length. At a standstill the
    // deflection acts like a spring, which holds the car still.
    const sigma = axle.tyre.relaxationLength;
    const maxDeflection = sigma * Math.tan(MAX_SLIP_ANGLE);
    w.deflection = clamp(
      (w.deflection + dt * vLat) / (1 + (dt * Math.abs(vLong)) / sigma),
      -maxDeflection,
      maxDeflection,
    );
    const alpha = Math.atan(w.deflection / sigma);
    const kappa = (w.omega * radius - vLong) / longRef;
    const out = w.tyre.compute(kappa, alpha, lean, w.load, w.grip, this.tyreOut);

    // Implicit wheel spin: when the wheel speeds up, the tyre force grows and pushes back, so
    // the wheel behaves as if it had a larger inertia (inertia × denom). Integrating against
    // that keeps it stable however stiff the tyre is.
    const dfxdOmega = (Math.max(out.dfxdk, 0) * radius) / longRef;
    const denom = 1 + (dt * radius * dfxdOmega) / inertia;
    const effectiveInertia = inertia * denom;
    const rolling = w.rollingResistance * w.load * radius;

    // ABS and traction control as slip controllers: allow only as much brake or drive torque as
    // steers the wheel towards a target slip (a fraction of the tyre's peak slip) over a short
    // response time. The target moves as the car speeds up or slows down, so the wheel must
    // follow that too. While cornering, part of the grip is used sideways, so the target shrinks.
    let driveTorque = w.driveTorque;
    const lateralUse = Math.min(Math.abs(alpha) / w.tyre.alphaPeak, 1);
    const targetRate = this.forwardAccel / radius;
    const abs = ASSISTS.abs[this.aids.abs];
    if (abs && brakeTorque > 0 && vLong > 2.5) {
      const room = Math.sqrt(Math.max(abs.fraction ** 2 - lateralUse ** 2, 0.2 ** 2));
      const omegaTarget = (vLong - w.tyre.kappaPeak * room * longRef) / radius;
      const wanted = (omegaTarget - w.omega) / abs.response + targetRate;
      const allowed = driveTorque - out.fx * radius - rolling - effectiveInertia * wanted;
      if (brakeTorque > allowed) {
        brakeTorque = Math.max(allowed, 0);
        this.absActive = true;
      }
    }
    const tc = ASSISTS.tc[this.aids.tc];
    if (tc && driveTorque > 0 && vLong > -1) {
      const room = Math.sqrt(Math.max(tc.fraction ** 2 - lateralUse ** 2, 0.2 ** 2));
      const omegaTarget = (vLong + w.tyre.kappaPeak * room * longRef) / radius;
      const wanted = (omegaTarget - w.omega) / tc.response + targetRate;
      const allowed = out.fx * radius + rolling + effectiveInertia * wanted;
      if (driveTorque > allowed) {
        driveTorque = Math.max(allowed, 0);
        this.tcActive = true;
      }
    }

    // Brake hold: a braked wheel at a standstill sticks to the ground (static friction), so a
    // parked car doesn't creep down a slope. More drive torque than brake torque breaks it free.
    const holdTorque = axle.brakeTorque * this.brake + handbrakeTorque;
    const overpowered = Math.abs(w.driveTorque) > holdTorque;
    const cp = w.contactPoint;
    if (!w.hold) {
      if (
        Math.abs(vLong) < HOLD_ENGAGE_SPEED &&
        Math.abs(w.omega) < 0.5 &&
        holdTorque > HOLD_MIN_TORQUE &&
        !overpowered
      ) {
        w.hold = true;
        copyV(w.holdPoint, cp);
      }
    } else if (
      holdTorque < HOLD_MIN_TORQUE * 0.5 ||
      overpowered ||
      Math.abs(vLong) > HOLD_RELEASE_SPEED
    ) {
      w.hold = false;
    }

    let fx: number;
    if (w.hold) {
      const displacement = dotV(subV(this.t3, cp, w.holdPoint), heading);
      fx = -HOLD_STIFFNESS * displacement - HOLD_DAMPING * vLong;
      const cap = Math.min(holdTorque / radius, out.fxMax);
      if (Math.abs(fx) > cap) {
        // Pushed harder than the brake can hold: slide, and re-anchor where the tyre is now.
        fx = Math.sign(fx) * cap;
        copyV(w.holdPoint, cp);
      }
      w.omega = 0;
    } else {
      const free = w.omega + (dt * (driveTorque - out.fx * radius)) / effectiveInertia;
      const resist = brakeTorque + handbrakeTorque + rolling;
      const stop = (dt * resist) / effectiveInertia;
      const omega = Math.abs(free) <= stop ? 0 : free - Math.sign(free) * stop;
      fx = clamp(out.fx + dfxdOmega * (omega - w.omega), -out.fxMax, out.fxMax);
      w.omega = omega;
    }
    w.spin = wrapAngle(w.spin + w.omega * dt);
    w.slip = out.slip;
    w.slipRatio = kappa;
    w.slipAngle = alpha;

    // Slow tyres get extra sideways damping so a parked car settles instead of rocking.
    let fy = out.fy;
    const slowBlend = 1 - Math.min(Math.abs(vLong) / LOW_SPEED_DAMPING_BELOW, 1);
    if (slowBlend > 0) {
      const loadShare = Math.min(w.load / w.staticLoad, 2);
      fy -= LOW_SPEED_DAMPING * vLat * slowBlend * loadShare;
      const limit = out.fxMax * 1.05;
      fy = clamp(fy, -limit, limit);
    }

    // Tyre force on the body, acting at roll-centre height above the contact patch.
    const f = this.t2;
    setV(
      f,
      heading.x * fx + right.x * fy,
      heading.y * fx + right.y * fy,
      heading.z * fx + right.z * fy,
    );
    const at = addScaledV(this.t0, w.contactPoint, n, axle.rollCentreHeight);
    this.applyForceVec(f, at);
  }

  // ---------------------------------------------------------------- aero & body

  private aero(): void {
    const a = this.spec.aero;
    const v = this.vel;
    const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    if (speed < 0.1) return;
    const hurt = this.damage.aero;
    const dragScale = -0.5 * AIR_DENSITY * a.dragArea * (1 + DAMAGE_DRAG * hurt) * speed;
    addScaledV(this.force, this.force, v, dragScale);
    const vLong = dotV(v, this.fwd);
    const downforce =
      0.5 * AIR_DENSITY * a.downforceArea * (1 - DAMAGE_DOWNFORCE * hurt) * vLong * vLong;
    const frontPoint = addScaledV(this.t0, this.pos, this.fwd, this.spec.front.offset);
    this.applyForce(this.up, -downforce * a.frontShare, frontPoint);
    const rearPoint = addScaledV(this.t1, this.pos, this.fwd, this.spec.rear.offset);
    this.applyForce(this.up, -downforce * (1 - a.frontShare), rearPoint);
  }

  private bodyContacts(surface: Surface): void {
    if (surface.wallContact) this.wallContacts(surface);
    for (const p of this.bodyPoints) {
      const arm = rotateV(this.t0, this.rot, p);
      const wx = this.pos.x + arm.x;
      const wy = this.pos.y + arm.y;
      const wz = this.pos.z + arm.z;
      const depth = surface.heightAt(wx, wz) - wy;
      if (depth <= 0) continue;
      const vp = crossV(this.t1, this.angVel, arm);
      addScaledV(vp, vp, this.vel, 1);
      const normalForce = Math.max(BODY_STIFFNESS * depth - BODY_DAMPING * vp.y, 0);
      // Friction opposes sliding; capped by a velocity term so it doesn't jitter at rest.
      const tx = vp.x;
      const tz = vp.z;
      const tSpeed = Math.sqrt(tx * tx + tz * tz);
      const friction =
        tSpeed > 1e-6 ? Math.min(BODY_FRICTION * normalForce, tSpeed * 8_000) / tSpeed : 0;
      const f = setV(this.t2, -tx * friction, normalForce, -tz * friction);
      crossV(vScratch, arm, f);
      addScaledV(this.torque, this.torque, vScratch, 1);
      addScaledV(this.force, this.force, f, 1);
    }
  }

  /** Barriers push the body's corners back onto the track, with scraping friction. */
  private wallContacts(surface: Surface): void {
    const normal = wallNormal;
    for (const p of this.wallPoints) {
      const arm = rotateV(this.t0, this.rot, p);
      const wx = this.pos.x + arm.x;
      const wz = this.pos.z + arm.z;
      const depth = surface.wallContact!(wx, wz, normal);
      if (depth <= 0) continue;
      const vp = crossV(this.t1, this.angVel, arm);
      addScaledV(vp, vp, this.vel, 1);
      const vn = vp.x * normal.nx + vp.z * normal.nz;
      const push = Math.max(WALL_STIFFNESS * depth - WALL_DAMPING * vn, 0);
      // Sliding along the wall: friction against the tangential velocity.
      const tx = vp.x - vn * normal.nx;
      const tz = vp.z - vn * normal.nz;
      const tSpeed = Math.hypot(tx, tz);
      const friction = tSpeed > 1e-4 ? Math.min(WALL_FRICTION * push, tSpeed * 20_000) / tSpeed : 0;
      const f = setV(
        this.t2,
        normal.nx * push - tx * friction,
        0,
        normal.nz * push - tz * friction,
      );
      this.impactForce = Math.max(this.impactForce, push);
      if (-vn > DAMAGE_MIN_SPEED) this.takeDamage(p, push * -vn * SIM_DT);
      crossV(vScratch, arm, f);
      addScaledV(this.torque, this.torque, vScratch, 1);
      addScaledV(this.force, this.force, f, 1);
    }
  }

  /**
   * Applies an instantaneous impulse (N·s) at a world-space point, e.g. from a collision with
   * another car.
   */
  applyImpulse(point: Vec3, impulse: Vec3): void {
    addScaledV(this.vel, this.vel, impulse, 1 / this.spec.mass);
    // Angular impulse in the body frame, divided by the principal inertias.
    const arm = subV(vScratch3, point, this.pos);
    const torque = crossV(vScratch2, arm, impulse);
    const local = invRotateV(vScratch2, this.rot, torque);
    const I = this.spec.inertia;
    local.x /= I.pitch;
    local.y /= I.yaw;
    local.z /= I.roll;
    const world = rotateV(vScratch2, this.rot, local);
    addScaledV(this.angVel, this.angVel, world, 1);
    const j = Math.hypot(impulse.x, impulse.y, impulse.z);
    this.impactForce = Math.max(this.impactForce, j * 400);
    if (j / this.spec.mass > DAMAGE_MIN_SPEED * 0.5) {
      const at = invRotateV(vScratch3, this.rot, subV(vScratch3, point, this.pos));
      this.takeDamage(at, (j * j) / (2 * this.spec.mass));
    }
  }

  /** Impact energy (J) at a point in the car's frame damages the parts near it. */
  private takeDamage(at: Vec3, energy: number): void {
    if (this.damageScale <= 0 || !(energy > 0)) return;
    const units = (energy * this.damageScale) / (DAMAGE_ENERGY_PER_KG * this.spec.mass);
    const d = this.damage;
    if (at.z < 0) {
      // Front: wing and splitter, radiators, and the steering on that side.
      d.aero = Math.min(d.aero + units * 0.8, 1);
      d.engine = Math.min(d.engine + units * 0.25, 1);
      const side = at.x > 0 ? 1 : -1;
      d.steering = clamp(d.steering + side * units * 0.6, -1, 1);
    } else {
      // Rear: wing and diffuser, gearbox and exhaust.
      d.aero = Math.min(d.aero + units * 0.6, 1);
      d.engine = Math.min(d.engine + units * 0.35, 1);
    }
  }

  /** Back to as new (a restart). */
  repair(): void {
    this.damage.aero = 0;
    this.damage.engine = 0;
    this.damage.steering = 0;
  }

  /** Acceleration the driver feels (everything but gravity), in the car's frame, smoothed. */
  private measureAcceleration(dt: number): void {
    const m = this.spec.mass;
    const ax = this.force.x / m;
    const ay = this.force.y / m + GRAVITY;
    const az = this.force.z / m;
    const long = ax * this.fwd.x + ay * this.fwd.y + az * this.fwd.z;
    const lat = ax * this.right.x + ay * this.right.y + az * this.right.z;
    this.forwardAccel = long - GRAVITY * this.fwd.y;
    const k = 1 - Math.exp(-dt / 0.05);
    this.accelLong += (long - this.accelLong) * k;
    this.accelLat += (lat - this.accelLat) * k;
  }

  // ---------------------------------------------------------------- integration

  private applyForce(dir: Vec3, magnitude: number, at: Vec3): void {
    const f = setV(vScratch2, dir.x * magnitude, dir.y * magnitude, dir.z * magnitude);
    this.applyForceVec(f, at);
  }

  private applyForceVec(f: Vec3, at: Vec3): void {
    addScaledV(this.force, this.force, f, 1);
    const arm = subV(vScratch3, at, this.pos);
    crossV(arm, arm, f);
    addScaledV(this.torque, this.torque, arm, 1);
  }

  private integrate(dt: number): void {
    const spec = this.spec;
    addScaledV(this.vel, this.vel, this.force, dt / spec.mass);

    // Angular velocity in the body frame, including the gyroscopic term ω × Iω.
    const I = spec.inertia;
    const w = invRotateV(this.t0, this.rot, this.angVel);
    const tau = invRotateV(this.t1, this.rot, this.torque);
    const lx = I.pitch * w.x;
    const ly = I.yaw * w.y;
    const lz = I.roll * w.z;
    const gx = w.y * lz - w.z * ly;
    const gy = w.z * lx - w.x * lz;
    const gz = w.x * ly - w.y * lx;
    w.x += ((tau.x - gx) / I.pitch) * dt;
    w.y += ((tau.y - gy) / I.yaw) * dt;
    w.z += ((tau.z - gz) / I.roll) * dt;
    rotateV(this.angVel, this.rot, w);

    addScaledV(this.pos, this.pos, this.vel, dt);
    integrateQ(this.rot, this.angVel, dt);
  }

  private afterStep(dt: number): void {
    const e = this.spec.engine;

    // Rev limiter with a little hysteresis.
    if (this.engineRpm > e.limiterRpm) this.limiterActive = true;
    else if (this.engineRpm < e.limiterRpm - 250) this.limiterActive = false;

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(this.shiftTimer - dt, 0);
    if (this.shiftCooldown > 0) this.shiftCooldown = Math.max(this.shiftCooldown - dt, 0);
    if (this.shiftDeniedTimer > 0) this.shiftDeniedTimer = Math.max(this.shiftDeniedTimer - dt, 0);
    if (this.aids.gearbox === 'manual') this.manualGearbox();
    else this.autoGearbox();
  }

  /** Paddle shifts, one at a time, with over-rev protection on downshifts. */
  private manualGearbox(): void {
    if (this.shiftTimer > 0) return;
    const gb = this.spec.gearbox;
    const speed = Math.abs(this.forwardSpeed());
    if (this.pendingUp > 0) {
      this.pendingUp--;
      if (this.gear < 0) {
        if (speed < REVERSE_SELECT_SPEED) this.gear = 1;
        else this.shiftDeniedTimer = 0.4;
      } else if (this.gear < gb.ratios.length) {
        this.shift(this.gear + 1);
      }
      return;
    }
    if (this.pendingDown > 0) {
      this.pendingDown--;
      if (this.gear === 1) {
        if (speed < REVERSE_SELECT_SPEED) this.gear = -1;
        else this.shiftDeniedTimer = 0.4;
      } else if (this.gear > 1) {
        if (this.drivenRpm(this.gear - 1) < this.spec.engine.limiterRpm + OVER_REV_MARGIN) {
          this.shift(this.gear - 1);
        } else {
          this.shiftDeniedTimer = 0.4;
        }
      }
    }
  }

  private autoGearbox(): void {
    this.pendingUp = 0;
    this.pendingDown = 0;
    if (this.gear <= 0 || this.shiftTimer > 0 || this.shiftCooldown > 0) return;
    const gb = this.spec.gearbox;
    const rpm = this.drivenRpm(this.gear);
    // While braking, change down earlier so the right gear is ready for the corner exit.
    const downAt = this.brake > 0.3 ? gb.brakingDownshiftRpm : gb.downshiftRpm;
    if (this.gear < gb.ratios.length && rpm > gb.upshiftRpm) {
      this.shift(this.gear + 1);
    } else if (
      this.gear > 1 &&
      rpm < downAt &&
      this.drivenRpm(this.gear - 1) < gb.upshiftRpm - 400
    ) {
      this.shift(this.gear - 1);
    }
  }

  private shift(gear: number): void {
    this.gear = gear;
    this.shiftTimer = this.spec.gearbox.shiftTime;
    this.shiftCooldown = 0.35;
  }

  // ---------------------------------------------------------------- snapshot

  writeSnapshot(out: Float32Array, base: number): void {
    out[base + C.PREV_POS] = this.prevPos.x;
    out[base + C.PREV_POS + 1] = this.prevPos.y;
    out[base + C.PREV_POS + 2] = this.prevPos.z;
    out[base + C.PREV_ROT] = this.prevRot.x;
    out[base + C.PREV_ROT + 1] = this.prevRot.y;
    out[base + C.PREV_ROT + 2] = this.prevRot.z;
    out[base + C.PREV_ROT + 3] = this.prevRot.w;
    out[base + C.POS] = this.pos.x;
    out[base + C.POS + 1] = this.pos.y;
    out[base + C.POS + 2] = this.pos.z;
    out[base + C.ROT] = this.rot.x;
    out[base + C.ROT + 1] = this.rot.y;
    out[base + C.ROT + 2] = this.rot.z;
    out[base + C.ROT + 3] = this.rot.w;
    out[base + C.VEL] = this.vel.x;
    out[base + C.VEL + 1] = this.vel.y;
    out[base + C.VEL + 2] = this.vel.z;
    out[base + C.SPEED] = this.forwardSpeed();
    out[base + C.RPM] = this.engineRpm;
    out[base + C.GEAR] = this.gear;
    out[base + C.THROTTLE] = this.throttle;
    out[base + C.BRAKE] = this.brake;
    out[base + C.STEER] = this.roadAngle / this.spec.front.maxSteer;
    out[base + C.HANDBRAKE] = this.handbrake;
    rotateV(this.up, this.rot, UP);
    out[base + C.FLAGS] =
      (this.absActive ? FLAG_ABS : 0) |
      (this.tcActive ? FLAG_TC : 0) |
      (this.shiftTimer > 0 ? FLAG_SHIFTING : 0) |
      (this.up.y < 0.3 ? FLAG_UPSIDE_DOWN : 0) |
      (this.limiterActive ? FLAG_LIMITER : 0) |
      (this.shiftDeniedTimer > 0 ? FLAG_SHIFT_DENIED : 0);
    out[base + C.ACCEL_LONG] = this.accelLong;
    out[base + C.ACCEL_LAT] = this.accelLat;
    out[base + C.STEER_ANGLE] = (this.wheels[0]!.steer + this.wheels[1]!.steer) / 2;
    out[base + C.STEER_AUTHORITY] = this.steerAuthority;
    out[base + C.CLUTCH] = this.clutchEngagement;
    out[base + C.GEARBOX_MANUAL] = this.aids.gearbox === 'manual' ? 1 : 0;
    out[base + C.TC_LEVEL] = aidLevelNumber(this.aids.tc);
    out[base + C.ABS_LEVEL] = aidLevelNumber(this.aids.abs);
    out[base + C.DAMAGE_AERO] = this.damage.aero;
    out[base + C.DAMAGE_ENGINE] = this.damage.engine;
    out[base + C.DAMAGE_STEER] = this.damage.steering;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i]!;
      const o = base + C.WHEELS + i * WHEEL_STRIDE;
      out[o + W.PREV_LENGTH] = w.prevLength;
      out[o + W.LENGTH] = w.length;
      out[o + W.PREV_STEER] = w.prevSteer;
      out[o + W.STEER] = w.steer;
      out[o + W.PREV_SPIN] = w.prevSpin;
      out[o + W.SPIN] = w.spin;
      out[o + W.SLIP] = w.slip;
      out[o + W.LOAD] = w.load;
      out[o + W.CONTACT] = w.contact ? 1 : 0;
      out[o + W.SLIP_RATIO] = w.slipRatio;
      out[o + W.SLIP_ANGLE] = w.slipAngle;
      out[o + W.SURFACE] = w.surface;
      out[o + W.CAMBER] = w.camber;
    }
  }
}

const vScratch = vec3();
const vScratch2 = vec3();
const vScratch3 = vec3();
const wallNormal = { nx: 0, nz: 0 };

function wrapAngle(a: number): number {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}
