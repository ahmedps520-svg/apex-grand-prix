import { describe, expect, it } from 'vitest';
import { forwardOf, quat, quatFromYaw, vec3, yawOf } from '../../src/shared/math';

describe("a car's heading from its rotation", () => {
  it('gives back the yaw it was built from, and the forward direction', () => {
    for (const yaw of [0, 0.7, -2.1, Math.PI - 0.01, -Math.PI + 0.01]) {
      const q = quatFromYaw(quat(), yaw);
      const f = forwardOf(vec3(), q);
      expect(f.x).toBeCloseTo(-Math.sin(yaw), 6);
      expect(f.z).toBeCloseTo(-Math.cos(yaw), 6);
      expect(f.y).toBeCloseTo(0, 6);
      let d = yawOf(q) - yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      expect(Math.abs(d)).toBeLessThan(1e-6);
    }
  });
});
