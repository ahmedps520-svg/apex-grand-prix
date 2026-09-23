import { describe, expect, it } from 'vitest';
import { createCarRenderState, interpolateCar } from '../../src/render/interpolate';
import { lerpAngle, quat, quatFromYaw, slerpQ } from '../../src/shared/math';
import { C, CAR_STRIDE, W } from '../../src/shared/protocol';

function snapshot(): Float32Array {
  const buf = new Float32Array(CAR_STRIDE);
  buf.set([0, 0.5, 10], C.PREV_POS);
  buf.set([2, 0.5, 6], C.POS);
  const a = quatFromYaw(quat(), 0);
  const b = quatFromYaw(quat(), 0.2);
  buf.set([a.x, a.y, a.z, a.w], C.PREV_ROT);
  buf.set([b.x, b.y, b.z, b.w], C.ROT);
  const wheel = C.WHEELS;
  buf[wheel + W.PREV_SPIN] = 6.2;
  buf[wheel + W.SPIN] = 0.1; // wrapped past 2π between the two steps
  buf[wheel + W.PREV_LENGTH] = 0.1;
  buf[wheel + W.LENGTH] = 0.12;
  return buf;
}

describe('interpolateCar', () => {
  it('returns the previous state at alpha 0 and the current state at alpha 1', () => {
    const out = createCarRenderState();
    const buf = snapshot();
    interpolateCar(buf, 0, 0, out);
    expect(out.pos.x).toBeCloseTo(0);
    expect(out.pos.z).toBeCloseTo(10);
    interpolateCar(buf, 0, 1, out);
    expect(out.pos.x).toBeCloseTo(2);
    expect(out.pos.z).toBeCloseTo(6);
  });

  it('never extrapolates past the newest physics state', () => {
    const out = createCarRenderState();
    const buf = snapshot();
    interpolateCar(buf, 0, 1.7, out);
    expect(out.pos.x).toBeCloseTo(2);
    interpolateCar(buf, 0, -0.5, out);
    expect(out.pos.x).toBeCloseTo(0);
  });

  it('interpolates rotation on the unit sphere', () => {
    const out = createCarRenderState();
    interpolateCar(snapshot(), 0, 0.5, out);
    const expected = quatFromYaw(quat(), 0.1);
    expect(out.rot.y).toBeCloseTo(expected.y, 5);
    expect(out.rot.w).toBeCloseTo(expected.w, 5);
    const len = Math.hypot(out.rot.x, out.rot.y, out.rot.z, out.rot.w);
    expect(len).toBeCloseTo(1, 6);
  });

  it('interpolates wheel spin across the 2π wrap the short way', () => {
    const out = createCarRenderState();
    interpolateCar(snapshot(), 0, 0.5, out);
    const spin = out.wheels[0]!.spin;
    // Halfway between 6.2 and 0.1 (+2π) is ~6.4, i.e. just past a full turn, not ~3.15.
    expect(spin).toBeCloseTo(6.2 + (0.1 + 2 * Math.PI - 6.2) / 2, 5);
    expect(out.wheels[0]!.length).toBeCloseTo(0.11, 6);
  });
});

describe('math helpers', () => {
  it('slerp takes the shortest path', () => {
    const a = quatFromYaw(quat(), 0);
    const b = quatFromYaw(quat(), 0.5);
    const negB = { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    const out = slerpQ(quat(), a, negB, 0.5);
    const expected = quatFromYaw(quat(), 0.25);
    expect(Math.abs(out.y * expected.y + out.w * expected.w)).toBeCloseTo(1, 6);
  });

  it('lerpAngle wraps correctly', () => {
    expect(lerpAngle(3.0, -3.0, 0.5)).toBeCloseTo(Math.PI, 5);
  });
});
