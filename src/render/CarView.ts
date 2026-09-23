import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as THREE from 'three/webgpu';
import type { CarStyle } from '../sim/vehicle/cars';
import type { AxleSpec, CarSpec } from '../sim/vehicle/spec';
import type { CarRenderState } from './interpolate';

interface WheelView {
  /** Positioned at the wheel centre; rotates for steering. */
  pivot: THREE.Group;
  /** Child of the pivot; rotates as the wheel rolls. */
  spinner: THREE.Group;
  hardpointY: number;
}

type Materials = Record<
  'paint' | 'stripe' | 'glass' | 'carbon' | 'tyre' | 'rim' | 'caliper' | 'head' | 'tail',
  THREE.Material
>;

/** Proportions of the closed-cockpit body styles. */
const CLOSED_LOOKS: Record<
  Exclude<CarStyle, 'formula'>,
  {
    bodyRise: number;
    round: number;
    cabinHeight: number;
    cabinLength: number;
    cabinWidth: number;
    cabinOffset: number;
    wing: number;
    splitter: boolean;
  }
> = {
  gt: {
    bodyRise: 0.05,
    round: 0.12,
    cabinHeight: 0.46,
    cabinLength: 0.4,
    cabinWidth: 1.5,
    cabinOffset: 0.3,
    wing: 0.36,
    splitter: true,
  },
  prototype: {
    bodyRise: -0.02,
    round: 0.16,
    cabinHeight: 0.36,
    cabinLength: 0.34,
    cabinWidth: 1.1,
    cabinOffset: -0.2,
    wing: 0.22,
    splitter: true,
  },
  touring: {
    bodyRise: 0.08,
    round: 0.08,
    cabinHeight: 0.55,
    cabinLength: 0.46,
    cabinWidth: 1.6,
    cabinOffset: 0.2,
    wing: 0.18,
    splitter: true,
  },
  street: {
    bodyRise: 0.1,
    round: 0.18,
    cabinHeight: 0.5,
    cabinLength: 0.44,
    cabinWidth: 1.55,
    cabinOffset: 0.15,
    wing: 0,
    splitter: false,
  },
};

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
  private readonly paint: THREE.MeshPhysicalMaterial;
  private readonly stripe: THREE.MeshPhysicalMaterial;

  constructor(spec: CarSpec, paint = 0xa3101f, style: CarStyle = 'gt') {
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

    this.paint = mat.paint as THREE.MeshPhysicalMaterial;
    this.stripe = mat.stripe as THREE.MeshPhysicalMaterial;
    this.setPaint(paint);

    if (style === 'formula') this.buildFormula(spec, mat);
    else this.buildClosed(spec, mat, style);

    this.addAxle(spec, spec.front, mat.tyre, mat.rim, mat.caliper);
    this.addAxle(spec, spec.rear, mat.tyre, mat.rim, mat.caliper);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Body colour; the stripes switch to dark on light paints. */
  setPaint(hex: number): void {
    this.paint.color.setHex(hex);
    const r = (hex >> 16) & 255;
    const g = (hex >> 8) & 255;
    const b = hex & 255;
    const light = 0.2126 * r + 0.7152 * g + 0.0722 * b > 150;
    this.stripe.color.setHex(light ? 0x1c1c1c : 0xf2f2f2);
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

  /**
   * Closed-cockpit cars (GT, prototype, touring, street): a narrow tub between the wheels,
   * full-width bodywork above it whose fenders cover the tops of the tyres, and a glasshouse.
   * The style changes the proportions, the wing and the splitter.
   */
  private buildClosed(spec: CarSpec, mat: Materials, style: CarStyle): void {
    const body = spec.body;
    const length = body.front + body.rear;
    const centreZ = (body.rear - body.front) / 2;
    const look = CLOSED_LOOKS[style === 'formula' ? 'gt' : style];
    const wheelCentreY = spec.front.wheelRadius - spec.cogHeight;
    const tubTop = wheelCentreY + 0.06;
    const tubBottom = body.floor + 0.03;
    const tubWidth = 2 * (Math.min(spec.front.halfTrack, spec.rear.halfTrack) - 0.17);
    const tub = this.box(tubWidth, tubTop - tubBottom, length - 0.3, 0.08, mat.paint);
    tub.position.set(0, (tubTop + tubBottom) / 2, centreZ);

    const upperBottom = wheelCentreY + 0.02;
    const upperTop = spec.front.wheelRadius * 2 - spec.cogHeight + look.bodyRise;
    const upper = this.box(
      body.halfWidth * 2,
      upperTop - upperBottom,
      length,
      look.round,
      mat.paint,
    );
    upper.position.set(0, (upperTop + upperBottom) / 2, centreZ);

    const cabinHeight = look.cabinHeight;
    const cabinLength = length * look.cabinLength;
    const cabin = this.box(
      body.halfWidth * look.cabinWidth,
      cabinHeight,
      cabinLength,
      0.17,
      mat.glass,
    );
    cabin.position.set(0, upperTop + cabinHeight / 2 - 0.03, centreZ + look.cabinOffset);

    const roofStripe = this.box(0.34, 0.02, cabinLength * 0.9, 0.01, mat.stripe);
    roofStripe.position.set(0, upperTop + cabinHeight - 0.025, centreZ + look.cabinOffset);
    const hoodStripe = this.box(0.34, 0.02, body.front - 0.95, 0.01, mat.stripe);
    hoodStripe.position.set(0, upperTop + 0.005, -body.front / 2 - 0.4);
    this.root.add(tub, upper, cabin, roofStripe, hoodStripe);

    if (look.splitter) {
      const splitter = this.box(body.halfWidth * 1.9, 0.04, 0.34, 0.01, mat.carbon);
      splitter.position.set(0, tubBottom + 0.01, -body.front + 0.12);
      this.root.add(splitter);
    }
    if (look.wing > 0) {
      const wingY = upperTop + look.wing;
      const wing = this.box(body.halfWidth * 1.85, 0.05, 0.36, 0.02, mat.carbon);
      wing.position.set(0, wingY, body.rear - 0.25);
      const strutGeo = this.geometry(new THREE.BoxGeometry(0.05, look.wing, 0.18));
      for (const side of [-1, 1]) {
        const strut = new THREE.Mesh(strutGeo, mat.carbon);
        strut.position.set(side * 0.55, wingY - look.wing / 2, body.rear - 0.25);
        this.root.add(strut);
      }
      this.root.add(wing);
    } else {
      // A small lip spoiler on the boot.
      const lip = this.box(body.halfWidth * 1.6, 0.05, 0.14, 0.02, mat.paint);
      lip.position.set(0, upperTop + 0.03, body.rear - 0.1);
      this.root.add(lip);
    }
    if (style === 'prototype') {
      // Shark fin along the engine cover.
      const fin = this.box(0.04, 0.34, body.rear * 0.9, 0.01, mat.paint);
      fin.position.set(0, upperTop + 0.17, body.rear * 0.45);
      this.root.add(fin);
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
  }

  /** Open-wheel single-seater: nose, monocoque, sidepods, halo, airbox and two wings. */
  private buildFormula(spec: CarSpec, mat: Materials): void {
    const body = spec.body;
    const floorY = body.floor + 0.05;
    const tubHeight = 0.42;
    const tubY = floorY + tubHeight / 2;
    // Monocoque from just behind the front axle to the gearbox.
    const tubStart = -spec.front.offset + 0.35;
    const tubEnd = -spec.rear.offset + 0.3;
    const tub = this.box(0.72, tubHeight, tubEnd - tubStart, 0.12, mat.paint);
    tub.position.set(0, tubY, (tubStart + tubEnd) / 2);
    // Nose, tapering down to the front wing.
    const nose = this.box(0.34, 0.24, body.front - spec.front.offset + 0.5, 0.1, mat.paint);
    nose.position.set(0, floorY + 0.2, -body.front + (body.front - spec.front.offset + 0.5) / 2);
    // Sidepods between the axles.
    const podLength = spec.front.offset + -spec.rear.offset - 1.6;
    for (const side of [-1, 1]) {
      const pod = this.box(0.34, 0.3, podLength, 0.1, mat.paint);
      pod.position.set(side * 0.55, floorY + 0.17, 0.35);
      this.root.add(pod);
    }
    // Cockpit opening and halo.
    const cockpit = this.box(0.5, 0.08, 0.9, 0.04, mat.glass);
    cockpit.position.set(0, tubY + tubHeight / 2, -0.35);
    const haloTop = this.box(0.06, 0.05, 0.7, 0.02, mat.carbon);
    haloTop.position.set(0, tubY + tubHeight / 2 + 0.22, -0.4);
    const haloPost = this.box(0.06, 0.24, 0.05, 0.02, mat.carbon);
    haloPost.position.set(0, tubY + tubHeight / 2 + 0.1, -0.75);
    // Airbox and engine cover.
    const airbox = this.box(0.34, 0.36, 1.3, 0.1, mat.paint);
    airbox.position.set(0, tubY + tubHeight / 2 + 0.12, 0.55);
    // Wings.
    const frontWing = this.box(body.halfWidth * 1.95, 0.04, 0.45, 0.01, mat.carbon);
    frontWing.position.set(0, floorY + 0.02, -body.front + 0.25);
    const rearWingY = tubY + 0.62;
    const rearWing = this.box(1.0, 0.06, 0.34, 0.02, mat.carbon);
    rearWing.position.set(0, rearWingY, body.rear - 0.2);
    const plateGeo = this.geometry(new THREE.BoxGeometry(0.03, 0.5, 0.6));
    for (const side of [-1, 1]) {
      const plate = new THREE.Mesh(plateGeo, mat.carbon);
      plate.position.set(side * 0.5, rearWingY - 0.18, body.rear - 0.25);
      this.root.add(plate);
    }
    const stripe = this.box(0.12, 0.02, body.front - 0.3, 0.01, mat.stripe);
    stripe.position.set(0, floorY + 0.33, -body.front / 2);
    const tailLight = new THREE.Mesh(
      this.geometry(new THREE.BoxGeometry(0.2, 0.08, 0.04)),
      mat.tail,
    );
    tailLight.position.set(0, floorY + 0.3, body.rear + 0.02);
    this.root.add(
      tub,
      nose,
      cockpit,
      haloTop,
      haloPost,
      airbox,
      frontWing,
      rearWing,
      stripe,
      tailLight,
    );
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
