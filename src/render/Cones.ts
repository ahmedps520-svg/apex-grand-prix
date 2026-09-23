import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { mulberry32 } from '../shared/math';
import type { BodySpec } from '../sim/vehicle/spec';
import type { CarRenderState } from './interpolate';
import type { ConePlacement } from './TestGroundScene';

const GRAVITY = 9.81;
const RESPAWN_AFTER = 7;
const CONE_RADIUS = 0.2;

interface Cone {
  home: THREE.Vector3;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  spin: THREE.Vector3;
  flying: boolean;
  down: boolean;
  timer: number;
}

/**
 * Traffic cones the car can knock flying. Purely cosmetic in Round 1 (they don't push back on
 * the car); all cones are one instanced mesh, so they cost a single draw call.
 */
export class Cones {
  readonly mesh: THREE.InstancedMesh;
  private readonly cones: Cone[];
  private readonly rand = mulberry32(99);
  private readonly matrix = new THREE.Matrix4();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly local = new THREE.Vector3();
  private readonly carQuat = new THREE.Quaternion();
  private readonly inverse = new THREE.Quaternion();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();

  constructor(
    placements: ConePlacement[],
    private readonly body: BodySpec,
  ) {
    this.mesh = new THREE.InstancedMesh(
      coneGeometry(),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }),
      placements.length,
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.cones = placements.map((p) => ({
      home: new THREE.Vector3(p.x, 0, p.z),
      pos: new THREE.Vector3(p.x, 0, p.z),
      vel: new THREE.Vector3(),
      rot: new THREE.Quaternion(),
      spin: new THREE.Vector3(),
      flying: false,
      down: false,
      timer: 0,
    }));
    this.cones.forEach((_, i) => this.write(i));
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  update(dt: number, car: CarRenderState): void {
    this.carQuat.set(car.rot.x, car.rot.y, car.rot.z, car.rot.w);
    this.inverse.copy(this.carQuat).invert();
    let changed = false;
    for (let i = 0; i < this.cones.length; i++) {
      const cone = this.cones[i]!;
      if (!cone.flying && !cone.down) {
        // Hit test against the car's footprint, in the car's frame.
        this.local.set(cone.pos.x - car.pos.x, cone.pos.y - car.pos.y, cone.pos.z - car.pos.z);
        if (this.local.lengthSq() < 16) {
          this.local.applyQuaternion(this.inverse);
          const b = this.body;
          if (
            Math.abs(this.local.x) < b.halfWidth + CONE_RADIUS &&
            this.local.z > -b.front - CONE_RADIUS &&
            this.local.z < b.rear + CONE_RADIUS &&
            this.local.y < b.roof
          ) {
            this.knock(cone, car);
          }
        }
        continue;
      }
      changed = true;
      if (cone.flying) this.fly(cone, dt);
      else {
        cone.timer += dt;
        if (cone.timer > RESPAWN_AFTER) {
          cone.pos.copy(cone.home);
          cone.rot.identity();
          cone.down = false;
        }
      }
      this.write(i);
    }
    if (changed) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private knock(cone: Cone, car: CarRenderState): void {
    const r = this.rand;
    const side = Math.sign(this.local.x) || 1;
    // Mostly carried along with the car, pushed out sideways and popped up a little.
    const push = new THREE.Vector3(side * (1.5 + r() * 2.5), 0, 0).applyQuaternion(this.carQuat);
    cone.vel.set(car.vel.x * (0.9 + r() * 0.3), 1.5 + r() * 3, car.vel.z * (0.9 + r() * 0.3));
    cone.vel.add(push);
    cone.spin
      .set(r() - 0.5, r() - 0.5, r() - 0.5)
      .normalize()
      .multiplyScalar(6 + r() * 10);
    cone.flying = true;
    cone.timer = 0;
  }

  private fly(cone: Cone, dt: number): void {
    cone.vel.y -= GRAVITY * dt;
    cone.pos.addScaledVector(cone.vel, dt);
    const angle = cone.spin.length() * dt;
    if (angle > 0) {
      this.axis.copy(cone.spin).normalize();
      this.tmpQ.setFromAxisAngle(this.axis, angle);
      cone.rot.premultiply(this.tmpQ);
    }
    if (cone.pos.y <= 0) {
      cone.pos.y = 0;
      if (cone.vel.y < -1) {
        cone.vel.y *= -0.3;
        cone.vel.x *= 0.7;
        cone.vel.z *= 0.7;
        cone.spin.multiplyScalar(0.6);
      } else {
        cone.vel.set(0, 0, 0);
        // Lie down on its side, pointing the way it was travelling.
        const yaw = this.rand() * Math.PI * 2;
        cone.rot.setFromEuler(new THREE.Euler(Math.PI / 2 - 0.36, yaw, 0, 'YXZ'));
        cone.pos.y = 0.14;
        cone.flying = false;
        cone.down = true;
      }
    }
    cone.timer += dt;
    if (cone.timer > RESPAWN_AFTER) {
      cone.flying = false;
      cone.down = true;
    }
  }

  private write(i: number): void {
    const cone = this.cones[i]!;
    this.matrix.compose(cone.pos, cone.rot, this.one);
    this.mesh.setMatrixAt(i, this.matrix);
  }
}

/** Orange cone with a white reflective band on a square base, origin at the bottom. */
function coneGeometry(): THREE.BufferGeometry {
  const base = new THREE.BoxGeometry(0.4, 0.04, 0.4).translate(0, 0.02, 0);
  const lower = new THREE.CylinderGeometry(0.1, CONE_RADIUS - 0.03, 0.26, 16, 1, true).translate(
    0,
    0.17,
    0,
  );
  const band = new THREE.CylinderGeometry(0.075, 0.1, 0.1, 16, 1, true).translate(0, 0.35, 0);
  const top = new THREE.CylinderGeometry(0.02, 0.075, 0.18, 16, 1).translate(0, 0.49, 0);
  const paint = (g: THREE.BufferGeometry, color: number) => {
    const c = new THREE.Color(color);
    const count = g.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return g.index ? g.toNonIndexed() : g;
  };
  const merged = mergeGeometries([
    paint(base, 0x222222),
    paint(lower, 0xff5a0a),
    paint(band, 0xf0f0f0),
    paint(top, 0xff5a0a),
  ]);
  if (!merged) throw new Error('Could not build the cone geometry');
  return merged;
}
