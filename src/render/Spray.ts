import * as THREE from 'three/webgpu';
import {
  float,
  hash,
  instanceIndex,
  instancedDynamicBufferAttribute,
  length,
  mix,
  smoothstep,
  step,
  uniform,
  uv,
} from 'three/tsl';

/** Puffs in the pool; when it is full the oldest are reused. */
const POOL = 900;
/** Puffs per second from a car at full speed in heavy rain. */
const RATE = 90;
/** Speed at which a car starts throwing up water, and where the spray is at its fullest, m/s. */
const MIN_SPEED = 6;
const FULL_SPEED = 55;
/** Puffs start this far behind the car's centre, spread across its rear track. */
const REAR = 2.1;
const HALF_TRACK = 0.8;
/** Lifetime range, seconds. */
const LIFE_MIN = 0.55;
const LIFE_MAX = 1.05;
/** Puff size (metres across) at birth and at the end of its life. */
const SIZE_START = 0.7;
const SIZE_END = 3.4;
/** How quickly a puff loses the speed the car gave it (1/s), and settles (m/s²). */
const DRAG = 2.6;
const GRAVITY = 2.2;

/**
 * Water thrown up behind cars on a wet track: soft camera-facing puffs from one pool, drawn in
 * one instanced call. Each frame the caller emits for every car (`emit`) and ages the pool
 * (`update`); only one small buffer is uploaded, and nothing is allocated.
 */
export class Spray {
  readonly mesh: THREE.Mesh;
  /** 0 dry (no spray) … 1 soaked. */
  wetness = 0;
  private readonly material = new THREE.SpriteNodeMaterial();
  /** Per puff: position (x, y, z) and age as a fraction of its life (≥ 1 = dead). */
  private readonly state = new Float32Array(POOL * 4);
  private readonly attribute = new THREE.InstancedBufferAttribute(this.state, 4);
  private readonly velocity = new Float32Array(POOL * 3);
  private readonly life = new Float32Array(POOL);
  private readonly u = {
    color: uniform(new THREE.Color(0.75, 0.77, 0.8)),
    opacity: uniform(0.3),
  };
  private next = 0;
  private alive = 0;
  private dt = 1 / 60;

  constructor() {
    for (let i = 0; i < POOL; i++) this.state[i * 4 + 3] = 1;
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    const puff = instancedDynamicBufferAttribute<'vec4'>(this.attribute, 'vec4');
    const age = puff.w;
    const living = step(age, 0.999);
    // Each puff a little different in size.
    const variety = mix(0.75, 1.25, hash(instanceIndex));
    const m = this.material;
    m.positionNode = puff.xyz;
    m.scaleNode = mix(SIZE_START, SIZE_END, age.sqrt()).mul(variety).mul(living);
    const d = length(uv().sub(0.5)).mul(2);
    const blob = smoothstep(1, 0.15, d);
    const fade = float(1)
      .sub(age)
      .mul(smoothstep(0, 0.12, age));
    m.colorNode = this.u.color;
    m.opacityNode = blob.mul(fade).mul(this.u.opacity);
    m.transparent = true;
    m.depthWrite = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
    this.mesh.count = POOL;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = 3;
  }

  /** Colour the spray takes from the light, and how thick it looks. */
  setLook(color: THREE.Color, opacity: number): void {
    this.u.color.value.copy(color);
    this.u.opacity.value = opacity;
  }

  /**
   * Throws up water behind a car: (x, y, z) is its centre, (vx, vz) its velocity in m/s. Call once
   * per car per frame; it does nothing on a dry track or at low speed.
   */
  emit(x: number, y: number, z: number, vx: number, vz: number): void {
    if (this.wetness <= 0) return;
    const speed = Math.hypot(vx, vz);
    if (speed < MIN_SPEED) return;
    const strength = Math.min((speed - MIN_SPEED) / (FULL_SPEED - MIN_SPEED), 1.3);
    const wanted = RATE * strength * this.wetness * this.dt;
    let count = Math.floor(wanted + Math.random());
    const fx = vx / speed;
    const fz = vz / speed;
    while (count-- > 0) {
      const i = this.next;
      this.next = (this.next + 1) % POOL;
      if (this.state[i * 4 + 3]! >= 1) this.alive++;
      // Off one of the rear tyres, somewhere across its width.
      const across = (Math.random() < 0.5 ? -1 : 1) * HALF_TRACK + (Math.random() - 0.5) * 0.5;
      const back = REAR + Math.random() * 0.6;
      this.state[i * 4] = x - fx * back - fz * across;
      this.state[i * 4 + 1] = y - 0.1 + Math.random() * 0.25;
      this.state[i * 4 + 2] = z - fz * back + fx * across;
      this.state[i * 4 + 3] = 0;
      // Carried along behind the car, kicked up and out.
      const carry = 0.45 + Math.random() * 0.25;
      const out = (Math.random() - 0.5) * 3 + Math.sign(across) * 0.8;
      this.velocity[i * 3] = vx * carry - fz * out;
      this.velocity[i * 3 + 1] = 1 + Math.random() * 2;
      this.velocity[i * 3 + 2] = vz * carry + fx * out;
      this.life[i] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    }
    this.mesh.visible = this.alive > 0;
  }

  /** Ages and moves the puffs. */
  update(dt: number): void {
    this.dt = Math.min(Math.max(dt, 0), 0.1);
    if (this.alive === 0) {
      this.mesh.visible = false;
      return;
    }
    const drag = Math.exp(-DRAG * this.dt);
    let alive = 0;
    for (let i = 0; i < POOL; i++) {
      const a = i * 4;
      if (this.state[a + 3]! >= 1) continue;
      const age = this.state[a + 3]! + this.dt / this.life[i]!;
      if (age >= 1) {
        this.state[a + 3] = 1;
        continue;
      }
      alive++;
      const v = i * 3;
      this.velocity[v] = this.velocity[v]! * drag;
      this.velocity[v + 1] = this.velocity[v + 1]! * drag - GRAVITY * this.dt;
      this.velocity[v + 2] = this.velocity[v + 2]! * drag;
      this.state[a] = this.state[a]! + this.velocity[v]! * this.dt;
      this.state[a + 1] = Math.max(this.state[a + 1]! + this.velocity[v + 1]! * this.dt, 0.2);
      this.state[a + 2] = this.state[a + 2]! + this.velocity[v + 2]! * this.dt;
      this.state[a + 3] = age;
    }
    this.alive = alive;
    this.attribute.needsUpdate = true;
    this.mesh.visible = alive > 0;
  }

  /** Clears every puff (e.g. when the weather dries up). */
  clear(): void {
    for (let i = 0; i < POOL; i++) this.state[i * 4 + 3] = 1;
    this.alive = 0;
    this.attribute.needsUpdate = true;
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
