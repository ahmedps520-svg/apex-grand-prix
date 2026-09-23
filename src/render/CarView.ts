import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as THREE from 'three/webgpu';
import type { AxleSpec, CarSpec } from '../sim/vehicle/spec';
import type { CarRenderState } from './interpolate';

interface WheelView {
  /** Positioned at the wheel centre; rotates for steering. */
  pivot: THREE.Group;
  /** Child of the pivot; rotates as the wheel rolls. */
  spinner: THREE.Group;
  hardpointY: number;
}

/**
 * Placeholder car model (Round 1): rounded boxes and cylinders arranged from the physics spec,
 * so wheels sit exactly where the simulation puts them. The real car-body generator arrives in
 * Round 6.
 */
export class CarView {
  readonly root = new THREE.Group();
  private readonly wheels: WheelView[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];

  constructor(spec: CarSpec, paint = 0xa3101f) {
    const body = spec.body;
    const mat = {
      paint: this.material(
        new THREE.MeshPhysicalMaterial({
          color: paint,
          roughness: 0.45,
          metalness: 0.05,
          clearcoat: 0.35,
          clearcoatRoughness: 0.15,
        }),
      ),
      stripe: this.material(
        new THREE.MeshPhysicalMaterial({ color: 0xf2f2f2, roughness: 0.35, clearcoat: 1 }),
      ),
      glass: this.material(
        new THREE.MeshPhysicalMaterial({ color: 0x0d141c, roughness: 0.08, metalness: 0.3 }),
      ),
      carbon: this.material(new THREE.MeshStandardMaterial({ color: 0x1b1d20, roughness: 0.55 })),
      tyre: this.material(new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.92 })),
      rim: this.material(
        new THREE.MeshStandardMaterial({ color: 0x9aa1a8, roughness: 0.3, metalness: 0.9 }),
      ),
      caliper: this.material(new THREE.MeshStandardMaterial({ color: 0xe0b020, roughness: 0.4 })),
      head: this.material(
        new THREE.MeshStandardMaterial({
          color: 0xffffff,
          emissive: 0xfff4de,
          emissiveIntensity: 2,
        }),
      ),
      tail: this.material(
        new THREE.MeshStandardMaterial({
          color: 0x550000,
          emissive: 0xff1a1a,
          emissiveIntensity: 1.5,
        }),
      ),
    };

    const length = body.front + body.rear;
    const centreZ = (body.rear - body.front) / 2;
    // Race-car silhouette: a narrow tub between the wheels, full-width bodywork above it whose
    // fenders cover the tops of the tyres, and a glasshouse on top.
    const wheelCentreY = spec.front.wheelRadius - spec.cogHeight;
    const tubTop = wheelCentreY + 0.06;
    const tubBottom = body.floor + 0.03;
    const tubWidth = 2 * (Math.min(spec.front.halfTrack, spec.rear.halfTrack) - 0.17);
    const tub = this.box(tubWidth, tubTop - tubBottom, length - 0.3, 0.08, mat.paint);
    tub.position.set(0, (tubTop + tubBottom) / 2, centreZ);

    const upperBottom = wheelCentreY + 0.02;
    const upperTop = spec.front.wheelRadius * 2 - spec.cogHeight + 0.05;
    const upper = this.box(body.halfWidth * 2, upperTop - upperBottom, length, 0.12, mat.paint);
    upper.position.set(0, (upperTop + upperBottom) / 2, centreZ);

    const cabinHeight = 0.46;
    const cabin = this.box(body.halfWidth * 1.5, cabinHeight, length * 0.4, 0.17, mat.glass);
    cabin.position.set(0, upperTop + cabinHeight / 2 - 0.03, centreZ + 0.3);

    const roofStripe = this.box(0.34, 0.02, length * 0.36, 0.01, mat.stripe);
    roofStripe.position.set(0, upperTop + cabinHeight - 0.025, centreZ + 0.3);
    const hoodStripe = this.box(0.34, 0.02, body.front - 0.95, 0.01, mat.stripe);
    hoodStripe.position.set(0, upperTop + 0.005, -body.front / 2 - 0.4);

    const splitter = this.box(body.halfWidth * 1.9, 0.04, 0.34, 0.01, mat.carbon);
    splitter.position.set(0, tubBottom + 0.01, -body.front + 0.12);

    const wingY = upperTop + 0.36;
    const wing = this.box(body.halfWidth * 1.85, 0.05, 0.36, 0.02, mat.carbon);
    wing.position.set(0, wingY, body.rear - 0.25);
    const strutGeo = this.geometry(new THREE.BoxGeometry(0.05, 0.36, 0.18));
    for (const side of [-1, 1]) {
      const strut = new THREE.Mesh(strutGeo, mat.carbon);
      strut.position.set(side * 0.55, wingY - 0.18, body.rear - 0.25);
      this.root.add(strut);
    }

    const lightGeo = this.geometry(new THREE.BoxGeometry(0.34, 0.09, 0.04));
    const lightY = (upperTop + upperBottom) / 2;
    for (const side of [-1, 1]) {
      const head = new THREE.Mesh(lightGeo, mat.head);
      head.position.set(side * (body.halfWidth - 0.32), lightY, -body.front - 0.005);
      const tail = new THREE.Mesh(lightGeo, mat.tail);
      tail.position.set(side * (body.halfWidth - 0.3), lightY + 0.04, body.rear + 0.005);
      this.root.add(head, tail);
    }

    this.root.add(tub, upper, cabin, roofStripe, hoodStripe, splitter, wing);

    this.addAxle(spec, spec.front, mat.tyre, mat.rim, mat.caliper);
    this.addAxle(spec, spec.rear, mat.tyre, mat.rim, mat.caliper);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  update(state: CarRenderState): void {
    this.root.position.set(state.pos.x, state.pos.y, state.pos.z);
    this.root.quaternion.set(state.rot.x, state.rot.y, state.rot.z, state.rot.w);
    for (let i = 0; i < this.wheels.length; i++) {
      const view = this.wheels[i]!;
      const wheel = state.wheels[i]!;
      view.pivot.position.y = view.hardpointY - wheel.length;
      view.pivot.rotation.y = -wheel.steer;
      view.spinner.rotation.x = -wheel.spin;
    }
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private addAxle(
    spec: CarSpec,
    axle: AxleSpec,
    tyreMat: THREE.Material,
    rimMat: THREE.Material,
    caliperMat: THREE.Material,
  ): void {
    const r = axle.wheelRadius;
    const width = 0.3;
    const tyreGeo = this.geometry(new THREE.CylinderGeometry(r, r, width, 28).rotateZ(Math.PI / 2));
    const rimGeo = this.geometry(
      new THREE.CylinderGeometry(r * 0.68, r * 0.68, width + 0.01, 20).rotateZ(Math.PI / 2),
    );
    const spokeGeo = this.geometry(new THREE.BoxGeometry(0.03, r * 1.28, 0.06));
    const caliperGeo = this.geometry(new THREE.BoxGeometry(0.08, 0.16, 0.12));
    const hardpointY = r - spec.cogHeight + axle.staticLength;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(side * axle.halfTrack, hardpointY - axle.staticLength, -axle.offset);
      const spinner = new THREE.Group();
      spinner.add(new THREE.Mesh(tyreGeo, tyreMat), new THREE.Mesh(rimGeo, rimMat));
      // Five spokes on the outer face make rotation visible.
      for (let s = 0; s < 5; s++) {
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        spoke.position.x = side * (width / 2 + 0.012);
        spoke.rotation.x = (s / 5) * Math.PI;
        spinner.add(spoke);
      }
      const caliper = new THREE.Mesh(caliperGeo, caliperMat);
      caliper.position.set(side * (width / 2 - 0.06), r * 0.42, r * 0.22);
      pivot.add(spinner, caliper);
      this.root.add(pivot);
      this.wheels.push({ pivot, spinner, hardpointY });
    }
  }

  private box(
    w: number,
    h: number,
    d: number,
    radius: number,
    material: THREE.Material,
  ): THREE.Mesh {
    const geo = this.geometry(new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, h / 2 - 0.001)));
    return new THREE.Mesh(geo, material);
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private material<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
