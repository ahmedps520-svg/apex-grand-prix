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
  normalizeV,
  quat,
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
  FLAG_SHIFTING,
  FLAG_TC,
  FLAG_UPSIDE_DOWN,
  W,
  WHEEL_STRIDE,
  neutralInput,
  type DriverInput,
} from '../../shared/protocol';
import { SURFACE_PROPS, rayHit, type Surface } from '../track/surface';
import type { AxleSpec, CarSpec } from './spec';
import { TyreModel, tyreOutput } from './tyre';

const GRAVITY = 9.81;
const AIR_DENSITY = 1.225;
const TWO_PI = Math.PI * 2;
const RPM_PER_RAD_S = 60 / TWO_PI;
/** Speed floors for the slip formulas; they keep the tyre model stable near standstill. */
const V_LONG_MIN = 2;
const V_LAT_MIN = 2;
/** Body-to-ground contact (bottoming out, rollovers). */
const BODY_STIFFNESS = 250_000;
const BODY_DAMPING = 12_000;
const BODY_FRICTION = 0.55;
/** ABS / traction control aim for this fraction of the tyre's peak slip ratio… */
const ASSIST_SLIP_FRACTION = 0.9;
/** …and correct wheel speed over roughly this many seconds. */
const ASSIST_RESPONSE = 0.02;

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const FORWARD: Vec3 = { x: 0, y: 0, z: -1 };

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
  driveTorque = 0;
  extraInertia = 0;

  // Per-step scratch values.
  readonly hardpointWorld = vec3();
  readonly contactPoint = vec3();
  readonly normal = vec3(0, 1, 0);
  cosAngle = 1;
  grip = 1;
  rollingResistance = 0;

  constructor(
    readonly axle: AxleSpec,
    /** -1 = left, +1 = right. */
    readonly side: number,
    readonly isFront: boolean,
    cogHeight: number,
    staticLoad: number,
  ) {
    this.tyre = new TyreModel(axle.tyre, staticLoad);
    const hardpointY = axle.wheelRadius - cogHeight + axle.staticLength;
    this.hardpoint = vec3(side * axle.halfTrack, hardpointY, -axle.offset);
    this.freeLength = axle.staticLength + staticLoad / axle.springRate;
    this.fullBumpLength = axle.maxLength - axle.travel;
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

  /** Filtered controls. */
  steer = 0;
  throttle = 0;
  brake = 0;
  handbrake = 0;

  gear = 1;
  engineRpm: number;
  shiftTimer = 0;
  shiftCooldown = 0;
  reverseMode = false;
  limiterActive = false;
  /** Driver aids (Round 3 exposes them as settings). */
  readonly assists = { abs: true, tc: true };
  /** True if ABS / traction control limited a wheel during the last step. */
  absActive = false;
  tcActive = false;

  private reverseHold = 0;
  private forwardHold = 0;
  private readonly spawn: Spawn;
  private readonly bodyPoints: Vec3[];

  // World-space scratch.
  private readonly up = vec3();
  private readonly fwd = vec3();
  private readonly force = vec3();
  private readonly torque = vec3();
  private readonly t0 = vec3();
  private readonly t1 = vec3();
  private readonly t2 = vec3();
  private readonly hit = rayHit();
  private readonly tyreOut = tyreOutput();

  constructor(
    readonly spec: CarSpec,
    spawn: Spawn,
  ) {
    const wheelbase = spec.front.offset - spec.rear.offset;
    const frontShare = -spec.rear.offset / wheelbase;
    const frontLoad = (spec.mass * GRAVITY * frontShare) / 2;
    const rearLoad = (spec.mass * GRAVITY * (1 - frontShare)) / 2;
    this.wheels = [
      new Wheel(spec.front, -1, true, spec.cogHeight, frontLoad),
      new Wheel(spec.front, 1, true, spec.cogHeight, frontLoad),
      new Wheel(spec.rear, -1, false, spec.cogHeight, rearLoad),
      new Wheel(spec.rear, 1, false, spec.cogHeight, rearLoad),
    ];
    const b = spec.body;
    this.bodyPoints = [];
    for (const x of [-b.halfWidth, b.halfWidth]) {
      for (const y of [b.floor, b.roof]) {
        for (const z of [-b.front, 0, b.rear]) this.bodyPoints.push(vec3(x, y, z));
      }
    }
    this.engineRpm = spec.engine.idleRpm;
    this.spawn = spawn;
    this.reset(spawn);
  }

  /** Places the car at rest on the ground at `spawn`. */
  reset(spawn: Spawn = this.spawn): void {
    setV(this.pos, spawn.x, this.spec.cogHeight, spawn.z);
    quatFromYaw(this.rot, spawn.yaw);
    setV(this.vel, 0, 0, 0);
    setV(this.angVel, 0, 0, 0);
    for (const w of this.wheels) {
      w.length = w.axle.staticLength;
      w.lengthRate = 0;
      w.omega = 0;
      w.steer = 0;
      w.load = 0;
      w.slip = 0;
    }
    this.steer = 0;
    this.throttle = 0;
    this.brake = 0;
    this.handbrake = 0;
    this.gear = 1;
    this.reverseMode = false;
    this.shiftTimer = 0;
    this.shiftCooldown = 0;
    this.engineRpm = this.spec.engine.idleRpm;
    this.storePrevious();
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
      this.wheels.every((w) => Number.isFinite(w.omega) && Number.isFinite(w.length))
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
    this.updateControls(dt);
    this.absActive = false;
    this.tcActive = false;
    setV(this.force, 0, -this.spec.mass * GRAVITY, 0);
    setV(this.torque, 0, 0, 0);

    for (const w of this.wheels) this.probe(w, surface, dt);
    this.suspension(this.wheels[0]!, this.wheels[1]!);
    this.suspension(this.wheels[2]!, this.wheels[3]!);
    this.drivetrain(dt);
    for (const w of this.wheels) this.tyreForces(w, dt);
    this.aero();
    this.bodyContacts(surface);
    this.integrate(dt);
    this.afterStep(dt);
  }

  // ---------------------------------------------------------------- controls

  private updateControls(dt: number): void {
    const input = this.input;
    const speed = dotV(this.vel, this.fwd);

    // Automatic reverse: hold the brake at a standstill to select reverse, throttle to go back.
    if (!this.reverseMode) {
      this.reverseHold =
        speed < 0.8 && input.brake > 0.6 && input.throttle < 0.1 ? this.reverseHold + dt : 0;
      if (this.reverseHold > 0.35) {
        this.reverseMode = true;
        this.gear = -1;
        this.reverseHold = 0;
      }
    } else {
      this.forwardHold =
        speed > -0.8 && input.throttle > 0.6 && input.brake < 0.1 ? this.forwardHold + dt : 0;
      if (this.forwardHold > 0.1) {
        this.reverseMode = false;
        this.gear = 1;
        this.forwardHold = 0;
      }
    }
    const throttleCmd = this.reverseMode ? input.brake : input.throttle;
    const brakeCmd = this.reverseMode ? input.throttle : input.brake;
    this.throttle = approach(this.throttle, clamp(throttleCmd, 0, 1), 8 * dt);
    this.brake = approach(this.brake, clamp(brakeCmd, 0, 1), 10 * dt);
    this.handbrake = approach(this.handbrake, clamp(input.handbrake, 0, 1), 12 * dt);

    // Steering: digital input ramps, analog input gets a light filter.
    const target = clamp(input.steer, -1, 1);
    if (input.steerIsDigital) {
      const releasing = Math.abs(target) < Math.abs(this.steer) || target * this.steer < 0;
      this.steer = approach(this.steer, target, (releasing ? 4.5 : 2.2) * dt);
    } else {
      this.steer += (target - this.steer) * (1 - Math.exp(-dt / 0.035));
    }

    // Less steering lock at speed so pads and keys stay controllable (Round 2 makes it a setting).
    const v = Math.abs(speed) / 28;
    const speedFactor = Math.max(1 / (1 + v * v * 1.2), 0.12);
    const angle = this.steer * this.spec.front.maxSteer * speedFactor;
    this.applySteer(angle);
  }

  private applySteer(angle: number): void {
    const front = this.spec.front;
    const wheelbase = front.offset - this.spec.rear.offset;
    const abs = Math.abs(angle);
    let inner = abs;
    let outer = abs;
    if (abs > 1e-4 && front.ackermann > 0) {
      const radius = wheelbase / Math.tan(abs);
      const innerIdeal = Math.atan(wheelbase / Math.max(radius - front.halfTrack, 0.1));
      const outerIdeal = Math.atan(wheelbase / (radius + front.halfTrack));
      inner = abs + (innerIdeal - abs) * front.ackermann;
      outer = abs + (outerIdeal - abs) * front.ackermann;
    }
    const sign = Math.sign(angle);
    // Turning right (angle > 0): the right wheel is on the inside.
    const left = this.wheels[0]!;
    const right = this.wheels[1]!;
    left.steer = sign * (angle > 0 ? outer : inner);
    right.steer = sign * (angle > 0 ? inner : outer);
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
      w.grip = props.grip;
      w.rollingResistance = props.rollingResistance;
    } else {
      w.contact = false;
      // The wheel drops towards full droop (visual only; there is no unsprung mass yet).
      w.length = approach(w.length, axle.maxLength, 1.5 * dt);
      w.lengthRate = 0;
      w.load = 0;
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

  private totalRatio(): number {
    const gb = this.spec.gearbox;
    if (this.gear > 0) return gb.ratios[this.gear - 1]! * gb.finalDrive;
    if (this.gear < 0) return -gb.reverseRatio * gb.finalDrive;
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
    return throttle * full - (1 - throttle) * friction;
  }

  private drivetrain(dt: number): void {
    const spec = this.spec;
    const e = spec.engine;
    const gb = spec.gearbox;
    const left = this.wheels[2]!;
    const right = this.wheels[3]!;
    for (const w of this.wheels) {
      w.driveTorque = 0;
      w.extraInertia = 0;
    }

    const ratio = this.totalRatio();
    const wheelOmega = (left.omega + right.omega) / 2;
    const rpmAtWheels = wheelOmega * ratio * RPM_PER_RAD_S;
    const throttle = this.throttle;

    let clutchTorque = 0;
    if (ratio === 0 || this.shiftTimer > 0) {
      // Neutral or mid-shift: no drive, engine speed follows the wheels (or idles).
      this.engineRpm = approach(this.engineRpm, Math.max(rpmAtWheels, e.idleRpm), 20_000 * dt);
    } else {
      const launchRpm = e.idleRpm + throttle * (4_200 - e.idleRpm);
      if (throttle > 0.01 && rpmAtWheels < launchRpm) {
        // Clutch slipping (pulling away): the engine holds its launch rpm and the clutch passes
        // on its torque.
        this.engineRpm = approach(this.engineRpm, launchRpm, 12_000 * dt);
        clutchTorque = Math.max(this.engineTorque(this.engineRpm, throttle), 0);
      } else if (rpmAtWheels < e.idleRpm) {
        // Coasting below idle: clutch open.
        this.engineRpm = approach(this.engineRpm, e.idleRpm, 8_000 * dt);
      } else {
        this.engineRpm = rpmAtWheels;
        clutchTorque = this.engineTorque(this.engineRpm, throttle);
        // With the clutch closed, the engine's inertia is felt at the driven wheels.
        const reflected = (e.inertia * ratio * ratio) / 2;
        left.extraInertia = reflected;
        right.extraInertia = reflected;
      }
    }
    const axleTorque = clutchTorque * ratio * gb.efficiency;
    const coupling = spec.diffViscous * (right.omega - left.omega);
    left.driveTorque = axleTorque / 2 + coupling;
    right.driveTorque = axleTorque / 2 - coupling;
  }

  // ---------------------------------------------------------------- tyres

  private tyreForces(w: Wheel, dt: number): void {
    const axle = w.axle;
    const radius = axle.wheelRadius;
    const inertia = axle.wheelInertia + w.extraInertia;
    let brakeTorque = axle.brakeTorque * this.brake;
    const handbrakeTorque = axle.handbrakeTorque * this.handbrake;

    if (!w.contact) {
      // Free wheel in the air: drive and brakes only.
      let omega = w.omega + (dt * w.driveTorque) / inertia;
      const stop = (dt * (brakeTorque + handbrakeTorque + 5)) / inertia;
      omega = Math.abs(omega) <= stop ? 0 : omega - Math.sign(omega) * stop;
      w.omega = omega;
      w.slip = 0;
      w.slipRatio = 0;
      w.slipAngle = 0;
      w.spin = wrapAngle(w.spin + omega * dt);
      return;
    }

    // Wheel heading projected onto the ground plane.
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

    const alpha = Math.atan2(vLat, Math.max(Math.abs(vLong), V_LAT_MIN));
    const kappa = (w.omega * radius - vLong) / longRef;
    const out = w.tyre.compute(kappa, alpha, w.load, w.grip, this.tyreOut);

    // ABS and traction control as slip controllers: allow only as much brake or drive torque as
    // steers the wheel towards a target slip just below the tyre's peak (over ~20 ms).
    // Implicit wheel spin: when the wheel speeds up, the tyre force grows and pushes back, so
    // the wheel behaves as if it had a larger inertia (inertia × denom). Integrating against
    // that keeps it stable however stiff the tyre is.
    const dfxdOmega = (Math.max(out.dfxdk, 0) * radius) / longRef;
    const denom = 1 + (dt * radius * dfxdOmega) / inertia;
    const effectiveInertia = inertia * denom;
    const rolling = w.rollingResistance * w.load * radius;

    // ABS and traction control as slip controllers: allow only as much brake or drive torque as
    // steers the wheel towards a target slip just below the tyre's peak (over ~20 ms). While
    // cornering, part of the tyre's grip is used sideways, so the target shrinks.
    let driveTorque = w.driveTorque;
    const lateralUse = Math.min(Math.abs(alpha) / w.tyre.alphaPeak, 1);
    const room = Math.sqrt(Math.max(ASSIST_SLIP_FRACTION ** 2 - lateralUse ** 2, 0.2 ** 2));
    const targetSlip = w.tyre.kappaPeak * room;
    if (this.assists.abs && brakeTorque > 0 && vLong > 2.5) {
      const omegaTarget = (vLong - targetSlip * longRef) / radius;
      const allowed =
        driveTorque -
        out.fx * radius -
        rolling +
        (effectiveInertia * (w.omega - omegaTarget)) / ASSIST_RESPONSE;
      if (brakeTorque > allowed) {
        brakeTorque = Math.max(allowed, 0);
        this.absActive = true;
      }
    }
    if (this.assists.tc && driveTorque > 0 && vLong > -1) {
      const omegaTarget = (vLong + targetSlip * longRef) / radius;
      const allowed =
        out.fx * radius + rolling + (effectiveInertia * (omegaTarget - w.omega)) / ASSIST_RESPONSE;
      if (driveTorque > allowed) {
        driveTorque = Math.max(allowed, 0);
        this.tcActive = true;
      }
    }

    const free = w.omega + (dt * (driveTorque - out.fx * radius)) / effectiveInertia;
    const resist = brakeTorque + handbrakeTorque + rolling;
    const stop = (dt * resist) / effectiveInertia;
    const omega = Math.abs(free) <= stop ? 0 : free - Math.sign(free) * stop;
    let fx = out.fx + dfxdOmega * (omega - w.omega);
    fx = clamp(fx, -out.fxMax, out.fxMax);
    w.omega = omega;
    w.spin = wrapAngle(w.spin + omega * dt);
    w.slip = out.slip;
    w.slipRatio = kappa;
    w.slipAngle = alpha;

    // Tyre force on the body, acting at roll-centre height above the contact patch.
    const f = this.t2;
    setV(
      f,
      heading.x * fx + right.x * out.fy,
      heading.y * fx + right.y * out.fy,
      heading.z * fx + right.z * out.fy,
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
    const dragScale = -0.5 * AIR_DENSITY * a.dragArea * speed;
    addScaledV(this.force, this.force, v, dragScale);
    const vLong = dotV(v, this.fwd);
    const downforce = 0.5 * AIR_DENSITY * a.downforceArea * vLong * vLong;
    const frontPoint = addScaledV(this.t0, this.pos, this.fwd, this.spec.front.offset);
    this.applyForce(this.up, -downforce * a.frontShare, frontPoint);
    const rearPoint = addScaledV(this.t1, this.pos, this.fwd, this.spec.rear.offset);
    this.applyForce(this.up, -downforce * (1 - a.frontShare), rearPoint);
  }

  private bodyContacts(surface: Surface): void {
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
    const gb = this.spec.gearbox;

    // Rev limiter with a little hysteresis.
    if (this.engineRpm > e.limiterRpm) this.limiterActive = true;
    else if (this.engineRpm < e.limiterRpm - 250) this.limiterActive = false;

    // Automatic gearbox.
    if (this.shiftTimer > 0) this.shiftTimer = Math.max(this.shiftTimer - dt, 0);
    if (this.shiftCooldown > 0) this.shiftCooldown = Math.max(this.shiftCooldown - dt, 0);
    if (this.gear > 0 && this.shiftTimer === 0 && this.shiftCooldown === 0) {
      const rear = (this.wheels[2]!.omega + this.wheels[3]!.omega) / 2;
      const rpmIn = (gear: number) => rear * gb.ratios[gear - 1]! * gb.finalDrive * RPM_PER_RAD_S;
      if (this.gear < gb.ratios.length && rpmIn(this.gear) > gb.upshiftRpm) {
        this.shift(this.gear + 1);
      } else if (
        this.gear > 1 &&
        rpmIn(this.gear) < gb.downshiftRpm &&
        rpmIn(this.gear - 1) < gb.upshiftRpm - 400
      ) {
        this.shift(this.gear - 1);
      }
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
    out[base + C.STEER] = this.steer;
    out[base + C.HANDBRAKE] = this.handbrake;
    rotateV(this.up, this.rot, UP);
    out[base + C.FLAGS] =
      (this.absActive ? FLAG_ABS : 0) |
      (this.tcActive ? FLAG_TC : 0) |
      (this.shiftTimer > 0 ? FLAG_SHIFTING : 0) |
      (this.up.y < 0.3 ? FLAG_UPSIDE_DOWN : 0) |
      (this.limiterActive ? FLAG_LIMITER : 0);
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
    }
  }
}

const vScratch = vec3();
const vScratch2 = vec3();
const vScratch3 = vec3();

function wrapAngle(a: number): number {
  a %= TWO_PI;
  return a < 0 ? a + TWO_PI : a;
}
