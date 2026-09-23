import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../shared/math';
import { PED_CROSSING, PED_LEAPING, PED_STRIDE, PED_WALKING } from '../shared/protocol';

/**
 * The pedestrians: one instanced figure (legs, torso, arms) in clothes coloured per person,
 * with a head in its own skin tone, placed from the sim's block after the cars each frame.
 * Walking bobs the figure and swings it a little; a leap lifts it.
 */

const CLOTHES = [
  0x2b3a67, 0x8c2f39, 0x3b6e4a, 0x1f1f23, 0xd9a441, 0x5a4b81, 0xb8b2a7, 0x2e7d8f, 0xc75b39,
  0x4a4e69, 0xe0e0e0, 0x6b3f2a,
];
const SKINS = [0xf1c9a5, 0xd9a577, 0xb07b4f, 0x8d5a3a, 0x5c3a24, 0xf3d6bd];

export class PedestrianView {
  readonly root = new THREE.Group();
  private readonly bodies: THREE.InstancedMesh | null;
  private readonly heads: THREE.InstancedMesh | null;
  private readonly bodyGeo: THREE.BufferGeometry;
  private readonly headGeo: THREE.BufferGeometry;
  private readonly cloth = new THREE.MeshStandardMaterial({ roughness: 0.85 });
  private readonly skin = new THREE.MeshStandardMaterial({ roughness: 0.6 });
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly axis = new THREE.Vector3(0, 1, 0);
  private readonly lean = new THREE.Quaternion();
  private readonly leanAxis = new THREE.Vector3(0, 0, 1);

  constructor(readonly count: number) {
    // Legs, torso and arms as boxes, feet on the ground.
    const leg = (x: number) => new THREE.BoxGeometry(0.15, 0.82, 0.18).translate(x, 0.41, 0);
    const torso = new THREE.BoxGeometry(0.42, 0.6, 0.24).translate(0, 1.12, 0);
    const arm = (x: number) => new THREE.BoxGeometry(0.11, 0.56, 0.13).translate(x, 1.1, 0);
    const neck = new THREE.BoxGeometry(0.12, 0.08, 0.12).translate(0, 1.46, 0);
    this.bodyGeo = mergeGeometries([leg(-0.11), leg(0.11), torso, arm(-0.28), arm(0.28), neck]);
    this.headGeo = new THREE.SphereGeometry(0.12, 10, 8).translate(0, 1.62, 0);
    if (count > 0) {
      this.bodies = new THREE.InstancedMesh(this.bodyGeo, this.cloth, count);
      this.heads = new THREE.InstancedMesh(this.headGeo, this.skin, count);
      const rand = mulberry32(0x9ed);
      const colour = new THREE.Color();
      for (let i = 0; i < count; i++) {
        colour.setHex(CLOTHES[Math.floor(rand() * CLOTHES.length)]!);
        this.bodies.setColorAt(i, colour);
        colour.setHex(SKINS[Math.floor(rand() * SKINS.length)]!);
        this.heads.setColorAt(i, colour);
        this.matrix.makeTranslation(1e5, -100, 1e5);
        this.bodies.setMatrixAt(i, this.matrix);
        this.heads.setMatrixAt(i, this.matrix);
      }
      for (const mesh of [this.bodies, this.heads]) {
        mesh.castShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        this.root.add(mesh);
      }
    } else {
      this.bodies = null;
      this.heads = null;
    }
  }

  /** Places every figure from the block at `base` in the snapshot view. */
  update(view: Float32Array, base: number, time: number): void {
    const bodies = this.bodies;
    const heads = this.heads;
    if (!bodies || !heads) return;
    for (let i = 0; i < this.count; i++) {
      const o = base + i * PED_STRIDE;
      const state = view[o + 4]!;
      if (state < 0) {
        this.matrix.makeTranslation(1e5, -100, 1e5);
      } else {
        const walking = state === PED_WALKING || state === PED_CROSSING;
        const phase = time * (state === PED_CROSSING ? 9 : 7.5) + i * 1.7;
        const bob = walking ? 0.035 * Math.abs(Math.sin(phase)) : 0;
        const lift = state === PED_LEAPING ? 0.3 : 0;
        this.position.set(view[o]!, view[o + 1]! + bob + lift, view[o + 2]!);
        this.quaternion.setFromAxisAngle(this.axis, view[o + 3]!);
        // A little sway while walking, a lean into the leap.
        const sway = walking ? 0.06 * Math.sin(phase) : state === PED_LEAPING ? 0.25 : 0;
        this.lean.setFromAxisAngle(this.leanAxis, sway);
        this.quaternion.multiply(this.lean);
        this.matrix.compose(this.position, this.quaternion, this.scale);
      }
      bodies.setMatrixAt(i, this.matrix);
      heads.setMatrixAt(i, this.matrix);
    }
    bodies.instanceMatrix.needsUpdate = true;
    heads.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.root.removeFromParent();
    this.bodyGeo.dispose();
    this.headGeo.dispose();
    this.cloth.dispose();
    this.skin.dispose();
  }
}
