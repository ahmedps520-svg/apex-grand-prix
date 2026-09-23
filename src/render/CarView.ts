import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { defaultLivery, type Livery } from '../content/livery';
import type { CarStyle } from '../sim/vehicle/cars';
import type { AxleSpec, CarSpec } from '../sim/vehicle/spec';
import type { CarRenderState } from './interpolate';
import { LiveryMaterial, type LiveryLayout } from './liveryMaterial';

interface WheelView {
  /** Positioned at the wheel centre; rotates for steering. */
  pivot: THREE.Group;
  /** Child of the pivot; rotates as the wheel rolls. */
  spinner: THREE.Group;
  hardpointY: number;
}

/** Materials of the static body parts; each becomes one merged mesh (one draw call). */
type Part = 'paint' | 'glass' | 'carbon' | 'head' | 'tail';

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

/** Rounding of the glasshouse's edges. */
const CABIN_ROUND = 0.17;
const TYRE_WIDTH = 0.3;
/** The spokes stand this far out from the tyre's sidewall, so the wheel is seen to turn. */
const SPOKE_OFFSET = 0.012;
const SPOKE_THICKNESS = 0.03;
/** From a wheel's centre to the outer face of its spokes. */
const WHEEL_OUTER = TYRE_WIDTH / 2 + SPOKE_OFFSET + SPOKE_THICKNESS / 2;

/**
 * Placeholder car model (Round 1): rounded boxes and cylinders arranged from the physics spec,
 * so wheels sit exactly where the simulation puts them. The real car-body generator arrives in
 * Round 6.
 *
 * The static body is merged into one mesh per material, built in the car frame, so the livery
 * shader can place its patterns from the vertex positions; each wheel is three meshes. That keeps
 * a car at about 17 draw calls.
 */
export class CarView {
  readonly root = new THREE.Group();
  private readonly wheels: WheelView[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly parts: Record<Part, THREE.BufferGeometry[]> = {
    paint: [],
    glass: [],
    carbon: [],
    head: [],
    tail: [],
  };
  private readonly paint: LiveryMaterial;

  /** `livery` wins over `paint`; without one the car wears the default livery in `paint`. */
  constructor(spec: CarSpec, paint = 0xa3101f, style: CarStyle = 'gt', livery?: Livery) {
    const mat = {
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

    const layout = style === 'formula' ? this.buildFormula(spec) : this.buildClosed(spec, style);
    this.paint = new LiveryMaterial(layout, livery ?? { ...defaultLivery(), primary: paint });
    this.mergeParts({ ...mat, paint: this.paint.material });

    this.addAxle(spec, spec.front, mat.tyre, mat.rim, mat.caliper);
    this.addAxle(spec, spec.rear, mat.tyre, mat.rim, mat.caliper);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Repaints the car; only uniforms and the number texture change, nothing recompiles. */
  setLivery(livery: Livery): void {
    this.paint.set(livery);
  }

  /** Changes the livery's primary colour only. */
  setPaint(hex: number): void {
    this.paint.setPrimary(hex);
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
    this.paint.dispose();
  }

  /**
   * Closed-cockpit cars (GT, prototype, touring, street): a narrow tub between the wheels,
   * full-width bodywork above it whose fenders cover the tops of the tyres, and a glasshouse
   * with a painted roof. The style changes the proportions, the wing and the splitter.
   */
  private buildClosed(spec: CarSpec, style: CarStyle): LiveryLayout {
    const body = spec.body;
    const length = body.front + body.rear;
    const centreZ = (body.rear - body.front) / 2;
    const look = CLOSED_LOOKS[style === 'formula' ? 'gt' : style];
    const wheelCentreY = spec.front.wheelRadius - spec.cogHeight;
    const tubTop = wheelCentreY + 0.06;
    const tubBottom = body.floor + 0.03;
    const tubWidth = 2 * (Math.min(spec.front.halfTrack, spec.rear.halfTrack) - 0.17);
    this.box('paint', tubWidth, tubTop - tubBottom, length - 0.3, 0.08, [
      0,
      (tubTop + tubBottom) / 2,
      centreZ,
    ]);

    const upperBottom = wheelCentreY + 0.02;
    const upperTop = spec.front.wheelRadius * 2 - spec.cogHeight + look.bodyRise;
    // The fenders cover the tops of the wheels, spokes included.
    const halfWidth = Math.max(
      body.halfWidth,
      Math.max(spec.front.halfTrack, spec.rear.halfTrack) + WHEEL_OUTER + 0.008,
    );
    this.box('paint', halfWidth * 2, upperTop - upperBottom, length, look.round, [
      0,
      (upperTop + upperBottom) / 2,
      centreZ,
    ]);

    const cabinHeight = look.cabinHeight;
    const cabinLength = length * look.cabinLength;
    const cabinWidth = body.halfWidth * look.cabinWidth;
    const cabinZ = centreZ + look.cabinOffset;
    const cabinTop = upperTop + cabinHeight - 0.03;
    this.box('glass', cabinWidth, cabinHeight, cabinLength, CABIN_ROUND, [
      0,
      cabinTop - cabinHeight / 2,
      cabinZ,
    ]);
    // The roof: a painted panel over the glasshouse's flat top.
    const roofWidth = cabinWidth - 2 * CABIN_ROUND + 0.04;
    const roofLength = cabinLength - 2 * CABIN_ROUND;
    this.box('paint', roofWidth, 0.03, roofLength, 0.012, [0, cabinTop - 0.005, cabinZ]);

    if (look.splitter) {
      this.box('carbon', body.halfWidth * 1.9, 0.04, 0.34, 0.01, [
        0,
        tubBottom + 0.01,
        -body.front + 0.12,
      ]);
    }
    if (look.wing > 0) {
      const wingY = upperTop + look.wing;
      this.box('carbon', body.halfWidth * 1.85, 0.05, 0.36, 0.02, [0, wingY, body.rear - 0.25]);
      for (const side of [-1, 1]) {
        this.block('carbon', 0.05, look.wing, 0.18, [
          side * 0.55,
          wingY - look.wing / 2,
          body.rear - 0.25,
        ]);
      }
    } else {
      // A small lip spoiler on the boot.
      this.box('paint', body.halfWidth * 1.6, 0.05, 0.14, 0.02, [
        0,
        upperTop + 0.03,
        body.rear - 0.1,
      ]);
    }

    // The door number sits between the wheel arches; on the prototype it goes on the fin.
    let door: LiveryLayout['door'] = {
      z:
        (-spec.front.offset + spec.front.wheelRadius - spec.rear.offset - spec.rear.wheelRadius) /
        2,
      y: (upperTop + upperBottom) / 2,
      height: upperTop - upperBottom,
      minX: halfWidth - 0.12,
      maxX: halfWidth + 0.05,
    };
    if (style === 'prototype') {
      // Shark fin along the engine cover.
      const finHeight = 0.34;
      const finLength = body.rear * 0.9;
      const finZ = body.rear * 0.45;
      this.box('paint', 0.04, finHeight, finLength, 0.01, [0, upperTop + finHeight / 2, finZ]);
      door = {
        z: finZ + finLength * 0.08,
        y: upperTop + finHeight / 2,
        height: finHeight * 0.95,
        minX: 0.005,
        maxX: 0.05,
      };
    }

    const lightY = (upperTop + upperBottom) / 2;
    for (const side of [-1, 1]) {
      this.block('head', 0.34, 0.09, 0.04, [
        side * (halfWidth - 0.32),
        lightY,
        -body.front - 0.005,
      ]);
      this.block('tail', 0.34, 0.09, 0.04, [
        side * (halfWidth - 0.3),
        lightY + 0.04,
        body.rear + 0.005,
      ]);
    }

    return {
      front: body.front,
      rear: body.rear,
      waist: upperBottom + 0.72 * (upperTop - upperBottom),
      stripeGap: 0.05,
      stripeWidth: 0.23,
      split: door.z + 0.45,
      chevron: -body.front + 0.12 * length,
      hoops: [-body.front + 0.26 * length, body.rear - 0.2 * length],
      band: 0.36,
      door,
      top: { z: cabinZ, y: cabinTop + 0.01, size: Math.min(roofWidth, roofLength) * 0.6 },
    };
  }

  /** Open-wheel single-seater: nose, monocoque, sidepods, halo, airbox and two wings. */
  private buildFormula(spec: CarSpec): LiveryLayout {
    const body = spec.body;
    const floorY = body.floor + 0.05;
    const tubHeight = 0.42;
    const tubY = floorY + tubHeight / 2;
    const tubTop = tubY + tubHeight / 2;
    // Monocoque from just behind the front axle to the gearbox.
    const tubStart = -spec.front.offset + 0.35;
    const tubEnd = -spec.rear.offset + 0.3;
    this.box('paint', 0.72, tubHeight, tubEnd - tubStart, 0.12, [0, tubY, (tubStart + tubEnd) / 2]);
    // Nose, tapering down to the front wing.
    const noseLength = body.front - spec.front.offset + 0.5;
    const noseY = floorY + 0.2;
    this.box('paint', 0.34, 0.24, noseLength, 0.1, [0, noseY, -body.front + noseLength / 2]);
    // Sidepods between the axles.
    const podLength = spec.front.offset + -spec.rear.offset - 1.6;
    for (const side of [-1, 1]) {
      this.box('paint', 0.34, 0.3, podLength, 0.1, [side * 0.55, floorY + 0.17, 0.35]);
    }
    // Cockpit opening and halo.
    this.box('glass', 0.5, 0.08, 0.9, 0.04, [0, tubTop, -0.35]);
    this.box('carbon', 0.06, 0.05, 0.7, 0.02, [0, tubTop + 0.22, -0.4]);
    this.box('carbon', 0.06, 0.24, 0.05, 0.02, [0, tubTop + 0.1, -0.75]);
    // Airbox and engine cover.
    const airboxY = tubTop + 0.12;
    const airboxZ = 0.55;
    this.box('paint', 0.34, 0.36, 1.3, 0.1, [0, airboxY, airboxZ]);
    // Wings.
    this.box('carbon', body.halfWidth * 1.95, 0.04, 0.45, 0.01, [
      0,
      floorY + 0.02,
      -body.front + 0.25,
    ]);
    const rearWingY = tubY + 0.62;
    this.box('carbon', 1.0, 0.06, 0.34, 0.02, [0, rearWingY, body.rear - 0.2]);
    for (const side of [-1, 1]) {
      this.block('carbon', 0.03, 0.5, 0.6, [side * 0.5, rearWingY - 0.18, body.rear - 0.25]);
    }
    this.block('tail', 0.2, 0.08, 0.04, [0, floorY + 0.3, body.rear + 0.02]);

    return {
      front: body.front,
      rear: body.rear,
      waist: floorY + 0.27,
      stripeGap: 0.018,
      stripeWidth: 0.07,
      split: -spec.front.offset + 1.25,
      chevron: -body.front + 0.85,
      hoops: [-body.front + 0.7, airboxZ + 0.25],
      band: 0.3,
      // The number goes on the sides of the engine cover and on the nose.
      door: { z: airboxZ + 0.08, y: airboxY, height: 0.32, minX: 0.1, maxX: 0.22 },
      top: { z: -body.front + 0.78, y: noseY + 0.12, size: 0.32 },
    };
  }

  private addAxle(
    spec: CarSpec,
    axle: AxleSpec,
    tyreMat: THREE.Material,
    rimMat: THREE.Material,
    caliperMat: THREE.Material,
  ): void {
    const r = axle.wheelRadius;
    const width = TYRE_WIDTH;
    const tyreGeo = this.geometry(new THREE.CylinderGeometry(r, r, width, 28).rotateZ(Math.PI / 2));
    const caliperGeo = this.geometry(new THREE.BoxGeometry(0.08, 0.16, 0.12));
    const hardpointY = r - spec.cogHeight + axle.staticLength;
    for (const side of [-1, 1]) {
      // The rim and five spokes on its outer face (they make rotation visible) as one mesh.
      const rimParts: THREE.BufferGeometry[] = [
        new THREE.CylinderGeometry(r * 0.68, r * 0.68, width + 0.01, 20).rotateZ(Math.PI / 2),
      ];
      for (let s = 0; s < 5; s++) {
        rimParts.push(
          new THREE.BoxGeometry(SPOKE_THICKNESS, r * 1.28, 0.06)
            .rotateX((s / 5) * Math.PI)
            .translate(side * (width / 2 + SPOKE_OFFSET), 0, 0),
        );
      }
      const rimGeo = this.geometry(merge(rimParts));
      const pivot = new THREE.Group();
      pivot.position.set(side * axle.halfTrack, hardpointY - axle.staticLength, -axle.offset);
      const spinner = new THREE.Group();
      spinner.add(new THREE.Mesh(tyreGeo, tyreMat), new THREE.Mesh(rimGeo, rimMat));
      const caliper = new THREE.Mesh(caliperGeo, caliperMat);
      caliper.position.set(side * (width / 2 - 0.06), r * 0.42, r * 0.22);
      pivot.add(spinner, caliper);
      this.root.add(pivot);
      this.wheels.push({ pivot, spinner, hardpointY });
    }
  }

  /** A rounded box body part centred at `at` in the car frame. */
  private box(
    part: Part,
    w: number,
    h: number,
    d: number,
    radius: number,
    at: readonly [number, number, number],
  ): void {
    const geo = new RoundedBoxGeometry(w, h, d, 3, Math.min(radius, h / 2 - 0.001));
    this.parts[part].push(geo.translate(at[0], at[1], at[2]));
  }

  /** A plain box body part centred at `at` in the car frame. */
  private block(
    part: Part,
    w: number,
    h: number,
    d: number,
    at: readonly [number, number, number],
  ): void {
    this.parts[part].push(new THREE.BoxGeometry(w, h, d).translate(at[0], at[1], at[2]));
  }

  /** Turns the collected body parts into one mesh per material. */
  private mergeParts(materials: Record<Part, THREE.Material>): void {
    for (const part of Object.keys(this.parts) as Part[]) {
      const geometries = this.parts[part];
      if (geometries.length === 0) continue;
      this.root.add(new THREE.Mesh(this.geometry(merge(geometries)), materials[part]));
      geometries.length = 0;
    }
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

/** Merges geometries into one (disposing the inputs), whether or not they are indexed. */
function merge(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const mixed = geometries.some((g) => g.index === null);
  const inputs = mixed
    ? geometries.map((g) => (g.index === null ? g : g.toNonIndexed()))
    : geometries;
  const merged = mergeGeometries(inputs, false);
  for (const g of new Set([...geometries, ...inputs])) g.dispose();
  if (!merged) throw new Error('CarView: body parts could not be merged');
  return merged;
}
