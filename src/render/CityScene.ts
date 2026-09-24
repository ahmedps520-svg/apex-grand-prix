import {
  color,
  hash,
  instanceIndex,
  mix,
  normalWorld,
  positionWorld,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import type { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import {
  CHUNK,
  DECK_HEIGHT,
  SIDEWALK,
  cellKey,
  type CityMap,
  type Junction,
  type Lot,
  type RoadPiece,
} from '../content/city/map';
import {
  MAP_MAX_X,
  MAP_MAX_Z,
  MAP_MIN_X,
  MAP_MIN_Z,
  WATER_X,
  WATER_Y,
  districtAt,
} from '../content/city/terrain';
import { signalState } from '../content/city/lanes';
import { DEFAULT_CONDITIONS, type Conditions, darkness } from '../content/conditions';
import { mulberry32 } from '../shared/math';
import type { TrackTheme } from '../sim/track/Track';
import { Atmosphere } from './Atmosphere';
import { Rain } from './Rain';
import { sceneLook, type SceneLook } from './sceneLook';
import type { ConePlacement } from './TestGroundScene';
import { asphaltTexture, glowTexture, turfTexture } from './textures';
import { MeshBuilder } from './trackMeshes';

/**
 * The open world's scenery, streamed in 250 m chunks around the car: the ground (a height
 * field with the roads cut in), the roads with their markings and pavements, the orbital's
 * deck on pillars with barriers, buildings (downtown's skyline is always drawn; houses,
 * warehouses and containers come with their chunks), street lights, signals, signs, trees and
 * the sea past the quay. Sun, sky, fog and rain come from the same atmosphere as the circuits;
 * at night the sky goes dark and the windows and lamps come on.
 *
 * Honest limits: a browser can't draw a whole city, so how far the chunks reach (and whether
 * props are drawn) comes from the detail level; the fog hides where the streaming stops.
 */

export interface DetailLevel {
  /** Chunks kept around the car in each direction. */
  chunks: number;
  shadowMap: number;
  /** Street lights, signals, signs. */
  props: boolean;
}

export const DETAIL_LEVELS: Readonly<Record<'low' | 'medium' | 'high', DetailLevel>> = {
  low: { chunks: 2, shadowMap: 1024, props: false },
  medium: { chunks: 3, shadowMap: 2048, props: true },
  high: { chunks: 4, shadowMap: 2048, props: true },
};

/** Picks a detail level for this device (cores, memory, a phone or tablet). */
export function detectDetail(): DetailLevel {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const cores = nav.hardwareConcurrency ?? 4;
  const memory = nav.deviceMemory ?? 8;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(nav.userAgent);
  if (mobile || cores <= 4 || memory <= 4) return DETAIL_LEVELS.low;
  if (cores >= 8 && memory >= 8) return DETAIL_LEVELS.high;
  return DETAIL_LEVELS.medium;
}

const CITY_THEME: TrackTheme = {
  grass: 0x5d8a45,
  runoffSurface: 'grass',
  sunElevation: 38,
  sunAzimuth: 215,
  fog: 0xc9d3dd,
  trees: 0,
  barrier: 0x8a8f96,
};

const SHADOW_EXTENT = 42;
const ROAD_Y = 0.02;
const LINE_Y = 0.035;
const WALK_Y = 0.1;
const TERRAIN_STEPS = 20;
/** Chunks built per frame at most (a build is a few milliseconds). */
const BUILDS_PER_FRAME = 1;

export class CityScene {
  readonly scene = new THREE.Scene();
  readonly conePlacements: ConePlacement[] = [];
  readonly obstacles: ReadonlyArray<{ x: number; z: number; r: number }> = [];
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly atmosphere = new Atmosphere();
  private readonly sky: SkyMesh;
  private readonly sunDirection = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly followed = new THREE.Vector3();
  private readonly rain = new Rain();
  private readonly chunks = new Map<
    number,
    { group: THREE.Group; disposables: THREE.BufferGeometry[] }
  >();
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** 1 at night: windows, lamps and glows come on. */
  private readonly night = uniform(0);
  private readonly mat: {
    ground: THREE.MeshStandardMaterial;
    road: THREE.MeshStandardMaterial;
    walk: THREE.MeshStandardMaterial;
    concrete: THREE.MeshStandardMaterial;
    white: THREE.MeshBasicMaterial;
    yellow: THREE.MeshBasicMaterial;
    building: THREE.MeshStandardNodeMaterial;
    house: THREE.MeshStandardNodeMaterial;
    container: THREE.MeshStandardNodeMaterial;
    steel: THREE.MeshStandardMaterial;
    pole: THREE.MeshStandardMaterial;
    glow: THREE.MeshBasicNodeMaterial;
    trunk: THREE.MeshStandardMaterial;
    pine: THREE.MeshStandardMaterial;
    leafy: THREE.MeshStandardMaterial;
    water: THREE.MeshStandardMaterial;
    sign: THREE.MeshStandardMaterial;
  };
  private readonly geo: {
    box: THREE.BoxGeometry;
    lamp: THREE.BufferGeometry;
    signal: THREE.BufferGeometry;
    stop: THREE.BufferGeometry;
    trunk: THREE.BufferGeometry;
    pine: THREE.BufferGeometry;
    leafy: THREE.BufferGeometry;
    pillar: THREE.BufferGeometry;
  };
  private current: Conditions;
  private look: SceneLook;
  /** Signal lamps (red, amber, green) at every signalled junction, lit by the sim time. */
  private readonly signalLamps: THREE.InstancedMesh[] = [];
  private readonly signalHeads: Array<{
    x: number;
    y: number;
    z: number;
    axis: 0 | 1;
    node: { x: number; z: number };
  }> = [];
  private simTime = 0;
  private renderer: THREE.WebGPURenderer | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.RenderTarget | null = null;
  private envSky: SkyMesh | null = null;

  constructor(
    readonly map: CityMap,
    conditions: Conditions = DEFAULT_CONDITIONS,
    readonly detail: DetailLevel = DETAIL_LEVELS.medium,
  ) {
    this.current = { ...conditions };
    this.look = this.makeLook();

    this.sky = this.atmosphere.createSky();
    this.scene.add(this.sky);
    (this.scene as { fogNode?: THREE.Node }).fogNode = this.atmosphere.createFog();

    this.hemi = new THREE.HemisphereLight();
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(detail.shadowMap, detail.shadowMap);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 500;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    this.mat = this.buildMaterials();
    this.geo = this.buildGeometries();
    this.buildSkyline();
    this.buildWater();
    this.buildSignals();
    this.scene.add(this.rain.mesh);
    this.disposables.push(this.atmosphere, this.rain);
    this.applyLook();
  }

  get conditions(): Readonly<Conditions> {
    return this.current;
  }

  setConditions(conditions: Conditions): void {
    this.current = { ...conditions };
    this.look = this.makeLook();
    this.applyLook();
    this.renderEnvironment();
  }

  buildEnvironment(renderer: THREE.WebGPURenderer): void {
    this.renderer = renderer;
    this.renderEnvironment();
  }

  /** Keeps the shadow light, the sky box and the streamed chunks centred on the car. */
  follow(target: THREE.Vector3): void {
    this.followed.copy(target);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.lightDirection, 150);
    this.sun.target.updateMatrixWorld();
    this.sky.position.set(target.x, 0, target.z);
  }

  /** The simulation's clock, which the signals run on (the same one the traffic obeys). */
  setTime(time: number): void {
    this.simTime = time;
  }

  /** Per frame: streams chunks around the followed point, lights the signals, moves the rain. */
  update(dt: number, camera: THREE.Camera): void {
    this.stream();
    this.updateSignals();
    this.rain.update(dt, camera);
  }

  /** Circuits throw up spray; the city keeps it simple. */
  spray(): void {}

  setStartLights(): void {}

  dispose(): void {
    for (const key of [...this.chunks.keys()]) this.dropChunk(key);
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of Object.values(this.mat)) m.dispose();
    for (const g of Object.values(this.geo)) g.dispose();
    for (const d of this.disposables) d.dispose();
    this.atmosphere.disposeSky(this.sky);
    if (this.envSky) this.atmosphere.disposeSky(this.envSky);
    this.envTarget?.dispose();
    this.pmrem?.dispose();
  }

  // ---------------------------------------------------------------- look

  private makeLook(): SceneLook {
    const look = sceneLook(CITY_THEME, this.current);
    // The fog closes in where the streaming stops.
    const reach = this.detail.chunks * CHUNK;
    look.fogNear = Math.min(look.fogNear, reach * 0.55);
    look.fogFar = Math.min(look.fogFar, reach + 200);
    return look;
  }

  private applyLook(): void {
    const look = this.look;
    const toward = (out: THREE.Vector3, elevationDeg: number) => {
      const elevation = THREE.MathUtils.degToRad(elevationDeg);
      const azimuth = THREE.MathUtils.degToRad(look.sunAzimuth);
      return out.set(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
      );
    };
    toward(this.sunDirection, look.sunElevation);
    toward(this.lightDirection, look.lightElevation);
    this.atmosphere.set(look, this.sunDirection);
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.sun.color.copy(look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.sun.shadow.radius = look.shadowRadius;
    this.sun.shadow.intensity = look.shadowIntensity;
    this.scene.environmentIntensity = look.environmentIntensity;
    const time = this.current.time;
    this.night.value = darkness(time);
    this.rain.set(look.rain, look.waterColor, 1.4, 0.6);
    const wet = look.wetness;
    this.mat.road.roughness = THREE.MathUtils.lerp(0.92, 0.35, wet);
    this.mat.road.color.setScalar(THREE.MathUtils.lerp(1, 0.6, wet));
  }

  private renderEnvironment(): void {
    const renderer = this.renderer;
    if (!renderer) return;
    try {
      this.pmrem ??= new THREE.PMREMGenerator(renderer);
      if (this.envSky) this.atmosphere.disposeSky(this.envSky);
      const envScene = new THREE.Scene();
      this.envSky = this.atmosphere.createSky(true);
      envScene.add(this.envSky);
      const target = this.pmrem.fromScene(envScene, 0.02, 0.1, 100, {
        renderTarget: this.envTarget,
      });
      this.envTarget = target;
      this.scene.environment = target.texture;
      this.scene.environmentIntensity = this.look.environmentIntensity;
    } catch (error) {
      console.warn('Environment map unavailable; continuing without reflections.', error);
    }
  }

  // ---------------------------------------------------------------- materials

  private buildMaterials(): CityScene['mat'] {
    const turf = turfTexture();
    const asphalt = asphaltTexture(1, 1);
    const windows = windowTexture();
    const siding = windowTexture(0xd9d2c4, 2);
    this.disposables.push(turf, asphalt, windows.map, windows.lit, siding.map, siding.lit);
    const night = this.night;

    // Facades: windows sized from the world position, so every building's floors match; a
    // roof colour on top faces; a tint per building; some windows lit at night.
    const facade = (
      tex: { map: THREE.Texture; lit: THREE.Texture },
      cellW: number,
      floor: number,
      a: number,
      b: number,
    ) => {
      const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0.05 });
      const uvNode = vec2(
        positionWorld.x.add(positionWorld.z).mul(1 / cellW),
        positionWorld.y.mul(1 / floor),
      );
      const sample = texture(tex.map, uvNode);
      const lit = texture(tex.lit, uvNode).r;
      const tint = mix(color(a), color(b), hash(instanceIndex.add(3)));
      const roof = step(0.5, normalWorld.y);
      m.colorNode = mix(sample.rgb.mul(tint), color(0x3a3d43), roof);
      m.emissiveNode = lit.mul(night).mul(roof.oneMinus()).mul(color(0xffcf8a)).mul(1.4);
      return m;
    };
    const container = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.3 });
    {
      const h = hash(instanceIndex.add(11));
      const c = mix(
        mix(color(0xb8312f), color(0x2f6fb8), step(0.25, h)),
        mix(color(0x3f9a4a), color(0xd9a520), step(0.75, h)),
        step(0.5, h),
      );
      container.colorNode = c;
    }
    const glow = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    {
      const g = glowTexture();
      this.disposables.push(g);
      glow.colorNode = texture(g)
        .rgb.mul(vec3(1, 0.85, 0.6))
        .mul(night)
        .mul(1.6);
      glow.opacityNode = texture(g).r.mul(night);
    }
    return {
      ground: new THREE.MeshStandardMaterial({ map: turf, vertexColors: true, roughness: 1 }),
      road: new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.92, color: 0xffffff }),
      walk: new THREE.MeshStandardMaterial({ color: 0xa9aaa6, roughness: 0.95 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0x8f9296, roughness: 0.85 }),
      white: new THREE.MeshBasicMaterial({ color: 0xe8e8e2 }),
      yellow: new THREE.MeshBasicMaterial({ color: 0xe0b52a }),
      building: facade(windows, 3, 3.2, 0x7d8590, 0xc6bfb1),
      house: facade(siding, 2.5, 2.8, 0xd6cbb6, 0xb9a48e),
      container,
      steel: new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.5, metalness: 0.4 }),
      pole: new THREE.MeshStandardMaterial({ color: 0x4b4f55, roughness: 0.6, metalness: 0.5 }),
      glow,
      trunk: new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 }),
      pine: new THREE.MeshStandardMaterial({ color: 0x2f5a35, roughness: 0.95 }),
      leafy: new THREE.MeshStandardMaterial({ color: 0x4f8a3c, roughness: 0.95 }),
      water: new THREE.MeshStandardMaterial({
        color: 0x1f4f74,
        roughness: 0.12,
        metalness: 0.1,
        transparent: true,
        opacity: 0.94,
      }),
      sign: new THREE.MeshStandardMaterial({ color: 0xc8302a, roughness: 0.5 }),
    };
  }

  private buildGeometries(): CityScene['geo'] {
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const lamp = mergeGeometries([
      new THREE.CylinderGeometry(0.09, 0.14, 8, 6).translate(0, 4, 0),
      new THREE.BoxGeometry(1.6, 0.12, 0.12).translate(0.7, 8, 0),
      new THREE.BoxGeometry(0.6, 0.18, 0.3).translate(1.4, 7.95, 0),
    ])!;
    const signal = mergeGeometries([
      new THREE.CylinderGeometry(0.08, 0.1, 5, 6).translate(0, 2.5, 0),
      new THREE.BoxGeometry(0.32, 1, 0.3).translate(0, 5, 0),
    ])!;
    const stop = mergeGeometries([
      new THREE.CylinderGeometry(0.04, 0.05, 2.4, 5).translate(0, 1.2, 0),
      new THREE.CylinderGeometry(0.45, 0.45, 0.04, 8).rotateX(Math.PI / 2).translate(0, 2.4, 0),
    ])!;
    return {
      box,
      lamp,
      signal,
      stop,
      trunk: new THREE.CylinderGeometry(0.2, 0.32, 3.2, 5, 1, true).translate(0, 1.6, 0),
      pine: mergeGeometries([
        new THREE.ConeGeometry(2.3, 5.2, 7).translate(0, 4.6, 0),
        new THREE.ConeGeometry(1.6, 3.8, 7).translate(0, 7.4, 0),
      ])!,
      leafy: new THREE.IcosahedronGeometry(2.6, 1).scale(1, 0.9, 1).translate(0, 5, 0),
      pillar: new THREE.CylinderGeometry(1.1, 1.3, 1, 10).translate(0, 0.5, 0),
    };
  }

  // ---------------------------------------------------------------- always drawn

  /** Downtown's buildings in one instanced draw, so the skyline shows from anywhere. */
  private buildSkyline(): void {
    const lots = this.map.lots.filter(
      (l) => l.style === 'tower' || l.style === 'block' || l.style === 'shop',
    );
    const mesh = this.instances(this.geo.box, this.mat.building, lots);
    if (mesh) this.scene.add(mesh);
  }

  /**
   * A lamp head on each of a signalled junction's four poles: the far right-hand corner of an
   * approach shows that approach's signal (the corners on one diagonal serve the x axis, the
   * other diagonal the z axis). The lit lamp is drawn, the others sit dark in the head.
   */
  private buildSignals(): void {
    const junctions = this.map.junctions.filter((j) => j.control === 'signal');
    const geometry = new THREE.BoxGeometry(0.24, 0.24, 0.14);
    const colours = [0xff2a1a, 0xffb020, 0x2bff5a];
    for (const colour of colours) {
      const material = new THREE.MeshStandardMaterial({
        color: colour,
        emissive: colour,
        emissiveIntensity: 2.5,
      });
      const mesh = new THREE.InstancedMesh(geometry, material, Math.max(junctions.length * 4, 1));
      mesh.frustumCulled = false;
      this.signalLamps.push(mesh);
      this.scene.add(mesh);
    }
    for (const j of junctions) {
      const y = this.map.groundHeight(j.x, j.z);
      for (const [dx, dz] of [
        [1, 1],
        [-1, 1],
        [-1, -1],
        [1, -1],
      ] as const) {
        this.signalHeads.push({
          x: j.x + dx * 10.5 - dx * 0.17,
          z: j.z + dz * 10.5 - dz * 0.17,
          y: y + 5,
          axis: dx * dz > 0 ? 0 : 1,
          node: j,
        });
      }
    }
    this.updateSignals();
  }

  private updateSignals(): void {
    const m = new THREE.Matrix4();
    const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    const offsets = [0.34, 0, -0.34];
    for (let i = 0; i < this.signalHeads.length; i++) {
      const head = this.signalHeads[i]!;
      const state = signalState(head.node, head.axis, this.simTime);
      const lit = state === 'red' ? 0 : state === 'amber' ? 1 : 2;
      for (let c = 0; c < 3; c++) {
        const mesh = this.signalLamps[c]!;
        if (c === lit) mesh.setMatrixAt(i, m.makeTranslation(head.x, head.y + offsets[c]!, head.z));
        else mesh.setMatrixAt(i, hidden);
      }
    }
    for (const mesh of this.signalLamps) mesh.instanceMatrix.needsUpdate = true;
  }

  private buildWater(): void {
    const width = MAP_MAX_X + 600 - WATER_X;
    const length = MAP_MAX_Z - MAP_MIN_Z + 1200;
    const geometry = new THREE.PlaneGeometry(width, length)
      .rotateX(-Math.PI / 2)
      .translate(WATER_X + width / 2, WATER_Y, (MAP_MAX_Z + MAP_MIN_Z) / 2);
    const water = new THREE.Mesh(geometry, this.mat.water);
    water.receiveShadow = true;
    this.scene.add(water);
    // The quay wall.
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 1.4, 1100).translate(WATER_X - 0.6, 0.7, 0),
      this.mat.concrete,
    );
    this.scene.add(wall);
  }

  // ---------------------------------------------------------------- streaming

  private stream(): void {
    const reach = this.detail.chunks;
    const cx = Math.floor(this.followed.x / CHUNK);
    const cz = Math.floor(this.followed.z / CHUNK);
    // Drop what is out of reach.
    for (const [key, chunk] of this.chunks) {
      const { x, z } = chunk.group.userData as { x: number; z: number };
      if (Math.abs(x - cx) > reach + 1 || Math.abs(z - cz) > reach + 1) this.dropChunk(key);
    }
    // Build what is missing, nearest first, a little each frame.
    let built = 0;
    for (let ring = 0; ring <= reach && built < BUILDS_PER_FRAME; ring++) {
      for (let dx = -ring; dx <= ring && built < BUILDS_PER_FRAME; dx++) {
        for (let dz = -ring; dz <= ring && built < BUILDS_PER_FRAME; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const x = cx + dx;
          const z = cz + dz;
          if (!insideChunks(x, z)) continue;
          const key = cellKey(x, z);
          if (this.chunks.has(key)) continue;
          this.buildChunk(x, z);
          built++;
        }
      }
    }
  }

  private dropChunk(key: number): void {
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    chunk.group.removeFromParent();
    for (const g of chunk.disposables) g.dispose();
    this.chunks.delete(key);
  }

  private buildChunk(cx: number, cz: number): void {
    const group = new THREE.Group();
    group.userData = { x: cx, z: cz };
    const disposables: THREE.BufferGeometry[] = [];
    const keep = <G extends THREE.BufferGeometry>(g: G): G => {
      disposables.push(g);
      return g;
    };
    const x0 = cx * CHUNK;
    const z0 = cz * CHUNK;
    const rand = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ this.map.seed);

    // Ground.
    const ground = new THREE.Mesh(keep(this.terrain(x0, z0)), this.mat.ground);
    ground.receiveShadow = true;
    group.add(ground);

    // Roads whose pieces start in this chunk.
    const road = new MeshBuilder();
    const walk = new MeshBuilder();
    const white = new MeshBuilder();
    const yellow = new MeshBuilder();
    const concrete = new MeshBuilder();
    const pillars: THREE.Matrix4[] = [];
    for (const piece of this.map.pieces) {
      const mx = (piece.ax + piece.bx) / 2;
      const mz = (piece.az + piece.bz) / 2;
      if (mx < x0 || mx >= x0 + CHUNK || mz < z0 || mz >= z0 + CHUNK) continue;
      this.roadPiece(piece, road, walk, white, yellow, concrete, pillars);
    }
    const add = (b: MeshBuilder, material: THREE.Material, shadow: boolean) => {
      const geometry = b.build();
      if (geometry.getAttribute('position').count === 0) {
        geometry.dispose();
        return;
      }
      const mesh = new THREE.Mesh(keep(geometry), material);
      mesh.receiveShadow = shadow;
      mesh.castShadow = shadow && material === this.mat.concrete;
      group.add(mesh);
    };
    add(road, this.mat.road, true);
    add(walk, this.mat.walk, true);
    add(concrete, this.mat.concrete, true);
    add(white, this.mat.white, false);
    add(yellow, this.mat.yellow, false);
    if (pillars.length > 0) {
      const mesh = new THREE.InstancedMesh(this.geo.pillar, this.mat.concrete, pillars.length);
      pillars.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = true;
      group.add(mesh);
    }

    // Buildings and props that live in this chunk.
    const lots = this.map.lotsInChunk(cx, cz).filter((l) => {
      const own = Math.floor(l.x / CHUNK) === cx && Math.floor(l.z / CHUNK) === cz;
      return own && l.style !== 'tower' && l.style !== 'block' && l.style !== 'shop';
    });
    const houses = this.instances(
      this.geo.box,
      this.mat.house,
      lots.filter((l) => l.style === 'house'),
    );
    if (houses) group.add(houses);
    const sheds = this.instances(
      this.geo.box,
      this.mat.concrete,
      lots.filter((l) => l.style === 'warehouse'),
    );
    if (sheds) group.add(sheds);
    const boxes = this.instances(
      this.geo.box,
      this.mat.container,
      lots.filter((l) => l.style === 'container'),
    );
    if (boxes) group.add(boxes);
    for (const crane of lots.filter((l) => l.style === 'crane')) {
      group.add(new THREE.Mesh(keep(craneGeometry(crane)), this.mat.steel));
    }
    if (this.detail.props) this.props(x0, z0, group);
    this.trees(x0, z0, rand, group, lots);

    this.scene.add(group);
    this.chunks.set(cellKey(cx, cz), { group, disposables });
  }

  /** The chunk's ground: a grid displaced by the height field, coloured by what covers it. */
  private terrain(x0: number, z0: number): THREE.BufferGeometry {
    const b = new MeshBuilder(true);
    const n = TERRAIN_STEPS;
    const step = CHUNK / n;
    const map = this.map;
    const grass = new THREE.Color(CITY_THEME.grass);
    const paved = new THREE.Color(0x6f7276);
    const yard = new THREE.Color(0x85878a);
    const sand = new THREE.Color(0x9c8f6a);
    const rock = new THREE.Color(0x7a7268);
    const c = new THREE.Color();
    for (let iz = 0; iz <= n; iz++) {
      for (let ix = 0; ix <= n; ix++) {
        const x = x0 + ix * step;
        const z = z0 + iz * step;
        const y = map.groundHeight(x, z);
        const e = 1;
        const sx = map.groundHeight(x + e, z) - map.groundHeight(x - e, z);
        const sz = map.groundHeight(x, z + e) - map.groundHeight(x, z - e);
        const len = Math.hypot(sx / 2, 1, sz / 2);
        const district = districtAt(x, z);
        if (district === 'water') c.copy(sand);
        else if (district === 'port') c.copy(yard);
        else if (map.paved(x, z)) c.copy(paved);
        else {
          const slope = Math.min(Math.hypot(sx, sz) / 2, 1);
          c.copy(grass)
            .offsetHSL(0, 0, (Math.sin(x * 0.021) * Math.sin(z * 0.017) - 0.2) * 0.06)
            .lerp(rock, slope * 0.8);
        }
        b.vertex(x, y, z, -sx / 2 / len, 1 / len, -sz / 2 / len, x / 9, z / 9, c);
      }
    }
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const a = iz * (n + 1) + ix;
        b.quad(a, a + n + 1, a + n + 2, a + 1);
      }
    }
    return b.build();
  }

  /** One piece of road: the surface, its pavements or deck slab, markings, pillars. */
  private roadPiece(
    p: RoadPiece,
    road: MeshBuilder,
    walk: MeshBuilder,
    white: MeshBuilder,
    yellow: MeshBuilder,
    concrete: MeshBuilder,
    pillars: THREE.Matrix4[],
  ): void {
    const kind = p.road.kind;
    const elevated = p.road.elevated;
    const rx = -p.tz;
    const rz = p.tx;
    const hw = p.halfWidth;
    const lift = elevated ? 0 : ROAD_Y;
    // Ground roads sit on the ground; decks carry their own height.
    const yAt = (t: number, off: number) =>
      (elevated
        ? p.ay + (p.by - p.ay) * t
        : this.map.groundHeight(
            p.ax + p.tx * p.len * t + rx * off,
            p.az + p.tz * p.len * t + rz * off,
          )) + lift;
    const strip = (
      b: MeshBuilder,
      from: number,
      to: number,
      y: number,
      u0: number,
      u1: number,
      t0 = 0,
      t1 = 1,
    ) => {
      const ax = p.ax + p.tx * p.len * t0;
      const az = p.az + p.tz * p.len * t0;
      const bx = p.ax + p.tx * p.len * t1;
      const bz = p.az + p.tz * p.len * t1;
      const s0 = p.s0 + p.len * t0;
      const s1 = p.s0 + p.len * t1;
      const a = b.vertex(ax + rx * from, yAt(t0, from) + y, az + rz * from, 0, 1, 0, u0, s0 / 6);
      const c = b.vertex(ax + rx * to, yAt(t0, to) + y, az + rz * to, 0, 1, 0, u1, s0 / 6);
      const d = b.vertex(bx + rx * to, yAt(t1, to) + y, bz + rz * to, 0, 1, 0, u1, s1 / 6);
      const e = b.vertex(bx + rx * from, yAt(t1, from) + y, bz + rz * from, 0, 1, 0, u0, s1 / 6);
      b.quad(a, e, d, c);
    };
    strip(road, -hw, hw, 0, 0, (hw * 2) / 6);

    const edge = (b: MeshBuilder, at: number, width = 0.12) =>
      strip(b, at - width / 2, at + width / 2, LINE_Y, 0, 1);
    const dashes = (b: MeshBuilder, at: number, width = 0.12) => {
      const period = 12;
      const on = 3;
      let s = Math.ceil(p.s0 / period) * period;
      while (s < p.s0 + p.len) {
        const t0 = Math.max((s - p.s0) / p.len, 0);
        const t1 = Math.min((s + on - p.s0) / p.len, 1);
        if (t1 > t0) strip(b, at - width / 2, at + width / 2, LINE_Y, 0, 1, t0, t1);
        s += period;
      }
    };

    // Pavements stop at the junction boxes (the piece straddling a junction has none).
    if ((kind === 'street' || kind === 'avenue') && !this.inJunction(p)) {
      strip(walk, -hw - SIDEWALK, -hw, WALK_Y, 0, 1);
      strip(walk, hw, hw + SIDEWALK, WALK_Y, 0, 1);
    }
    edge(white, -hw + 0.3);
    edge(white, hw - 0.3);
    if (kind === 'avenue') {
      edge(yellow, -0.15);
      edge(yellow, 0.15);
      dashes(white, -3.6);
      dashes(white, 3.6);
    } else if (kind === 'highway') {
      edge(white, -1.2);
      edge(white, 1.2);
      dashes(white, -4.9);
      dashes(white, 4.9);
      // Barriers along the edges and the median; the slab below; a pillar now and then.
      const rail = (at: number) => {
        strip(concrete, at - 0.25, at + 0.25, 0.9, 0, 1);
        strip(concrete, at - 0.25, at - 0.25, 0, 0, 1);
      };
      rail(-hw + 0.3);
      rail(hw - 0.3);
      rail(0);
      this.deckSides(p, concrete);
      if (Math.floor(p.s0 / 50) !== Math.floor((p.s0 + p.len) / 50)) {
        const mx = (p.ax + p.bx) / 2;
        const mz = (p.az + p.bz) / 2;
        const near = this.map.project(mx, mz, { level: false, maxDist: 16 });
        if (!near) {
          const y = this.map.groundHeight(mx, mz);
          pillars.push(
            new THREE.Matrix4().compose(
              new THREE.Vector3(mx, y, mz),
              new THREE.Quaternion(),
              new THREE.Vector3(1, DECK_HEIGHT - 1 - y, 1),
            ),
          );
        }
      }
    } else if (kind === 'ramp') {
      this.deckSides(p, concrete);
      strip(concrete, -hw - 0.25, -hw + 0.25, 0.9, 0, 1);
      strip(concrete, hw - 0.25, hw + 0.25, 0.9, 0, 1);
    } else if (kind !== 'circuit' && !p.road.oneWay) {
      dashes(yellow, 0);
    }
  }

  /** Whether a piece's middle lies inside a junction box. */
  private inJunction(p: RoadPiece): boolean {
    const mx = (p.ax + p.bx) / 2;
    const mz = (p.az + p.bz) / 2;
    for (const j of this.map.junctions) {
      if (Math.abs(j.x - mx) < 13 && Math.abs(j.z - mz) < 13) return true;
    }
    return false;
  }

  /** The slab under a deck: its underside and the two side faces. */
  private deckSides(p: RoadPiece, b: MeshBuilder): void {
    const rx = -p.tz;
    const rz = p.tx;
    const hw = p.halfWidth;
    const thick = 1;
    const corner = (t: number, off: number, down: number) => {
      const y = p.ay + (p.by - p.ay) * t - down;
      return [p.ax + p.tx * p.len * t + rx * off, y, p.az + p.tz * p.len * t + rz * off] as const;
    };
    const face = (
      a: readonly [number, number, number],
      c: readonly [number, number, number],
      d: readonly [number, number, number],
      e: readonly [number, number, number],
      nx: number,
      ny: number,
      nz: number,
    ) => {
      const i = b.vertex(a[0], a[1], a[2], nx, ny, nz);
      const j = b.vertex(c[0], c[1], c[2], nx, ny, nz);
      const k = b.vertex(d[0], d[1], d[2], nx, ny, nz);
      const l = b.vertex(e[0], e[1], e[2], nx, ny, nz);
      b.quad(i, j, k, l);
    };
    // Underside.
    face(
      corner(0, -hw, thick),
      corner(0, hw, thick),
      corner(1, hw, thick),
      corner(1, -hw, thick),
      0,
      -1,
      0,
    );
    // Sides.
    face(corner(0, hw, 0), corner(0, hw, thick), corner(1, hw, thick), corner(1, hw, 0), rx, 0, rz);
    face(
      corner(0, -hw, thick),
      corner(0, -hw, 0),
      corner(1, -hw, 0),
      corner(1, -hw, thick),
      -rx,
      0,
      -rz,
    );
  }

  /** Street lights, signals and stop signs in a chunk. */
  private props(x0: number, z0: number, group: THREE.Group): void {
    const lamps: THREE.Matrix4[] = [];
    const glows: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const up = new THREE.Vector3(0, 1, 0);
    for (const p of this.map.pieces) {
      const kind = p.road.kind;
      if (kind === 'highway' || kind === 'ramp' || kind === 'circuit' || kind === 'mountain')
        continue;
      // A lamp every 30 m along the road, alternating sides, at its pavement edge.
      let s = Math.ceil(p.s0 / 30) * 30;
      while (s < p.s0 + p.len) {
        const t = (s - p.s0) / p.len;
        const side = Math.floor(s / 30) % 2 === 0 ? 1 : -1;
        const off = (p.halfWidth + 1) * side;
        const x = p.ax + p.tx * p.len * t + -p.tz * off;
        const z = p.az + p.tz * p.len * t + p.tx * off;
        if (x >= x0 && x < x0 + CHUNK && z >= z0 && z < z0 + CHUNK) {
          const y = this.map.groundHeight(x, z);
          // The arm reaches over the road.
          const yaw = Math.atan2(-(-p.tz * side), -(p.tx * side)) + Math.PI / 2;
          position.set(x, y, z);
          rotation.setFromAxisAngle(up, yaw);
          lamps.push(new THREE.Matrix4().compose(position, rotation, one));
          position.set(x + -p.tz * -side * 1.4, y + 7.6, z + p.tx * -side * 1.4);
          // Two crossed upright quads per lamp, so the glow shows from every direction.
          for (const turn of [0, Math.PI / 2]) {
            glows.push(
              new THREE.Matrix4().compose(
                position,
                new THREE.Quaternion().setFromAxisAngle(up, yaw + turn),
                new THREE.Vector3(3, 3, 3),
              ),
            );
          }
        }
        s += 30;
      }
    }
    if (lamps.length > 0) {
      const mesh = new THREE.InstancedMesh(this.geo.lamp, this.mat.pole, lamps.length);
      lamps.forEach((m, i) => mesh.setMatrixAt(i, m));
      group.add(mesh);
      const glow = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        this.mat.glow,
        glows.length,
      );
      glows.forEach((m, i) => glow.setMatrixAt(i, m));
      glow.renderOrder = 3;
      group.add(glow);
    }
    // Signals and stop signs at the chunk's junctions.
    const signals: THREE.Matrix4[] = [];
    const stops: THREE.Matrix4[] = [];
    for (const j of this.map.junctions) {
      if (j.x < x0 || j.x >= x0 + CHUNK || j.z < z0 || j.z >= z0 + CHUNK) continue;
      if (j.control !== 'signal' && j.control !== 'stop') continue;
      this.junctionProps(j, j.control === 'signal' ? signals : stops);
    }
    const place = (
      matrices: THREE.Matrix4[],
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
    ) => {
      if (matrices.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      group.add(mesh);
    };
    place(signals, this.geo.signal, this.mat.pole);
    place(stops, this.geo.stop, this.mat.sign);
  }

  /** Four poles at a junction's corners, on the near-side pavement of each approach. */
  private junctionProps(j: Junction, out: THREE.Matrix4[]): void {
    const y = this.map.groundHeight(j.x, j.z);
    const one = new THREE.Vector3(1, 1, 1);
    for (const [dx, dz] of [
      [1, 1],
      [-1, 1],
      [-1, -1],
      [1, -1],
    ] as const) {
      const x = j.x + dx * 10.5;
      const z = j.z + dz * 10.5;
      out.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-dx, -dz)),
          one,
        ),
      );
    }
  }

  private trees(
    x0: number,
    z0: number,
    rand: () => number,
    group: THREE.Group,
    lots: readonly Lot[],
  ): void {
    const pines: THREE.Matrix4[] = [];
    const leafy: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const put = (x: number, z: number, pine: boolean, size: number) => {
      position.set(x, this.map.groundHeight(x, z), z);
      rotation.setFromAxisAngle(up, rand() * Math.PI * 2);
      scale.set(size, size * (0.85 + rand() * 0.4), size);
      (pine ? pines : leafy).push(new THREE.Matrix4().compose(position, rotation, scale));
    };
    const district = districtAt(x0 + CHUNK / 2, z0 + CHUNK / 2);
    const count =
      district === 'hills'
        ? 90
        : district === 'fields' || district === 'circuit'
          ? 45
          : district === 'downtown'
            ? 18
            : 0;
    for (let i = 0; i < count; i++) {
      const x = x0 + rand() * CHUNK;
      const z = z0 + rand() * CHUNK;
      if (districtAt(x, z) === 'water' || this.map.paved(x, z)) continue;
      const near = this.map.project(x, z, { maxDist: 30 });
      if (near && near.dist < near.piece.halfWidth + 10) continue;
      if (districtAt(x, z) === 'downtown' && Math.abs(x) < 450 && Math.abs(z) < 450) continue;
      put(x, z, district === 'hills' ? rand() < 0.8 : rand() < 0.3, 0.7 + rand() * 0.9);
    }
    // Gardens: a tree or two behind each house.
    for (const lot of lots) {
      if (lot.style !== 'house') continue;
      for (let k = 0; k < 2; k++) {
        if (rand() < 0.4) continue;
        const back = lot.d / 2 + 4 + rand() * 6;
        const along = (rand() - 0.5) * lot.w;
        const s = Math.sin(lot.yaw);
        const c = Math.cos(lot.yaw);
        const x = lot.x + along * c - -back * s;
        const z = lot.z + -(along * s) - back * c;
        if (this.map.paved(x, z)) continue;
        put(x, z, false, 0.5 + rand() * 0.6);
      }
    }
    const place = (
      matrices: THREE.Matrix4[],
      geometry: THREE.BufferGeometry,
      material: THREE.Material,
      shadow: boolean,
    ) => {
      if (matrices.length === 0) return;
      const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
      matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
      mesh.castShadow = shadow;
      group.add(mesh);
    };
    const all = [...pines, ...leafy];
    place(all, this.geo.trunk, this.mat.trunk, false);
    place(pines, this.geo.pine, this.mat.pine, true);
    place(leafy, this.geo.leafy, this.mat.leafy, true);
  }

  /** Instances of a unit box scaled to each lot (the box's origin is its base centre). */
  private instances(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    lots: readonly Lot[],
  ): THREE.InstancedMesh | null {
    if (lots.length === 0) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, lots.length);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const m = new THREE.Matrix4();
    lots.forEach((lot, i) => {
      position.set(lot.x, this.map.groundHeight(lot.x, lot.z) + lot.y, lot.z);
      rotation.setFromAxisAngle(up, lot.yaw);
      scale.set(lot.w, lot.height, lot.d);
      mesh.setMatrixAt(i, m.compose(position, rotation, scale));
    });
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}

function insideChunks(cx: number, cz: number): boolean {
  const x0 = cx * CHUNK;
  const z0 = cz * CHUNK;
  return x0 + CHUNK > MAP_MIN_X && x0 < MAP_MAX_X + 300 && z0 + CHUNK > MAP_MIN_Z && z0 < MAP_MAX_Z;
}

/** A gantry crane: two legs, a top beam, a boom out over the water. */
function craneGeometry(lot: Lot): THREE.BufferGeometry {
  const h = lot.height;
  const parts = [
    new THREE.BoxGeometry(2, h, 2).translate(-lot.w / 2 + 1, h / 2, -lot.d / 2 + 1),
    new THREE.BoxGeometry(2, h, 2).translate(lot.w / 2 - 1, h / 2, -lot.d / 2 + 1),
    new THREE.BoxGeometry(2, h, 2).translate(-lot.w / 2 + 1, h / 2, lot.d / 2 - 1),
    new THREE.BoxGeometry(2, h, 2).translate(lot.w / 2 - 1, h / 2, lot.d / 2 - 1),
    new THREE.BoxGeometry(lot.w + 40, 2.2, 2.2).translate(14, h + 1, -lot.d / 2 + 1),
    new THREE.BoxGeometry(lot.w + 40, 2.2, 2.2).translate(14, h + 1, lot.d / 2 - 1),
    new THREE.BoxGeometry(2.2, 2.2, lot.d).translate(lot.w / 2 + 19, h + 1, 0),
  ];
  const merged = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return merged.translate(lot.x, 0, lot.z);
}

/**
 * Facade textures: a grid of dark windows on a wall colour (`map`), and a mask of the windows
 * that are lit at night (`lit`, white where they are), which the shader turns into light.
 */
function windowTexture(
  wall = 0x9aa0a8,
  rows = 4,
): { map: THREE.CanvasTexture; lit: THREE.CanvasTexture } {
  const size = 256;
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return [canvas, canvas.getContext('2d')!] as const;
  };
  const [wallCanvas, wallCtx] = make();
  const [litCanvas, litCtx] = make();
  const rand = mulberry32(wall ^ rows);
  wallCtx.fillStyle = `#${wall.toString(16).padStart(6, '0')}`;
  wallCtx.fillRect(0, 0, size, size);
  litCtx.fillStyle = '#000';
  litCtx.fillRect(0, 0, size, size);
  const cols = 4;
  const cw = size / cols;
  const rh = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cw + cw * 0.22;
      const y = r * rh + rh * 0.2;
      wallCtx.fillStyle = '#1c2430';
      wallCtx.fillRect(x, y, cw * 0.56, rh * 0.55);
      if (rand() < 0.45) {
        litCtx.fillStyle = '#fff';
        litCtx.fillRect(x, y, cw * 0.56, rh * 0.55);
      }
    }
  }
  const toTexture = (canvas: HTMLCanvasElement, srgb: boolean) => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  };
  return { map: toTexture(wallCanvas, true), lit: toTexture(litCanvas, false) };
}
