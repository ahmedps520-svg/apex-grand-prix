/**
 * Minimal allocation-free vector/quaternion math shared by the simulation (worker + Node tests)
 * and the main thread. Functions write into an `out` argument; `out` may alias inputs unless a
 * function says otherwise.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const quat = (x = 0, y = 0, z = 0, w = 1): Quat => ({ x, y, z, w });

export function setV(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyV(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function addV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function subV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function scaleV(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** out = a + b * s */
export function addScaledV(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export const dotV = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

/** out = a × b (safe when out aliases a or b). */
export function crossV(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export const lengthV = (a: Vec3): number => Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);

export function normalizeV(out: Vec3, a: Vec3): Vec3 {
  const len = lengthV(a);
  if (len < 1e-12) return setV(out, 0, 0, 0);
  return scaleV(out, a, 1 / len);
}

/** Rotates v by unit quaternion q (safe when out aliases v). */
export function rotateV(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);
  const x = v.x + q.w * tx + (q.y * tz - q.z * ty);
  const y = v.y + q.w * ty + (q.z * tx - q.x * tz);
  const z = v.z + q.w * tz + (q.x * ty - q.y * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

/** Rotates v by the inverse of unit quaternion q (world → body when q is body → world). */
export function invRotateV(out: Vec3, q: Quat, v: Vec3): Vec3 {
  const qx = -q.x;
  const qy = -q.y;
  const qz = -q.z;
  const tx = 2 * (qy * v.z - qz * v.y);
  const ty = 2 * (qz * v.x - qx * v.z);
  const tz = 2 * (qx * v.y - qy * v.x);
  const x = v.x + q.w * tx + (qy * tz - qz * ty);
  const y = v.y + q.w * ty + (qz * tx - qx * tz);
  const z = v.z + q.w * tz + (qx * ty - qy * tx);
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyQ(out: Quat, a: Quat): Quat {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  out.w = a.w;
  return out;
}

export function normalizeQ(q: Quat): Quat {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len < 1e-12) {
    q.x = 0;
    q.y = 0;
    q.z = 0;
    q.w = 1;
    return q;
  }
  const inv = 1 / len;
  q.x *= inv;
  q.y *= inv;
  q.z *= inv;
  q.w *= inv;
  return q;
}

/** Quaternion for a rotation of `angle` radians about the world Y (up) axis. */
export function quatFromYaw(out: Quat, angle: number): Quat {
  const h = angle * 0.5;
  out.x = 0;
  out.y = Math.sin(h);
  out.z = 0;
  out.w = Math.cos(h);
  return out;
}

/** out = a ⊗ b (rotate by b first, then by a). `out` may alias either input. */
export function mulQ(out: Quat, a: Quat, b: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y;
  const y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

/** Shortest rotation taking unit vector `from` onto unit vector `to`. */
export function quatFromUnitVectors(out: Quat, from: Vec3, to: Vec3): Quat {
  const r = dotV(from, to) + 1;
  if (r < 1e-8) {
    // Opposite vectors: turn half a revolution about any perpendicular axis.
    if (Math.abs(from.x) > Math.abs(from.z)) {
      out.x = -from.y;
      out.y = from.x;
      out.z = 0;
    } else {
      out.x = 0;
      out.y = -from.z;
      out.z = from.y;
    }
    out.w = 0;
    return normalizeQ(out);
  }
  out.x = from.y * to.z - from.z * to.y;
  out.y = from.z * to.x - from.x * to.z;
  out.z = from.x * to.y - from.y * to.x;
  out.w = r;
  return normalizeQ(out);
}

/**
 * Integrates orientation q by world-space angular velocity w over dt:
 * dq/dt = ½ (w, 0) ⊗ q. Renormalises afterwards.
 */
export function integrateQ(q: Quat, w: Vec3, dt: number): Quat {
  const h = 0.5 * dt;
  const wx = w.x * h;
  const wy = w.y * h;
  const wz = w.z * h;
  const qx = q.x;
  const qy = q.y;
  const qz = q.z;
  const qw = q.w;
  q.x = qx + (wx * qw + wy * qz - wz * qy);
  q.y = qy + (wy * qw + wz * qx - wx * qz);
  q.z = qz + (wz * qw + wx * qy - wy * qx);
  q.w = qw + (-wx * qx - wy * qy - wz * qz);
  return normalizeQ(q);
}

/** Spherical interpolation between unit quaternions a and b (shortest path). */
export function slerpQ(out: Quat, a: Quat, b: Quat, t: number): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let cos = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let s0: number;
  let s1: number;
  if (cos > 0.9995) {
    // Nearly identical: normalised lerp is accurate and avoids dividing by ~0.
    s0 = 1 - t;
    s1 = t;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    s0 = Math.sin((1 - t) * angle) / sin;
    s1 = Math.sin(t * angle) / sin;
  }
  out.x = a.x * s0 + bx * s1;
  out.y = a.y * s0 + by * s1;
  out.z = a.z * s0 + bz * s1;
  out.w = a.w * s0 + bw * s1;
  return normalizeQ(out);
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Interpolates two angles (radians) along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Moves `current` towards `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

export const isFiniteVec = (v: Vec3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

export const isFiniteQuat = (q: Quat): boolean =>
  Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);

/** Small deterministic PRNG (mulberry32) for tests, fuzzing and procedural placement. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
