import { describe, expect, it } from 'vitest';
import {
  PART_BUMPER_FRONT,
  PART_HOOD,
  SIM_DT,
  SOFT_FLOATS,
  SOFT_NODES,
} from '../../src/shared/protocol';
import { SoftBody, latticeRest, nodeIndex } from '../../src/sim/vehicle/softbody';
import { TEST_MULE } from '../../src/sim/vehicle/spec';

const settle = (soft: SoftBody, seconds: number) => {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) soft.step(SIM_DT);
  soft.measure();
};

describe('soft body', () => {
  it('is built from the car with nothing bent', () => {
    const soft = new SoftBody(TEST_MULE);
    const rest = latticeRest(TEST_MULE);
    expect(rest.length).toBe(SOFT_NODES * 3);
    // The nose row sits at the front of the body, the tail row at the back.
    expect(rest[nodeIndex(1, 0, 0) * 3 + 2]).toBeCloseTo(-TEST_MULE.body.front);
    expect(rest[nodeIndex(1, 0, 4) * 3 + 2]).toBeCloseTo(TEST_MULE.body.rear);
    settle(soft, 0.5);
    expect(soft.damaged).toBe(false);
    expect(soft.metrics.front).toBe(0);
    const out = new Float32Array(SOFT_FLOATS);
    soft.writeSnapshot(out, 0);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });

  it('crumples the nose after a head-on blow, and it stays crumpled', () => {
    const soft = new SoftBody(TEST_MULE);
    const nose = -TEST_MULE.body.front;
    soft.impact(0, 0, nose, 0, 0, 1, 14);
    settle(soft, 1.5);
    const m = soft.metrics;
    expect(m.front).toBeGreaterThan(0.08);
    expect(m.rear).toBeLessThan(0.01);
    // The crumple zone takes it; the cabin and the rear corners stay put.
    expect(m.corner[2]).toBeLessThan(0.05);
    expect(Math.abs(m.bend)).toBeLessThan(0.02);
    expect(soft.damaged).toBe(true);
    // Settled: the shape no longer changes, and the snapshot carries the crush.
    const a = new Float32Array(SOFT_FLOATS);
    soft.writeSnapshot(a, 0);
    settle(soft, 0.5);
    const b = new Float32Array(SOFT_FLOATS);
    soft.writeSnapshot(b, 0);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(a[nodeIndex(1, 0, 0) * 3 + 2]).toBeGreaterThan(0.03);
  });

  it('bends the chassis away from a corner hit and takes the panels off in a big one', () => {
    const soft = new SoftBody(TEST_MULE);
    const body = TEST_MULE.body;
    // A hard blow on the front-left corner, pushing it back and to the right.
    soft.impact(-body.halfWidth, 0, -body.front, 0.45, 0, 0.9, 24);
    settle(soft, 2);
    const m = soft.metrics;
    expect(m.bend).toBeGreaterThan(0.01);
    expect(m.corner[0]).toBeGreaterThan(m.corner[1]);
    expect(m.corner[0]).toBeGreaterThan(0.2);
    expect(m.parts & PART_BUMPER_FRONT).toBeTruthy();
    expect(m.parts & PART_HOOD).toBeTruthy();
  });

  it('is as new after a reset', () => {
    const soft = new SoftBody(TEST_MULE);
    soft.impact(0, 0, -TEST_MULE.body.front, 0, 0, 1, 18);
    settle(soft, 1);
    expect(soft.metrics.front).toBeGreaterThan(0);
    soft.reset();
    expect(soft.damaged).toBe(false);
    expect(soft.metrics.front).toBe(0);
    expect(soft.metrics.parts).toBe(0);
    const out = new Float32Array(SOFT_FLOATS);
    soft.writeSnapshot(out, 0);
    expect(Array.from(out).every((v) => v === 0)).toBe(true);
  });
});
