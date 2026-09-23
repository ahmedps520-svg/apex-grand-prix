import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  clamp,
  cross,
  float,
  hash,
  instanceIndex,
  length,
  max,
  min,
  mix,
  mod,
  normalize,
  positionGeometry,
  screenSize,
  smoothstep,
  uniform,
  vec3,
  vertexStage,
} from 'three/tsl';

/** Most drops drawn (heavy rain); lighter rain draws fewer of the same instances. */
const MAX_DROPS = 7000;
/** The box of drops around the camera, metres: across, up, along. */
const BOX_X = 44;
const BOX_Y = 22;
const BOX_Z = 44;
/** How far ahead of the camera the box is centred (drops behind it are wasted). */
const AHEAD = 12;
/** Fall speed, m/s. */
const FALL = 9.5;
/**
 * Seconds of motion a streak shows: a camera's motion blur. Streaks at speed get longer and slant
 * towards the camera, like rain seen from a moving car.
 */
const EXPOSURE = 1 / 20;
const MAX_STREAK = 3;
/** A camera that jumps further than this in a frame has cut to another shot. */
const CUT_DISTANCE = 12;
/** Wraps the fall clock so its precision never degrades (a brief reshuffle once an hour). */
const CLOCK_PERIOD = 3600;

/**
 * Falling rain as thin streaks: one instanced draw of up to 7,000 quads. Every drop is placed in
 * the vertex shader from its instance number and a clock, wrapped into a box that moves with the
 * camera (so drops stay put in the world while the camera flies through them). Each streak runs
 * along the drop's motion relative to the camera, and is turned to face it and kept about a
 * pixel wide at any distance. No per-frame CPU work beyond a few uniforms.
 */
export class Rain {
  readonly mesh: THREE.Mesh;
  private readonly material = new THREE.MeshBasicNodeMaterial();
  private readonly u = {
    clock: uniform(0),
    /** Box centre relative to the camera. */
    offset: uniform(new THREE.Vector3(0, 4, 0)),
    cameraVelocity: uniform(new THREE.Vector3()),
    wind: uniform(new THREE.Vector3()),
    /** Tangent of half the camera's vertical field of view (for the streak width). */
    tanHalfFov: uniform(Math.tan(THREE.MathUtils.degToRad(31))),
    opacity: uniform(0.3),
    color: uniform(new THREE.Color(0.7, 0.72, 0.76)),
  };
  private readonly lastCamera = new THREE.Vector3();
  private readonly cameraVelocity = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private hasLast = false;
  private clock = 0;

  constructor() {
    // A unit quad: x across the streak (-0.5 … 0.5), y along it from the drop (0) to its tail (1).
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([-0.5, 0, 0, 0.5, 0, 0, -0.5, 1, 0, 0.5, 1, 0], 3),
    );
    geometry.setIndex([0, 1, 2, 2, 1, 3]);
    this.buildNodes();
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.count = 0;
    this.mesh.visible = false;
    // Placed in the shader, round whatever camera draws it.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.renderOrder = 3;
  }

  /**
   * How hard it rains (0 none … 1 heavy), the colour the streaks catch from the sky, and the wind
   * (m/s, blowing towards +x/+z).
   */
  set(intensity: number, color: THREE.Color, windX = 0, windZ = 0): void {
    const k = THREE.MathUtils.clamp(intensity, 0, 1);
    this.mesh.count = Math.round(MAX_DROPS * (0.35 + 0.65 * k) * (k > 0 ? 1 : 0));
    this.mesh.visible = this.mesh.count > 0;
    this.u.opacity.value = 0.2 + 0.12 * k;
    this.u.color.value.copy(color);
    this.u.wind.value.set(windX, 0, windZ);
  }

  /** Advances the fall and follows `camera` (its motion slants the streaks). */
  update(dt: number, camera: THREE.Camera): void {
    if (!this.mesh.visible) {
      this.hasLast = false;
      return;
    }
    this.clock = (this.clock + dt) % CLOCK_PERIOD;
    this.u.clock.value = this.clock;
    const position = camera.getWorldPosition(this.position);
    if (this.hasLast && dt > 0 && position.distanceTo(this.lastCamera) < CUT_DISTANCE) {
      const k = 1 - Math.exp(-dt * 12);
      this.cameraVelocity.x += ((position.x - this.lastCamera.x) / dt - this.cameraVelocity.x) * k;
      this.cameraVelocity.y += ((position.y - this.lastCamera.y) / dt - this.cameraVelocity.y) * k;
      this.cameraVelocity.z += ((position.z - this.lastCamera.z) / dt - this.cameraVelocity.z) * k;
    } else this.cameraVelocity.set(0, 0, 0);
    this.lastCamera.copy(position);
    this.hasLast = true;
    this.u.cameraVelocity.value.copy(this.cameraVelocity);

    // Centre the box a little ahead of the camera, level.
    camera.getWorldDirection(this.forward);
    this.forward.y = 0;
    if (this.forward.lengthSq() > 1e-6) this.forward.normalize();
    this.u.offset.value.set(this.forward.x * AHEAD, BOX_Y * 0.22, this.forward.z * AHEAD);

    if (camera instanceof THREE.PerspectiveCamera) {
      this.u.tanHalfFov.value = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    }
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }

  private buildNodes(): void {
    const u = this.u;
    const box = vec3(BOX_X, BOX_Y, BOX_Z);
    const seed = instanceIndex.mul(4);
    const rx = hash(seed);
    const ry = hash(seed.add(1));
    const rz = hash(seed.add(2));
    const rs = hash(seed.add(3));

    // Where the drop is now: a fixed spot in a repeating box, falling, wrapped round the camera.
    const velocity = vec3(u.wind.x, float(-FALL).mul(mix(0.85, 1.15, rs)), u.wind.z);
    const origin = vec3(rx, ry, rz).mul(box);
    const centre = cameraPosition.add(u.offset);
    const drifted = origin.add(velocity.mul(u.clock));
    const rel = mod(drifted.sub(centre).add(box.mul(0.5)), box).sub(box.mul(0.5));
    const head = centre.add(rel);

    // The streak: back along the motion relative to the camera.
    const relative = velocity.sub(u.cameraVelocity);
    const dir = normalize(relative.add(vec3(0, -1e-3, 0)));
    const streak = clamp(length(relative).mul(EXPOSURE), 0.25, MAX_STREAK);
    const point = head.sub(dir.mul(streak.mul(positionGeometry.y)));
    const toCamera = cameraPosition.sub(point);
    const distance = length(toCamera);
    // (Nudged so a drop coming straight at the camera still has a side.)
    const side = normalize(cross(dir, toCamera).add(vec3(1e-4, 0, 1e-4)));
    // About 1.3 pixels wide at any distance.
    const pixel = u.tanHalfFov.mul(2).div(screenSize.y);
    const width = max(distance.mul(pixel).mul(1.3), 0.003);
    this.material.positionNode = point.add(side.mul(positionGeometry.x.mul(width)));

    // Fade out towards the box's walls (no popping as drops wrap round) and right by the lens.
    const edge = max(
      max(rel.x.abs().div(BOX_X / 2), rel.y.abs().div(BOX_Y / 2)),
      rel.z.abs().div(BOX_Z / 2),
    );
    const fade = vertexStage(
      float(1)
        .sub(smoothstep(0.72, 1, edge))
        .mul(smoothstep(0.8, 2.5, distance))
        // A long streak spreads the same drop over more pixels.
        .mul(min(float(1), float(1.1).div(streak))),
    );
    const along = positionGeometry.y;
    const across = positionGeometry.x.abs().mul(2);
    const shape = smoothstep(0, 0.25, along)
      .mul(smoothstep(1, 0.55, along))
      .mul(float(1).sub(across.mul(across)));
    this.material.colorNode = u.color;
    this.material.opacityNode = shape.mul(fade).mul(u.opacity);
    this.material.transparent = true;
    this.material.depthWrite = false;
    this.material.fog = false;
    // Streaks turn to face the camera but either winding can face it; one pass either way.
    this.material.side = THREE.DoubleSide;
    this.material.forceSinglePass = true;
  }
}
