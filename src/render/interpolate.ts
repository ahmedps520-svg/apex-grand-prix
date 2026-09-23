import { clamp, lerp, lerpAngle, quat, slerpQ, vec3, type Quat, type Vec3 } from '../shared/math';
import { C, CAR_STRIDE, W, WHEEL_COUNT, WHEEL_STRIDE } from '../shared/protocol';

/**
 * Turns a snapshot (previous + current physics state) into the pose to draw this frame. Pure
 * code without three.js so it can be unit tested; alpha is clamped to [0, 1] so the renderer
 * never extrapolates past the newest physics state.
 */

export interface WheelRenderState {
  length: number;
  steer: number;
  spin: number;
  slip: number;
  load: number;
  contact: boolean;
}

export interface CarRenderState {
  pos: Vec3;
  rot: Quat;
  vel: Vec3;
  speed: number;
  rpm: number;
  gear: number;
  throttle: number;
  brake: number;
  steer: number;
  handbrake: number;
  flags: number;
  wheels: WheelRenderState[];
}

export function createCarRenderState(): CarRenderState {
  const wheels: WheelRenderState[] = [];
  for (let i = 0; i < WHEEL_COUNT; i++) {
    wheels.push({ length: 0, steer: 0, spin: 0, slip: 0, load: 0, contact: false });
  }
  return {
    pos: vec3(),
    rot: quat(),
    vel: vec3(),
    speed: 0,
    rpm: 0,
    gear: 0,
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: 0,
    flags: 0,
    wheels,
  };
}

const prevRot = quat();
const currRot = quat();

export function interpolateCar(
  buf: Float32Array,
  carIndex: number,
  alpha: number,
  out: CarRenderState,
): CarRenderState {
  const t = clamp(alpha, 0, 1);
  const b = carIndex * CAR_STRIDE;
  out.pos.x = lerp(buf[b + C.PREV_POS]!, buf[b + C.POS]!, t);
  out.pos.y = lerp(buf[b + C.PREV_POS + 1]!, buf[b + C.POS + 1]!, t);
  out.pos.z = lerp(buf[b + C.PREV_POS + 2]!, buf[b + C.POS + 2]!, t);
  prevRot.x = buf[b + C.PREV_ROT]!;
  prevRot.y = buf[b + C.PREV_ROT + 1]!;
  prevRot.z = buf[b + C.PREV_ROT + 2]!;
  prevRot.w = buf[b + C.PREV_ROT + 3]!;
  currRot.x = buf[b + C.ROT]!;
  currRot.y = buf[b + C.ROT + 1]!;
  currRot.z = buf[b + C.ROT + 2]!;
  currRot.w = buf[b + C.ROT + 3]!;
  slerpQ(out.rot, prevRot, currRot, t);
  out.vel.x = buf[b + C.VEL]!;
  out.vel.y = buf[b + C.VEL + 1]!;
  out.vel.z = buf[b + C.VEL + 2]!;
  out.speed = buf[b + C.SPEED]!;
  out.rpm = buf[b + C.RPM]!;
  out.gear = buf[b + C.GEAR]!;
  out.throttle = buf[b + C.THROTTLE]!;
  out.brake = buf[b + C.BRAKE]!;
  out.steer = buf[b + C.STEER]!;
  out.handbrake = buf[b + C.HANDBRAKE]!;
  out.flags = buf[b + C.FLAGS]!;
  for (let i = 0; i < WHEEL_COUNT; i++) {
    const o = b + C.WHEELS + i * WHEEL_STRIDE;
    const w = out.wheels[i]!;
    w.length = lerp(buf[o + W.PREV_LENGTH]!, buf[o + W.LENGTH]!, t);
    w.steer = lerp(buf[o + W.PREV_STEER]!, buf[o + W.STEER]!, t);
    w.spin = lerpAngle(buf[o + W.PREV_SPIN]!, buf[o + W.SPIN]!, t);
    w.slip = buf[o + W.SLIP]!;
    w.load = buf[o + W.LOAD]!;
    w.contact = buf[o + W.CONTACT]! > 0.5;
  }
  return out;
}
