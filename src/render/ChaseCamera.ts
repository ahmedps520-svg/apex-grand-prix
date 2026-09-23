import * as THREE from 'three/webgpu';
import type { CarRenderState } from './interpolate';

/** 'orbit' circles the car (debug / showroom view, only via ?cam=orbit; not in the cycle). */
const DEFAULT_FOV = 62;

export type CameraMode = 'chase' | 'chase-far' | 'bonnet' | 'orbit';
const MODES: CameraMode[] = ['chase', 'chase-far', 'bonnet'];

const FORWARD = new THREE.Vector3(0, 0, -1);

/**
 * Chase camera. Only the heading is damped (not the distance), so the camera never falls
 * behind at speed; it swings round slightly late in corners and follows the direction of
 * travel a little when the car slides.
 */
export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  private heading = 0;
  private initialised = false;
  private readonly carQuat = new THREE.Quaternion();
  private readonly carPos = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private smoothedPitch = 0;
  private orbitAngle = 0.6;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(DEFAULT_FOV, aspect, 0.1, 3200);
  }

  cycle(): CameraMode {
    const index = MODES.indexOf(this.mode);
    this.mode = MODES[(index + 1) % MODES.length]!;
    return this.mode;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Snap behind the car (e.g. after a reset) instead of swinging round, and take the camera
   * back from anything else that moved or zoomed it (TV cameras, photo mode).
   */
  reset(): void {
    this.initialised = false;
    this.camera.up.set(0, 1, 0);
    if (this.camera.fov !== DEFAULT_FOV) {
      this.camera.fov = DEFAULT_FOV;
      this.camera.updateProjectionMatrix();
    }
  }

  update(dt: number, car: CarRenderState): void {
    this.carQuat.set(car.rot.x, car.rot.y, car.rot.z, car.rot.w);
    this.carPos.set(car.pos.x, car.pos.y, car.pos.z);
    this.fwd.copy(FORWARD).applyQuaternion(this.carQuat);

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.5;
      this.camera.up.set(0, 1, 0);
      this.camera.position.set(
        this.carPos.x + Math.sin(this.orbitAngle) * 5.2,
        this.carPos.y + 0.9,
        this.carPos.z + Math.cos(this.orbitAngle) * 5.2,
      );
      this.target.copy(this.carPos);
      this.camera.lookAt(this.target);
      this.setFov(50, dt, car);
      return;
    }

    if (this.mode === 'bonnet') {
      this.camera.position.set(0, 0.62, -0.55).applyQuaternion(this.carQuat).add(this.carPos);
      this.target.copy(this.camera.position).addScaledVector(this.fwd, 10);
      this.camera.up.set(0, 1, 0).applyQuaternion(this.carQuat);
      this.camera.lookAt(this.target);
      this.setFov(68, dt, car);
      return;
    }
    this.camera.up.set(0, 1, 0);

    // Heading to follow: the car's nose, blended towards the direction of travel when sliding.
    let desired = Math.atan2(-this.fwd.x, -this.fwd.z);
    const speed = Math.hypot(car.vel.x, car.vel.z);
    if (speed > 4) {
      const travel = Math.atan2(-car.vel.x, -car.vel.z);
      desired += wrap(travel - desired) * 0.35 * Math.min((speed - 4) / 10, 1);
    }
    if (!this.initialised) {
      this.heading = desired;
      this.smoothedPitch = 0;
      this.initialised = true;
    }
    this.heading += wrap(desired - this.heading) * (1 - Math.exp(-dt * 6));

    const far = this.mode === 'chase-far';
    const distance = far ? 8.2 : 5.9;
    const height = far ? 2.6 : 1.85;
    const sin = Math.sin(this.heading);
    const cos = Math.cos(this.heading);
    // Follow the car's pitch a little (crests, braking) but not its roll.
    const pitch = Math.asin(Math.max(-1, Math.min(1, this.fwd.y)));
    this.smoothedPitch += (pitch - this.smoothedPitch) * (1 - Math.exp(-dt * 4));
    this.camera.position.set(
      this.carPos.x + sin * distance,
      this.carPos.y + height - Math.sin(this.smoothedPitch) * distance,
      this.carPos.z + cos * distance,
    );
    if (this.camera.position.y < 0.4) this.camera.position.y = 0.4;
    this.target.set(this.carPos.x - sin * 3, this.carPos.y + 0.75, this.carPos.z - cos * 3);
    this.camera.lookAt(this.target);
    this.setFov(far ? 58 : 62, dt, car);
  }

  private setFov(base: number, dt: number, car: CarRenderState): void {
    // A touch wider at speed for a sense of pace.
    const target = base + Math.min(Math.abs(car.speed) * 0.09, 9);
    const fov = this.camera.fov + (target - this.camera.fov) * (1 - Math.exp(-dt * 3));
    if (Math.abs(fov - this.camera.fov) > 1e-3) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

function wrap(angle: number): number {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}
