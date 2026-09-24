import { vec3, type Vec3 } from '../../shared/math';
import { SIM_DT } from '../../shared/protocol';
import type { Car } from '../vehicle/car';

/** Bounce of car-to-car impacts (0 = dead, 1 = elastic). */
const RESTITUTION = 0.2;
/** Impacts slower than this don't bounce, so resting contacts stay quiet. */
const BOUNCE_THRESHOLD = 1;
/** Sliding friction between car bodies. */
const FRICTION = 0.3;
/** Cars further apart than this (centre to centre) can't touch. */
const BROAD_PHASE = 8;
/** Share of the overlap pushed out per step, and the fastest that push may separate the cars. */
const BAUMGARTE = 0.2;
const MAX_PUSH_SPEED = 1;
/** Overlap left alone so resting contacts don't jitter, metres. */
const SLOP = 0.005;

const circles = [vec3(), vec3(), vec3()];
const others = [vec3(), vec3(), vec3()];
const point = vec3();
const impulse = vec3();
const local = vec3();

/**
 * Car-to-car contacts: pushes overlapping cars apart with impulses and a little friction.
 * Each body is three circles along its length in the ground plane (radius = half its width);
 * overlapping circle pairs get equal and opposite impulses at the contact point that stop the
 * approach (with a little bounce), plus a capped push proportional to the overlap. Call once
 * per step after the cars have moved.
 */
export function resolveCarContacts(cars: readonly Car[], dt = SIM_DT): void {
  for (let i = 0; i < cars.length; i++) {
    const a = cars[i]!;
    if (a.retired) continue;
    for (let j = i + 1; j < cars.length; j++) {
      const b = cars[j]!;
      if (b.retired) continue;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      if (dx * dx + dz * dz > BROAD_PHASE * BROAD_PHASE) continue;
      // One car on top of the other (a rollover): leave it to the ground contacts.
      if (Math.abs(b.pos.y - a.pos.y) > 1.5) continue;
      placeCircles(a, circles);
      placeCircles(b, others);
      const ra = a.spec.body.halfWidth;
      const rb = b.spec.body.halfWidth;
      for (const ca of circles) {
        for (const cb of others) collide(a, b, ca, cb, ra, rb, dt);
      }
    }
  }
}

/** Circle centres (world x/z) at -front·0.6, 0 and +rear·0.6 along the body. */
function placeCircles(car: Car, out: Vec3[]): void {
  const q = car.rot;
  // Body +z (backwards) in world space.
  const bx = 2 * (q.x * q.z + q.w * q.y);
  const bz = 1 - 2 * (q.x * q.x + q.y * q.y);
  const len = Math.hypot(bx, bz) || 1;
  place(out[0]!, car, bx / len, bz / len, -car.spec.body.front * 0.6);
  place(out[1]!, car, bx / len, bz / len, 0);
  place(out[2]!, car, bx / len, bz / len, car.spec.body.rear * 0.6);
}

function place(c: Vec3, car: Car, bx: number, bz: number, along: number): void {
  c.x = car.pos.x + bx * along;
  c.y = car.pos.y;
  c.z = car.pos.z + bz * along;
}

function collide(a: Car, b: Car, ca: Vec3, cb: Vec3, ra: number, rb: number, dt: number): void {
  let nx = cb.x - ca.x;
  let nz = cb.z - ca.z;
  const dist = Math.hypot(nx, nz);
  const depth = ra + rb - dist;
  if (depth <= 0) return;
  if (dist > 1e-6) {
    nx /= dist;
    nz /= dist;
  } else {
    nx = 1;
    nz = 0;
  }
  // Contact point: middle of the overlap, at centre-of-gravity height so the push is all yaw.
  point.x = ca.x + nx * (ra - depth / 2);
  point.y = (a.pos.y + b.pos.y) / 2;
  point.z = ca.z + nz * (ra - depth / 2);
  const rax = point.x - a.pos.x;
  const raz = point.z - a.pos.z;
  const rbx = point.x - b.pos.x;
  const rbz = point.z - b.pos.z;
  // Velocities of the contact point on each body: v + ω × r (horizontal part).
  const vax = a.vel.x + a.angVel.y * raz - a.angVel.z * (point.y - a.pos.y);
  const vaz = a.vel.z + a.angVel.x * (point.y - a.pos.y) - a.angVel.y * rax;
  const vbx = b.vel.x + b.angVel.y * rbz - b.angVel.z * (point.y - b.pos.y);
  const vbz = b.vel.z + b.angVel.x * (point.y - b.pos.y) - b.angVel.y * rbx;
  const rvx = vbx - vax;
  const rvz = vbz - vaz;
  const vn = rvx * nx + rvz * nz;

  const bounce = vn < -BOUNCE_THRESHOLD ? -RESTITUTION * vn : 0;
  const push = Math.min((BAUMGARTE / dt) * Math.max(depth - SLOP, 0), MAX_PUSH_SPEED);
  const target = Math.max(bounce, push);
  if (vn >= target) return;
  const jn = (target - vn) / inverseMass(a, b, rax, raz, rbx, rbz, nx, nz);

  // Friction along the contact, limited by the normal impulse.
  const tx = -nz;
  const tz = nx;
  const vt = rvx * tx + rvz * tz;
  let jt = -vt / inverseMass(a, b, rax, raz, rbx, rbz, tx, tz);
  const maxFriction = FRICTION * jn;
  if (jt > maxFriction) jt = maxFriction;
  else if (jt < -maxFriction) jt = -maxFriction;

  impulse.x = nx * jn + tx * jt;
  impulse.y = 0;
  impulse.z = nz * jn + tz * jt;
  b.applyImpulse(point, impulse);
  local.x = -impulse.x;
  local.y = 0;
  local.z = -impulse.z;
  a.applyImpulse(point, local);
}

/** Inverse effective mass along a horizontal direction: both masses plus their yaw inertia. */
function inverseMass(
  a: Car,
  b: Car,
  rax: number,
  raz: number,
  rbx: number,
  rbz: number,
  dirX: number,
  dirZ: number,
): number {
  const ta = raz * dirX - rax * dirZ;
  const tb = rbz * dirX - rbx * dirZ;
  return (
    1 / a.spec.mass +
    1 / b.spec.mass +
    (ta * ta) / a.spec.inertia.yaw +
    (tb * tb) / b.spec.inertia.yaw
  );
}
