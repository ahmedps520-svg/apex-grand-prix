import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { SURFACE } from '../sim/track/surface';

/** Strips of mark kept on the road before the oldest are laid again. */
export const SKID_CAPACITY = 6000;
/** A new strip once the wheel has moved this far, metres. */
const MIN_STEP = 0.3;
/** Further than this since the last point (a reset or a teleport): a new mark starts. */
const MAX_STEP = 4;
/** Height over the contact point, metres (and polygon-offset over the road). */
const LIFT = 0.012;

/** What a wheel is doing, as the render state has it. */
export interface SkidWheel {
  contact: boolean;
  surface: number;
  /** Combined slip: 0 = full grip … ≥ 1 = sliding. */
  slip: number;
  /** Longitudinal slip ratio: + wheelspin, − locking. */
  slipRatio: number;
}

/**
 * How dark a mark a wheel lays now, 0 … 0.85: sliding sideways, locked under braking or
 * spinning up; on tarmac and kerbs only.
 */
export function skidIntensity(w: SkidWheel): number {
  if (!w.contact || (w.surface !== SURFACE.ASPHALT && w.surface !== SURFACE.KERB)) return 0;
  const slide = (w.slip - 0.45) / 0.8;
  const lock = (-w.slipRatio - 0.25) / 0.5;
  const spin = (w.slipRatio - 0.35) / 0.8;
  return Math.min(Math.max(slide, lock, spin, 0), 0.85);
}

interface Trail {
  x: number;
  z: number;
  /** The last strip's end corners, so the next one joins it without a gap. */
  lx: number;
  lz: number;
  rx: number;
  rz: number;
  y: number;
  strength: number;
  /** A strip has been laid from this point (its corners are real). */
  joined: boolean;
}

/**
 * Tyre marks: every sliding, locked or spinning wheel lays a dark strip the width of its tyre
 * behind it, fading in and out with how hard it slides. One mesh; a ring of strips reused
 * oldest first, so the marks of a long session stay on the road until they are laid over.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private readonly positions: Float32Array;
  private readonly strengths: Float32Array;
  private readonly position: THREE.BufferAttribute;
  private readonly strength: THREE.BufferAttribute;
  private head = 0;
  private laid = 0;
  private dirtyFrom = -1;
  private dirtyTo = -1;
  private wrapped = false;
  private readonly trails = new Map<number, Trail>();

  constructor(readonly capacity = SKID_CAPACITY) {
    this.positions = new Float32Array(capacity * 4 * 3);
    this.strengths = new Float32Array(capacity * 4);
    const indices = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4;
      indices.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    const geometry = new THREE.BufferGeometry();
    this.position = new THREE.BufferAttribute(this.positions, 3);
    this.position.setUsage(THREE.DynamicDrawUsage);
    this.strength = new THREE.BufferAttribute(this.strengths, 1);
    this.strength.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.position);
    geometry.setAttribute('strength', this.strength);
    geometry.setAttribute(
      'normal',
      new THREE.BufferAttribute(
        new Float32Array(capacity * 4 * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)),
        3,
      ),
    );
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x0a0a0b,
      roughness: 0.7,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      // Seen from either side whichever way the strip was wound.
      side: THREE.DoubleSide,
    });
    material.opacityNode = attribute<'float'>('strength');
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    // Over the road and its paint.
    this.mesh.renderOrder = 3;
  }

  /** Strips laid since the last clear (for the tests and the overlay). */
  get count(): number {
    return this.laid;
  }

  /**
   * One wheel's contact point this frame (`key` is the car × 4 + the wheel), the tyre's
   * width, and how hard it slides (see skidIntensity).
   */
  wheel(key: number, x: number, y: number, z: number, width: number, intensity: number): void {
    const trail = this.trails.get(key);
    if (intensity <= 0) {
      if (trail) this.trails.delete(key);
      return;
    }
    if (!trail) {
      this.trails.set(key, { x, z, y, lx: x, lz: z, rx: x, rz: z, strength: 0, joined: false });
      return;
    }
    const dx = x - trail.x;
    const dz = z - trail.z;
    const d = Math.hypot(dx, dz);
    if (d > MAX_STEP) {
      this.trails.set(key, { x, z, y, lx: x, lz: z, rx: x, rz: z, strength: 0, joined: false });
      return;
    }
    if (d < MIN_STEP) return;
    const half = width / 2;
    const px = (-dz / d) * half;
    const pz = (dx / d) * half;
    // From the last strip's end (or across the start point), to across the wheel now.
    const sx0 = trail.joined ? trail.lx : trail.x + px;
    const sz0 = trail.joined ? trail.lz : trail.z + pz;
    const sx1 = trail.joined ? trail.rx : trail.x - px;
    const sz1 = trail.joined ? trail.rz : trail.z - pz;
    const ex0 = x + px;
    const ez0 = z + pz;
    const ex1 = x - px;
    const ez1 = z - pz;
    this.strip(
      [sx0, trail.y + LIFT, sz0, sx1, trail.y + LIFT, sz1, ex0, y + LIFT, ez0, ex1, y + LIFT, ez1],
      trail.joined ? trail.strength : 0,
      intensity,
    );
    trail.x = x;
    trail.z = z;
    trail.y = y;
    trail.lx = ex0;
    trail.lz = ez0;
    trail.rx = ex1;
    trail.rz = ez1;
    trail.strength = intensity;
    trail.joined = true;
  }

  /** Marks the strips laid this frame for upload. */
  flush(): void {
    if (this.dirtyFrom < 0) return;
    this.position.clearUpdateRanges();
    this.strength.clearUpdateRanges();
    if (this.wrapped) {
      this.position.needsUpdate = true;
      this.strength.needsUpdate = true;
    } else {
      const count = this.dirtyTo - this.dirtyFrom + 1;
      this.position.addUpdateRange(this.dirtyFrom * 12, count * 12);
      this.strength.addUpdateRange(this.dirtyFrom * 4, count * 4);
      this.position.needsUpdate = true;
      this.strength.needsUpdate = true;
    }
    this.dirtyFrom = -1;
    this.dirtyTo = -1;
    this.wrapped = false;
  }

  /** A clean road (a new session or track). */
  clear(): void {
    this.positions.fill(0);
    this.strengths.fill(0);
    this.head = 0;
    this.laid = 0;
    this.trails.clear();
    this.position.clearUpdateRanges();
    this.strength.clearUpdateRanges();
    this.position.needsUpdate = true;
    this.strength.needsUpdate = true;
    this.dirtyFrom = -1;
    this.dirtyTo = -1;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }

  private strip(corners: number[], from: number, to: number): void {
    const q = this.head;
    this.positions.set(corners, q * 12);
    this.strengths[q * 4] = from;
    this.strengths[q * 4 + 1] = from;
    this.strengths[q * 4 + 2] = to;
    this.strengths[q * 4 + 3] = to;
    if (this.dirtyFrom < 0) {
      this.dirtyFrom = q;
      this.dirtyTo = q;
    } else if (q < this.dirtyTo) {
      this.wrapped = true;
    } else {
      this.dirtyTo = q;
    }
    this.head = (q + 1) % this.capacity;
    this.laid++;
  }
}
