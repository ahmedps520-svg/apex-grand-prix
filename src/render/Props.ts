import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import {
  PROP_SPECS,
  type PropKind,
  type PropPlacement,
  type PropSpec,
} from '../content/city/props';
import { mulberry32 } from '../shared/math';
import type { BodySpec } from '../sim/vehicle/spec';
import { coneGeometry, paint } from './Cones';
import type { CarRenderState } from './interpolate';

const GRAVITY = 9.81;
const RESPAWN_AFTER = 7;

interface Prop {
  spec: PropSpec;
  /** Which instanced mesh, and the instance in it. */
  mesh: THREE.InstancedMesh;
  index: number;
  home: THREE.Vector3;
  homeRot: THREE.Quaternion;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  rot: THREE.Quaternion;
  spin: THREE.Vector3;
  flying: boolean;
  down: boolean;
  timer: number;
}

/**
 * The festival's smashable street props: cones, bins, bollards, crates and fence panels the
 * car sends flying (they don't push back on it). One instanced mesh per kind, so the lot costs
 * a handful of draw calls; a knocked prop flies with the car's speed, less for the heavier
 * kinds, tumbles, comes to rest on its side and is back on its spot a few seconds later.
 */
export class Props {
  readonly root = new THREE.Group();
  /** Called for each prop the car sends flying (skill points, a sound). */
  onKnock: ((kind: PropKind) => void) | null = null;
  private readonly props: Prop[] = [];
  private readonly meshes = new Map<PropKind, THREE.InstancedMesh>();
  private readonly rand = mulberry32(99);
  private readonly matrix = new THREE.Matrix4();
  private readonly one = new THREE.Vector3(1, 1, 1);
  private readonly local = new THREE.Vector3();
  private readonly carQuat = new THREE.Quaternion();
  private readonly inverse = new THREE.Quaternion();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly euler = new THREE.Euler();

  constructor(
    placements: readonly PropPlacement[],
    private readonly body: BodySpec,
  ) {
    const counts = new Map<PropKind, number>();
    for (const p of placements) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
    for (const [kind, count] of counts) {
      const mesh = new THREE.InstancedMesh(
        propGeometry(kind),
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65 }),
        count,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.count = 0;
      this.meshes.set(kind, mesh);
      this.root.add(mesh);
    }
    for (const p of placements) {
      const mesh = this.meshes.get(p.kind)!;
      const homeRot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.yaw);
      this.props.push({
        spec: PROP_SPECS[p.kind],
        mesh,
        index: mesh.count++,
        home: new THREE.Vector3(p.x, p.y, p.z),
        homeRot,
        pos: new THREE.Vector3(p.x, p.y, p.z),
        vel: new THREE.Vector3(),
        rot: homeRot.clone(),
        spin: new THREE.Vector3(),
        flying: false,
        down: false,
        timer: 0,
      });
    }
    this.props.forEach((p) => this.write(p));
    for (const mesh of this.meshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  get count(): number {
    return this.props.length;
  }

  /** How many are flying or lying knocked over. */
  get knocked(): number {
    let n = 0;
    for (const p of this.props) if (p.flying || p.down) n++;
    return n;
  }

  /** The nearest prop still standing, for the checks. */
  nearest(x: number, z: number): { kind: PropKind; x: number; z: number } | null {
    let best: Prop | null = null;
    let bestD = Infinity;
    for (const p of this.props) {
      if (p.flying || p.down) continue;
      const d = (p.pos.x - x) ** 2 + (p.pos.z - z) ** 2;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best ? { kind: kindOf(best.spec), x: best.pos.x, z: best.pos.z } : null;
  }

  update(dt: number, car: CarRenderState): void {
    this.carQuat.set(car.rot.x, car.rot.y, car.rot.z, car.rot.w);
    this.inverse.copy(this.carQuat).invert();
    const changed = new Set<THREE.InstancedMesh>();
    const b = this.body;
    for (const prop of this.props) {
      if (!prop.flying && !prop.down) {
        // Hit test against the car's footprint, in the car's frame.
        this.local.set(prop.pos.x - car.pos.x, prop.pos.y - car.pos.y, prop.pos.z - car.pos.z);
        const reach = 3 + prop.spec.radius;
        if (this.local.lengthSq() < reach * reach) {
          this.local.applyQuaternion(this.inverse);
          const r = prop.spec.radius;
          if (
            Math.abs(this.local.x) < b.halfWidth + r &&
            this.local.z > -b.front - r &&
            this.local.z < b.rear + r &&
            this.local.y < b.roof &&
            this.local.y > -prop.spec.height
          ) {
            this.knock(prop, car);
            changed.add(prop.mesh);
            this.write(prop);
          }
        }
        continue;
      }
      changed.add(prop.mesh);
      if (prop.flying) this.fly(prop, dt);
      else {
        prop.timer += dt;
        if (prop.timer > RESPAWN_AFTER) {
          prop.pos.copy(prop.home);
          prop.rot.copy(prop.homeRot);
          prop.down = false;
        }
      }
      this.write(prop);
    }
    for (const mesh of changed) mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const mesh of this.meshes.values()) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
  }

  private knock(prop: Prop, car: CarRenderState): void {
    const r = this.rand;
    const heft = prop.spec.heft;
    const side = Math.sign(this.local.x) || 1;
    // Mostly carried along with the car, pushed out sideways and popped up: the heavier
    // the prop, the less of the car's speed it takes and the lower it goes.
    const carry = (0.9 + r() * 0.3) / Math.sqrt(heft);
    const push = new THREE.Vector3(side * (1.5 + r() * 2.5), 0, 0).applyQuaternion(this.carQuat);
    prop.vel.set(car.vel.x * carry, (1.5 + r() * 3) / Math.sqrt(heft), car.vel.z * carry);
    prop.vel.add(push);
    prop.spin
      .set(r() - 0.5, r() - 0.5, r() - 0.5)
      .normalize()
      .multiplyScalar((6 + r() * 10) / heft);
    prop.flying = true;
    prop.timer = 0;
    this.onKnock?.(kindOf(prop.spec));
  }

  private fly(prop: Prop, dt: number): void {
    prop.vel.y -= GRAVITY * dt;
    prop.pos.addScaledVector(prop.vel, dt);
    const angle = prop.spin.length() * dt;
    if (angle > 0) {
      this.axis.copy(prop.spin).normalize();
      this.tmpQ.setFromAxisAngle(this.axis, angle);
      prop.rot.premultiply(this.tmpQ);
    }
    const ground = prop.home.y;
    if (prop.pos.y <= ground) {
      prop.pos.y = ground;
      if (prop.vel.y < -1) {
        prop.vel.y *= -0.3;
        prop.vel.x *= 0.7;
        prop.vel.z *= 0.7;
        prop.spin.multiplyScalar(0.6);
      } else {
        prop.vel.set(0, 0, 0);
        // On its side, pointing any way.
        const yaw = this.rand() * Math.PI * 2;
        this.euler.set(Math.PI / 2 - 0.3, yaw, 0, 'YXZ');
        prop.rot.setFromEuler(this.euler);
        prop.pos.y = ground + prop.spec.radius * 0.6;
        prop.flying = false;
        prop.down = true;
      }
    }
    prop.timer += dt;
    if (prop.timer > RESPAWN_AFTER) {
      prop.flying = false;
      prop.down = true;
    }
  }

  private write(prop: Prop): void {
    this.matrix.compose(prop.pos, prop.rot, this.one);
    prop.mesh.setMatrixAt(prop.index, this.matrix);
  }
}

function kindOf(spec: PropSpec): PropKind {
  for (const kind of Object.keys(PROP_SPECS) as PropKind[]) {
    if (PROP_SPECS[kind] === spec) return kind;
  }
  return 'cone';
}

/** Each kind's shape in flat colours, origin at the bottom. */
function propGeometry(kind: PropKind): THREE.BufferGeometry {
  if (kind === 'cone') return coneGeometry();
  const parts: THREE.BufferGeometry[] = [];
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) =>
    parts.push(paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color));
  const tube = (r0: number, r1: number, h: number, y: number, color: number, segments = 14) =>
    parts.push(paint(new THREE.CylinderGeometry(r0, r1, h, segments).translate(0, y, 0), color));
  switch (kind) {
    case 'bin':
      tube(0.3, 0.27, 0.86, 0.43, 0x2f5d3a);
      tube(0.34, 0.34, 0.08, 0.9, 0x1f3d27);
      tube(0.12, 0.12, 0.06, 0.97, 0x1f3d27, 8);
      break;
    case 'bollard':
      tube(0.09, 0.1, 0.84, 0.42, 0x1c1c1c, 10);
      tube(0.095, 0.095, 0.09, 0.66, 0xe8e8e8, 10);
      parts.push(paint(new THREE.SphereGeometry(0.1, 10, 8).translate(0, 0.86, 0), 0x1c1c1c));
      break;
    case 'crate':
      box(0.7, 0.6, 0.7, 0, 0.3, 0, 0xb8894a);
      box(0.72, 0.08, 0.72, 0, 0.12, 0, 0x8a6431);
      box(0.72, 0.08, 0.72, 0, 0.5, 0, 0x8a6431);
      break;
    case 'fence':
      box(0.08, 1.0, 0.08, -0.86, 0.5, 0, 0x777c82);
      box(0.08, 1.0, 0.08, 0.86, 0.5, 0, 0x777c82);
      box(1.8, 0.5, 0.05, 0, 0.76, 0, 0x9aa1a8);
      box(1.8, 0.08, 0.05, 0, 0.3, 0, 0x9aa1a8);
      break;
  }
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error(`Could not build the ${kind} geometry`);
  return merged;
}
