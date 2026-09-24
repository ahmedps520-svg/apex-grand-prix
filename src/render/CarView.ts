import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import { defaultLivery, type Livery } from '../content/livery';
import type { CarStyle } from '../sim/vehicle/cars';
import type { AxleSpec, CarSpec } from '../sim/vehicle/spec';
import {
  FLAG_HAZARDS,
  FLAG_HEADLIGHTS,
  FLAG_INDICATOR_LEFT,
  FLAG_INDICATOR_RIGHT,
  FLAG_SIREN,
  PART_BUMPER_FRONT,
  PART_BUMPER_REAR,
  PART_DOOR_LEFT,
  PART_DOOR_RIGHT,
  PART_HOOD,
  PART_WING,
  SOFT_NODES,
  FLAG_RETIRED,
} from '../shared/protocol';
import type { Vec3 } from '../shared/math';
import { SOFT_NZ, latticeAxes, nodeIndex } from '../sim/vehicle/softbody';
import type { CarRenderState } from './interpolate';
import { LiveryMaterial, type LiveryLayout } from './liveryMaterial';

/** Panels that can come off in a crash (free roam), and the flag each answers to. */
type Panel = 'hood' | 'bumperFront' | 'bumperRear' | 'doorLeft' | 'doorRight' | 'wing';
const PANEL_FLAGS: Record<Panel, number> = {
  hood: PART_HOOD,
  bumperFront: PART_BUMPER_FRONT,
  bumperRear: PART_BUMPER_REAR,
  doorLeft: PART_DOOR_LEFT,
  doorRight: PART_DOOR_RIGHT,
  wing: PART_WING,
};

/** A mesh whose vertices follow the soft body's lattice (and the traffic's dents). */
interface Deformable {
  mesh: THREE.Mesh;
  /** Vertex positions as built, and each vertex's eight lattice nodes with their weights. */
  original: Float32Array;
  corners: Uint8Array;
  weights: Float32Array;
  panel: Panel | null;
}

interface PanelView {
  mesh: THREE.Mesh;
  /** Where it sits on the car, to put it back after a repair. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

/** A panel that has come off: it tumbles to the ground and lies there. */
interface Debris {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  resting: boolean;
}

/** How far a dented end is pushed in, m, and how much of the end it covers, m. */
const DENT_DEPTH = 0.3;
const DENT_REACH = 0.7;
const GRAVITY = 9.81;

interface WheelView {
  /** Positioned at the wheel centre; rotates for steering. */
  pivot: THREE.Group;
  /** Child of the pivot; rotates as the wheel rolls. */
  spinner: THREE.Group;
  hardpointY: number;
}

/** Materials of the static body parts; each becomes one merged mesh (one draw call). */
type Part =
  | 'paint'
  | 'glass'
  | 'carbon'
  | 'head'
  | 'tail'
  | 'indicatorL'
  | 'indicatorR'
  | 'strobeR'
  | 'strobeB';

/** The police light bar's strobes alternate red and blue this often, ms. */
const STROBE_PERIOD = 440;

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
    /** How far the nose sits below the bonnet line, m. */
    noseDrop: number;
    /** Length of the windscreen and rear window slopes, m. */
    screenRake: number;
    backRake: number;
    /** How far the tail drops below the deck, m. */
    tailDrop: number;
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
    noseDrop: 0.2,
    screenRake: 0.55,
    backRake: 0.8,
    tailDrop: 0.08,
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
    noseDrop: 0.24,
    screenRake: 0.5,
    backRake: 0.65,
    tailDrop: 0.05,
  },
  // A three-box saloon: bonnet, cabin in the middle, boot.
  touring: {
    bodyRise: 0.08,
    round: 0.08,
    cabinHeight: 0.55,
    cabinLength: 0.44,
    cabinWidth: 1.6,
    cabinOffset: 0.05,
    wing: 0.14,
    splitter: true,
    noseDrop: 0.1,
    screenRake: 0.45,
    backRake: 0.38,
    tailDrop: 0.06,
  },
  suv: {
    bodyRise: 0.1,
    round: 0.14,
    cabinHeight: 0.68,
    cabinLength: 0.62,
    cabinWidth: 1.72,
    cabinOffset: 0.1,
    wing: 0,
    splitter: false,
    noseDrop: 0.12,
    screenRake: 0.32,
    backRake: 0.14,
    tailDrop: 0.05,
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
    noseDrop: 0.15,
    screenRake: 0.5,
    backRake: 0.6,
    tailDrop: 0.07,
  },
};

/** Width of the glasshouse's top as a share of its bottom. */
const CABIN_TAPER = 0.82;
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
    indicatorL: [],
    indicatorR: [],
    strobeR: [],
    strobeB: [],
  };
  private readonly paint: LiveryMaterial;
  /** Lamp materials, driven by the car's lights and brakes each frame. */
  private readonly lamps: {
    head: THREE.MeshStandardMaterial;
    tail: THREE.MeshStandardMaterial;
    left: THREE.MeshStandardMaterial;
    right: THREE.MeshStandardMaterial;
    strobeR: THREE.MeshStandardMaterial;
    strobeB: THREE.MeshStandardMaterial;
  };
  /** The player's car casts real headlight beams. */
  private readonly beams: THREE.SpotLight[] = [];
  /** A police car: a light bar on the roof whose strobes run with the siren. */
  private readonly police: boolean;
  /** Damage: the meshes that follow the lattice, the panels that can come off, and debris. */
  private readonly deformables: Deformable[] = [];
  private readonly panelGeometries: Array<{
    panel: Panel;
    part: Part;
    geometry: THREE.BufferGeometry;
  }> = [];
  private readonly panels = new Map<Panel, PanelView>();
  private readonly debris: Debris[] = [];
  private detached = 0;
  private readonly lastDisp = new Float32Array(SOFT_NODES * 3);
  private readonly dents = { front: 0, rear: 0 };
  private shaped = false;
  /** The furthest any vertex now sits from where it was built, m (for the tests). */
  bodyMoved = 0;
  private readonly axes: { xs: number[]; ys: number[]; zs: number[] };
  private readonly dims: { front: number; rear: number };

  /** `livery` wins over `paint`; without one the car wears the default livery in `paint`. */
  constructor(
    spec: CarSpec,
    paint = 0xa3101f,
    style: CarStyle = 'gt',
    livery?: Livery,
    beams = false,
    police = false,
  ) {
    this.police = police;
    this.axes = latticeAxes(spec);
    this.dims = { front: spec.body.front, rear: spec.body.rear };
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
      indicatorL: this.material(
        new THREE.MeshStandardMaterial({
          color: 0x7a3a08,
          emissive: 0xff8f1f,
          emissiveIntensity: 0.15,
        }),
      ),
      indicatorR: this.material(
        new THREE.MeshStandardMaterial({
          color: 0x7a3a08,
          emissive: 0xff8f1f,
          emissiveIntensity: 0.15,
        }),
      ),
      strobeR: this.material(
        new THREE.MeshStandardMaterial({
          color: 0x5a0a0a,
          emissive: 0xff2020,
          emissiveIntensity: 0.2,
        }),
      ),
      strobeB: this.material(
        new THREE.MeshStandardMaterial({
          color: 0x0a1a5a,
          emissive: 0x2050ff,
          emissiveIntensity: 0.2,
        }),
      ),
    };
    this.lamps = {
      head: mat.head,
      tail: mat.tail,
      left: mat.indicatorL,
      right: mat.indicatorR,
      strobeR: mat.strobeR,
      strobeB: mat.strobeB,
    };

    const layout = style === 'formula' ? this.buildFormula(spec) : this.buildClosed(spec, style);
    this.paint = new LiveryMaterial(layout, livery ?? { ...defaultLivery(), primary: paint });
    this.mergeParts({ ...mat, paint: this.paint.material });
    if (beams) this.addBeams(layout.front);

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

  private retired = false;

  update(state: CarRenderState): void {
    this.root.position.set(state.pos.x, state.pos.y, state.pos.z);
    if (state.dentFront !== this.dents.front || state.dentRear !== this.dents.rear) {
      this.setDents(state.dentFront, state.dentRear);
    }
    const flags = state.flags;
    // Out of the race: gone from the track (and back when the race restarts).
    const retired = (flags & FLAG_RETIRED) !== 0;
    if (retired !== this.retired) {
      this.retired = retired;
      this.root.visible = !retired;
    }
    const blink = performance.now() % 800 < 400;
    const left = (flags & (FLAG_INDICATOR_LEFT | FLAG_HAZARDS)) !== 0 && blink;
    const right = (flags & (FLAG_INDICATOR_RIGHT | FLAG_HAZARDS)) !== 0 && blink;
    const lights = (flags & FLAG_HEADLIGHTS) !== 0;
    const lamps = this.lamps;
    lamps.left.emissiveIntensity = left ? 4 : 0.15;
    lamps.right.emissiveIntensity = right ? 4 : 0.15;
    lamps.head.emissiveIntensity = lights ? 4.5 : 1.6;
    lamps.tail.emissiveIntensity = state.brake > 0.05 ? 3.5 : lights ? 1.6 : 0.6;
    for (const beam of this.beams) beam.visible = lights;
    if (this.police) {
      const siren = (flags & FLAG_SIREN) !== 0;
      const red = performance.now() % STROBE_PERIOD < STROBE_PERIOD / 2;
      lamps.strobeR.emissiveIntensity = siren && red ? 7 : 0.2;
      lamps.strobeB.emissiveIntensity = siren && !red ? 7 : 0.2;
      // The headlamps wig-wag with the strobes.
      if (siren) lamps.head.emissiveIntensity = red ? 5 : 1;
    }
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
    for (const d of this.debris) d.mesh.removeFromParent();
    this.debris.length = 0;
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.paint.dispose();
  }

  // ---------------------------------------------------------------- damage

  /**
   * Free roam: bends the body to the soft body's lattice (node displacements at `base` in the
   * snapshot). Returns the flags of the panels the sim says have come off.
   */
  deform(view: Float32Array, base: number): number {
    let changed = false;
    const last = this.lastDisp;
    for (let i = 0; i < SOFT_NODES * 3; i++) {
      const d = view[base + i]!;
      if (Math.abs(d - last[i]!) > 0.002) {
        changed = true;
        break;
      }
    }
    if (changed) {
      for (let i = 0; i < SOFT_NODES * 3; i++) last[i] = view[base + i]!;
      this.reshape();
    }
    return view[base + SOFT_NODES * 3]! | 0;
  }

  /** Traffic's simple damage: each end pushed in by its dent. */
  setDents(front: number, rear: number): void {
    this.dents.front = front;
    this.dents.rear = rear;
    this.reshape();
  }

  /**
   * Takes off the panels whose flags are set (once each): they leave the car with its velocity
   * and a tumble, and fall to the road.
   */
  detach(
    flags: number,
    scene: THREE.Object3D,
    vel: Vec3,
    heightAt: (x: number, z: number) => number,
  ): void {
    const fresh = flags & ~this.detached;
    if (!fresh) return;
    this.detached |= fresh;
    for (const [panel, view] of this.panels) {
      if (!(fresh & PANEL_FLAGS[panel])) continue;
      const mesh = view.mesh;
      const position = new THREE.Vector3();
      const quaternion = new THREE.Quaternion();
      mesh.getWorldPosition(position);
      mesh.getWorldQuaternion(quaternion);
      mesh.removeFromParent();
      mesh.position.copy(position);
      mesh.quaternion.copy(quaternion);
      scene.add(mesh);
      const side = panel === 'doorLeft' ? -1 : panel === 'doorRight' ? 1 : 0;
      this.debris.push({
        mesh,
        vel: new THREE.Vector3(
          vel.x * 0.8 + side * 2 + (Math.random() - 0.5) * 2,
          3 + Math.random() * 2,
          vel.z * 0.8 + (Math.random() - 0.5) * 2,
        ),
        spin: new THREE.Vector3(
          (Math.random() - 0.5) * 8,
          (Math.random() - 0.5) * 4,
          (Math.random() - 0.5) * 8,
        ),
        resting: false,
      });
      position.y = Math.max(position.y, heightAt(position.x, position.z) + 0.1);
    }
  }

  /** Flies the panels that came off, until they land. */
  updateDebris(dt: number, heightAt: (x: number, z: number) => number): void {
    for (const d of this.debris) {
      if (d.resting) continue;
      d.vel.y -= GRAVITY * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      const ground = heightAt(d.mesh.position.x, d.mesh.position.z) + 0.06;
      if (d.mesh.position.y < ground) {
        d.mesh.position.y = ground;
        d.vel.y = Math.abs(d.vel.y) * 0.25;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.4);
        if (d.vel.length() < 0.6) {
          d.resting = true;
          // Lies flat.
          d.mesh.rotation.x = Math.round(d.mesh.rotation.x / Math.PI) * Math.PI;
          d.mesh.rotation.z = Math.round(d.mesh.rotation.z / Math.PI) * Math.PI;
        }
      }
    }
  }

  /** Puts every panel back and straightens the body (a repair). */
  repairView(): void {
    for (const d of this.debris) {
      d.mesh.removeFromParent();
      this.root.add(d.mesh);
    }
    this.debris.length = 0;
    for (const view of this.panels.values()) {
      view.mesh.position.copy(view.position);
      view.mesh.quaternion.copy(view.quaternion);
      view.mesh.rotation.setFromQuaternion(view.quaternion);
    }
    this.detached = 0;
    this.lastDisp.fill(0);
    this.dents.front = 0;
    this.dents.rear = 0;
    this.reshape();
  }

  /** Every vertex from its built position, plus the dents and the lattice's displacement. */
  private reshape(): void {
    const disp = this.lastDisp;
    let bent = this.dents.front > 0 || this.dents.rear > 0;
    for (let i = 0; i < disp.length && !bent; i++) if (Math.abs(disp[i]!) > 0.001) bent = true;
    if (!bent && !this.shaped) return;
    this.shaped = bent;
    const { front, rear } = this.dents;
    const zF = -this.dims.front;
    const zR = this.dims.rear;
    let moved = 0;
    for (const d of this.deformables) {
      if (d.panel && this.detached & PANEL_FLAGS[d.panel]) continue;
      const attr = d.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const out = attr.array as Float32Array;
      const orig = d.original;
      const n = orig.length / 3;
      for (let v = 0; v < n; v++) {
        const i = v * 3;
        let x = orig[i]!;
        let y = orig[i + 1]!;
        let z = orig[i + 2]!;
        if (front > 0 && z < zF + DENT_REACH) {
          const k = (1 - (z - zF) / DENT_REACH) * front;
          z += DENT_DEPTH * k;
          y += 0.05 * k * Math.sin(x * 9 + y * 5);
        }
        if (rear > 0 && z > zR - DENT_REACH) {
          const k = (1 - (zR - z) / DENT_REACH) * rear;
          z -= DENT_DEPTH * k;
          y += 0.05 * k * Math.sin(x * 9 + y * 5);
        }
        if (bent) {
          for (let c = 0; c < 8; c++) {
            const w = d.weights[v * 8 + c]!;
            if (w === 0) continue;
            const node = d.corners[v * 8 + c]! * 3;
            x += disp[node]! * w;
            y += disp[node + 1]! * w;
            z += disp[node + 2]! * w;
          }
        }
        out[i] = x;
        out[i + 1] = y;
        out[i + 2] = z;
        const m = Math.abs(x - orig[i]!) + Math.abs(y - orig[i + 1]!) + Math.abs(z - orig[i + 2]!);
        if (m > moved) moved = m;
      }
      attr.needsUpdate = true;
      d.mesh.geometry.computeVertexNormals();
    }
    this.bodyMoved = moved;
  }

  /** Binds a mesh's vertices to the lattice (trilinear weights of the cell each sits in). */
  private bindToLattice(mesh: THREE.Mesh, panel: Panel | null): void {
    const attr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const positions = attr.array as Float32Array;
    const n = attr.count;
    const corners = new Uint8Array(n * 8);
    const weights = new Float32Array(n * 8);
    const { xs, ys, zs } = this.axes;
    const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
    for (let v = 0; v < n; v++) {
      const x = positions[v * 3]!;
      const y = positions[v * 3 + 1]!;
      const z = positions[v * 3 + 2]!;
      const cx = x < xs[1]! ? 0 : 1;
      const tx = clamp01((x - xs[cx]!) / (xs[cx + 1]! - xs[cx]!));
      const ty = clamp01((y - ys[0]!) / (ys[1]! - ys[0]!));
      let cz = 0;
      while (cz < SOFT_NZ - 2 && z > zs[cz + 1]!) cz++;
      const tz = clamp01((z - zs[cz]!) / (zs[cz + 1]! - zs[cz]!));
      let c = 0;
      for (let dz = 0; dz <= 1; dz++) {
        for (let dy = 0; dy <= 1; dy++) {
          for (let dx = 0; dx <= 1; dx++) {
            corners[v * 8 + c] = nodeIndex(cx + dx, dy, cz + dz);
            weights[v * 8 + c] = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz);
            c++;
          }
        }
      }
    }
    this.deformables.push({ mesh, original: new Float32Array(positions), corners, weights, panel });
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
    const cabinHeight = look.cabinHeight;
    const cabinLength = length * look.cabinLength;
    const cabinWidth = body.halfWidth * look.cabinWidth;
    const cabinZ = centreZ + look.cabinOffset;
    const cabinTop = upperTop + cabinHeight - 0.03;
    const cabinFront = cabinZ - cabinLength / 2;
    const cabinRear = cabinZ + cabinLength / 2;

    // The body shell: a side profile (nose, bonnet rising to the windscreen, deck, tail)
    // extruded across the car with rounded edges.
    const zF = -body.front;
    const zR = body.rear;
    const yB = upperBottom;
    const yT = upperTop;
    const noseTop = yT - look.noseDrop;
    this.profile(
      'paint',
      [
        [zF + 0.1, yB],
        [zF, yB + 0.1],
        [zF - 0.02, noseTop - 0.05],
        [zF + 0.12, noseTop],
        [zF + length * 0.2, yT - look.noseDrop * 0.35],
        [cabinFront - 0.15, yT],
        [zR - 0.3, yT],
        [zR - 0.02, yT - look.tailDrop],
        [zR, yB + 0.12],
        [zR - 0.1, yB],
      ],
      halfWidth,
      Math.min(look.round, 0.08),
    );

    // The glasshouse: raked windscreen and rear window, narrower at the top, painted roof.
    const roofFront = cabinFront + look.screenRake;
    const roofRear = cabinRear - look.backRake;
    this.profile(
      'glass',
      [
        [cabinFront - look.screenRake * 0.35, yT - 0.03],
        [roofFront, cabinTop],
        [roofRear, cabinTop],
        [cabinRear + look.backRake * 0.2, yT - 0.03],
      ],
      cabinWidth / 2,
      0.03,
      { taper: CABIN_TAPER, from: yT, to: cabinTop },
    );
    const roofWidth = cabinWidth * CABIN_TAPER - 0.04;
    this.box('paint', roofWidth, 0.03, Math.max(roofRear - roofFront, 0.2), 0.012, [
      0,
      cabinTop + 0.005,
      (roofFront + roofRear) / 2,
    ]);
    if (this.police) {
      // The light bar: a dark base across the roof, red strobes left and blue right.
      const barZ = (roofFront + roofRear) / 2 - 0.05;
      const barWidth = roofWidth * 0.88;
      this.block('carbon', barWidth, 0.05, 0.24, [0, cabinTop + 0.04, barZ]);
      this.block('strobeR', barWidth * 0.42, 0.09, 0.2, [-barWidth * 0.24, cabinTop + 0.11, barZ]);
      this.block('strobeB', barWidth * 0.42, 0.09, 0.2, [barWidth * 0.24, cabinTop + 0.11, barZ]);
    }

    if (look.splitter) {
      this.box('carbon', body.halfWidth * 1.9, 0.04, 0.34, 0.01, [
        0,
        tubBottom + 0.01,
        -body.front + 0.12,
      ]);
    }
    // The panels that can come off in a crash: bumpers, bonnet, doors, and the wing.
    const bumperY = yB + 0.12;
    this.panelGeometries.push(
      {
        panel: 'bumperFront',
        part: 'paint',
        geometry: new RoundedBoxGeometry(halfWidth * 1.9, 0.14, 0.14, 3, 0.04).translate(
          0,
          bumperY,
          zF - 0.02,
        ),
      },
      {
        panel: 'bumperRear',
        part: 'paint',
        geometry: new RoundedBoxGeometry(halfWidth * 1.9, 0.14, 0.14, 3, 0.04).translate(
          0,
          bumperY,
          zR + 0.02,
        ),
      },
      {
        panel: 'hood',
        part: 'paint',
        geometry: this.profileGeometry(
          [
            [zF + 0.18, noseTop + 0.012],
            [zF + length * 0.2, yT - look.noseDrop * 0.35 + 0.012],
            [cabinFront - 0.22, yT + 0.012],
            [cabinFront - 0.22, yT - 0.012],
            [zF + length * 0.2, yT - look.noseDrop * 0.35 - 0.012],
            [zF + 0.18, noseTop - 0.012],
          ],
          halfWidth * 0.72,
          0.008,
        ),
      },
    );
    for (const side of [-1, 1]) {
      this.panelGeometries.push({
        panel: side < 0 ? 'doorLeft' : 'doorRight',
        part: 'paint',
        geometry: new THREE.BoxGeometry(0.024, yT - yB - 0.12, cabinLength * 0.95).translate(
          side * (halfWidth + 0.006),
          (yT + yB) / 2,
          cabinZ + 0.05,
        ),
      });
    }
    if (look.wing > 0) {
      const wingY = upperTop + look.wing;
      const wing: THREE.BufferGeometry[] = [
        new RoundedBoxGeometry(body.halfWidth * 1.85, 0.05, 0.36, 3, 0.02).translate(
          0,
          wingY,
          body.rear - 0.25,
        ),
      ];
      for (const side of [-1, 1]) {
        wing.push(
          new THREE.BoxGeometry(0.05, look.wing, 0.18).translate(
            side * 0.55,
            wingY - look.wing / 2,
            body.rear - 0.25,
          ),
        );
      }
      this.panelGeometries.push({ panel: 'wing', part: 'carbon', geometry: merge(wing) });
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
      const indicator = side < 0 ? 'indicatorL' : 'indicatorR';
      this.block(indicator, 0.1, 0.07, 0.04, [
        side * (halfWidth - 0.09),
        lightY,
        -body.front - 0.005,
      ]);
      this.block(indicator, 0.1, 0.07, 0.04, [
        side * (halfWidth - 0.08),
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
      top: {
        z: (roofFront + roofRear) / 2,
        y: cabinTop + 0.02,
        size: Math.min(roofWidth, Math.max(roofRear - roofFront, 0.2)) * 0.6,
      },
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

  /**
   * A body part from a side profile — points (z, y) in the car frame, going round the outline —
   * extruded across the car to ±halfWidth, with bevelled edges. `taper` narrows it towards the
   * top (a glasshouse).
   */
  private profile(
    part: Part,
    outline: ReadonlyArray<readonly [number, number]>,
    halfWidth: number,
    bevel: number,
    taper?: { taper: number; from: number; to: number },
  ): void {
    this.parts[part].push(this.profileGeometry(outline, halfWidth, bevel, taper));
  }

  /** The geometry behind `profile`, for parts that stay separate meshes. */
  private profileGeometry(
    outline: ReadonlyArray<readonly [number, number]>,
    halfWidth: number,
    bevel: number,
    taper?: { taper: number; from: number; to: number },
  ): THREE.BufferGeometry {
    const shape = new THREE.Shape();
    outline.forEach(([z, y], i) => (i === 0 ? shape.moveTo(z, y) : shape.lineTo(z, y)));
    shape.closePath();
    const depth = Math.max(2 * (halfWidth - bevel), 0.02);
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 2,
      curveSegments: 1,
    });
    // Shape x → car z, shape y → car y, extrusion → car x: a proper rotation, so faces keep
    // facing outwards.
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const nor = geo.getAttribute('normal') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const sx = pos.getX(i);
      const sy = pos.getY(i);
      const sz = pos.getZ(i);
      let x = depth / 2 - sz;
      if (taper) {
        const t = Math.min(Math.max((sy - taper.from) / (taper.to - taper.from), 0), 1);
        x *= 1 + (taper.taper - 1) * t;
      }
      pos.setXYZ(i, x, sy, sx);
      nor.setXYZ(i, -nor.getZ(i), nor.getY(i), nor.getX(i));
    }
    return geo;
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

  /** Two spot lights from the headlamps, lighting the road ahead (the player's car only). */
  private addBeams(front: number): void {
    for (const side of [-1, 1]) {
      const beam = new THREE.SpotLight(0xfff4de, 90, 75, 0.55, 0.6, 1.4);
      beam.position.set(side * 0.62, 0.55, -front);
      beam.target.position.set(side * 1.2, -0.6, -front - 30);
      beam.castShadow = false;
      beam.visible = false;
      this.root.add(beam, beam.target);
      this.beams.push(beam);
    }
  }

  /** Turns the collected body parts into one mesh per material, and the panels into theirs. */
  private mergeParts(materials: Record<Part, THREE.Material>): void {
    for (const part of Object.keys(this.parts) as Part[]) {
      const geometries = this.parts[part];
      if (geometries.length === 0) continue;
      const mesh = new THREE.Mesh(this.geometry(merge(geometries)), materials[part]);
      this.root.add(mesh);
      this.bindToLattice(mesh, null);
      geometries.length = 0;
    }
    for (const { panel, part, geometry } of this.panelGeometries) {
      const mesh = new THREE.Mesh(this.geometry(geometry), materials[part]);
      this.root.add(mesh);
      this.bindToLattice(mesh, panel);
      this.panels.set(panel, {
        mesh,
        position: mesh.position.clone(),
        quaternion: mesh.quaternion.clone(),
      });
    }
    this.panelGeometries.length = 0;
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
