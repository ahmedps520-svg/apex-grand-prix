import type { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import {
  PIT_BLEND,
  PIT_ENTRY,
  PIT_LANE_HALF_WIDTH,
  PIT_LENGTH,
  PIT_OFFSET,
  laneShare,
} from '../shared/pitLane';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import {
  materialColor,
  materialRoughness,
  mix,
  positionWorld,
  smoothstep,
  texture,
  uniform,
} from 'three/tsl';
import {
  DEFAULT_CONDITIONS,
  type Conditions,
  sunPathAt,
  type Weather,
} from '../content/conditions';
import type { WeatherMix } from '../shared/protocol';
import { mulberry32 } from '../shared/math';
import { KERB_WIDTH, type Track } from '../sim/track/Track';
import { Atmosphere } from './Atmosphere';
import { Rain } from './Rain';
import { CLEAR_FOG_FAR, sceneLook, type SceneLook } from './sceneLook';
import { Spray } from './Spray';
import type { ConePlacement } from './TestGroundScene';
import {
  CROWD_SEAT_WIDTH,
  CROWD_SEATS,
  asphaltTexture,
  barrierTexture,
  checkerTexture,
  crowdTexture,
  glowTexture,
  gravelTexture,
  labelTexture,
  noiseTexture,
  turfTexture,
} from './textures';
import { LINE_Y, MeshBuilder, TrackMeshBuilder } from './trackMeshes';

const SHADOW_EXTENT = 40;
/** Metres per texture tile (asphalt is adjusted to a whole number of tiles per lap). */
const ASPHALT_TILE = 7;
const TURF_TILE = 9;
const GRAVEL_TILE = 4;
/** Metres per tile of the noise that decides where water stands on a wet road. */
const PUDDLE_TILE = 37;
const BARRIER_HEIGHT = 1;
const BARRIER_THICKNESS = 0.5;
/** Length of each red or white block along the barrier top. */
const BARRIER_BLOCK = 2;
/** Start lights: columns across the gantry (they light one by one), lamps per column. */
const LIGHT_COLUMNS = 5;
const LIGHT_ROWS = 2;
const LIGHT_SPACING = 1.1;
/**
 * Lamp colours, and the additive glow around them. Kept near 1: brighter values come out of
 * the neutral tone mapping desaturated (pink rather than red).
 */
const LAMP_OFF = new THREE.Color(0.04, 0.028, 0.028);
const LAMP_RED = new THREE.Color(1, 0.02, 0.012);
const LAMP_GREEN = new THREE.Color(0.04, 1, 0.22);
const GLOW_OFF = new THREE.Color(0, 0, 0);
const GLOW_RED = new THREE.Color(0.9, 0.08, 0.03);
const GLOW_GREEN = new THREE.Color(0.08, 0.85, 0.25);
const GANTRY_BEAM_Y = 7.75;
const BANNER_HEIGHT = 1.35;
/** Grandstands: length along the track, rows of seats, and the front wall they sit on. */
const STAND_LENGTH = 48;
const STAND_SPACING = 54;
const STAND_ROWS = 10;
const ROW_DEPTH = 0.85;
const ROW_RISE = 0.42;
const STAND_FRONT = 1.6;
/** Gap between the back of the barrier and the front of a grandstand. */
const STAND_GAP = 3.5;
const STAND_DEPTH = 0.3 + STAND_ROWS * ROW_DEPTH;
const STAND_TOP = STAND_FRONT + STAND_ROWS * ROW_RISE;
const ROOF_Y = STAND_TOP + 3.4;
/** The roof overhangs the ends by 0.6 m and the front by 1.8 m. */
const STAND_RADIUS = Math.hypot(STAND_LENGTH / 2 + 0.6, STAND_DEPTH / 2 + 1.8);
/** Trees stand 25–400 m beyond the barriers and never nearer the track than this past them. */
const TREE_NEAREST = 25;
const TREE_FARTHEST = 400;
const TREE_CLEARANCE = 15;
/** Trees keep this far from a grandstand's centre. */
const TREE_STAND_CLEARANCE = STAND_LENGTH / 2 + 10;

interface StandPlacement {
  /** Front centre of the stand, on the ground. */
  x: number;
  z: number;
  /** Unit direction along the stand (its local x); local z points away from the track. */
  ax: number;
  az: number;
}

/** A circle on the ground: a grandstand's footprint. */
export interface Footprint {
  x: number;
  z: number;
  r: number;
}

/** A material that rain darkens (colour × `darken`) and makes glossier. */
interface WetSurface {
  material: THREE.MeshStandardMaterial;
  color: THREE.Color;
  roughness: number;
  /** Colour factor and roughness when soaked. */
  darken: number;
  wetRoughness: number;
}

/**
 * Scenery for a circuit, built from its Track: road, kerbs, run-off, barriers, a start gantry
 * with working start lights, grandstands, trees, and sun, sky and fog from the track's theme,
 * shaped by the time of day and the weather (`Conditions`). Static geometry is merged per
 * material and repeated props are instanced: 18 draw calls at most, plus 3 in the shadow pass,
 * and 2 more in the rain (the streaks, and spray behind the cars).
 */
export class TrackScene {
  readonly scene = new THREE.Scene();
  /** Circuits have no cones. */
  readonly conePlacements: ConePlacement[] = [];
  /** Grandstand footprints: circles on the ground that cameras keep out of and can't see through. */
  readonly obstacles: ReadonlyArray<Footprint>;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemi: THREE.HemisphereLight;
  private readonly atmosphere = new Atmosphere();
  private readonly sky: SkyMesh;
  /** Towards the sun in the sky, and towards the shadow-casting light. */
  private readonly sunDirection = new THREE.Vector3();
  private readonly lightDirection = new THREE.Vector3();
  private readonly followed = new THREE.Vector3();
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly lamps: THREE.InstancedMesh;
  private readonly glows: THREE.InstancedMesh;
  /** What the start lights show now: lit columns, or -1 for green. */
  private lightsShown = -2;
  private current: Conditions;
  private look: SceneLook;
  /** The day's clock: the hour it stands at, or null for the chosen time of day. */
  private clock: number | null = null;
  /** Weather moving: what the sky is changing to and how far along (null when fixed). */
  private mix: { to: Weather; blend: number } | null = null;
  /** The sun, the night and the cloud the reflections were last rendered for. */
  private envElevation = NaN;
  private envNight = NaN;
  private envCloud = NaN;
  /** Road wetness for the road shader: 0 dry … 1 standing water. */
  private readonly wet = uniform(0);
  private readonly wetSurfaces: WetSurface[] = [];
  private readonly rain = new Rain();
  private readonly spraying = new Spray();
  // Reflections (see buildEnvironment).
  private renderer: THREE.WebGPURenderer | null = null;
  private pmrem: THREE.PMREMGenerator | null = null;
  private envTarget: THREE.RenderTarget | null = null;
  private envSky: SkyMesh | null = null;

  constructor(
    private readonly track: Track,
    conditions: Conditions = DEFAULT_CONDITIONS,
  ) {
    const theme = track.def.theme;
    this.current = { ...conditions };
    this.look = sceneLook(theme, this.current);

    this.sky = this.atmosphere.createSky();
    this.sky.add(this.atmosphere.createNightSky(3));
    this.scene.add(this.sky);
    // Range fog like THREE.Fog, but its colour glows towards the sun (see Atmosphere).
    (this.scene as { fogNode?: THREE.Node }).fogNode = this.atmosphere.createFog();

    this.hemi = new THREE.HemisphereLight();
    this.scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight();
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const cam = this.sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 1;
    cam.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    const meshes = new TrackMeshBuilder(track);
    const turf = turfTexture();
    this.disposables.push(turf);
    this.buildGround(turf);
    this.buildSurfaces(meshes, turf);
    this.buildPitLane();
    this.buildBarriers(meshes);
    [this.lamps, this.glows] = this.buildGantry();
    this.obstacles = this.buildGrandstands();
    this.buildTrees(this.obstacles);
    this.setStartLights(0, false);
    this.scene.add(this.rain.mesh, this.spraying.mesh);
    this.disposables.push(this.atmosphere, this.rain, this.spraying);

    this.applyLook();
    this.follow(new THREE.Vector3(track.samples[0]!.x, 0, track.samples[0]!.z));
  }

  /** The time of day and weather shown. */
  get conditions(): Readonly<Conditions> {
    return this.current;
  }

  /**
   * Changes the time of day and weather in place: lights, sky, fog, wet surfaces and rain are
   * all uniforms, so nothing is rebuilt. The reflections are re-rendered if `buildEnvironment`
   * has run (a few milliseconds); rain appearing for the first time compiles its shader.
   */
  setConditions(conditions: Conditions): void {
    if (conditions.time === this.current.time && conditions.weather === this.current.weather) {
      return;
    }
    this.current = { ...conditions };
    this.look = this.makeLook();
    this.applyLook();
    this.follow(this.followed);
    if (this.look.wetness <= 0) this.spraying.clear();
    this.renderEnvironment();
  }

  /**
   * The day's clock: the sun moves across the sky with the hour and the sky, the fog and the
   * light with it; null keeps the chosen time of day's look. Cheap enough to call every frame
   * (the reflections are re-rendered only as the sun moves on).
   */
  setClock(hour: number | null): void {
    if (hour === this.clock) return;
    this.clock = hour;
    this.refreshLook();
  }

  /**
   * Weather moving: the sky is changing from one weather to another; the look follows the
   * change frame by frame. Null keeps the conditions' weather.
   */
  setWeather(mix: WeatherMix | null): void {
    const same = mix
      ? this.current.weather === mix.from && this.mix?.to === mix.to && this.mix.blend === mix.blend
      : this.mix === null;
    if (same) return;
    if (mix) {
      this.current.weather = mix.from;
      this.mix = { to: mix.to, blend: mix.blend };
    } else {
      this.mix = null;
    }
    this.refreshLook();
    if (this.look.wetness <= 0) this.spraying.clear();
  }

  /** The look again for a moved sun or sky; the reflections only as it changes enough. */
  private refreshLook(): void {
    this.look = this.makeLook();
    this.applyLook();
    this.follow(this.followed);
    const moved = Math.abs(this.look.sunElevation - this.envElevation) > 1.5;
    const dimmed = Math.abs(this.look.night - this.envNight) > 0.06;
    const clouded = Math.abs(this.look.cloud - this.envCloud) > 0.12;
    if (moved || dimmed || clouded) this.renderEnvironment();
  }

  /** The look for the conditions, with the sun on its path when the clock runs. */
  private makeLook(): SceneLook {
    const theme = this.track.def.theme;
    const sun =
      this.clock === null ? undefined : sunPathAt(this.clock, theme.sunElevation, theme.sunAzimuth);
    return sceneLook(theme, this.current, sun, this.mix ?? undefined);
  }

  /** Reflections for shiny surfaces: a pre-filtered copy of the sky. */
  buildEnvironment(renderer: THREE.WebGPURenderer): void {
    this.renderer = renderer;
    this.renderEnvironment();
  }

  /** Keeps the shadow-casting light (and the sky box) centred on the car. */
  follow(target: THREE.Vector3): void {
    if (target !== this.followed) this.followed.copy(target);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.lightDirection, 150);
    this.sun.target.updateMatrixWorld();
    // A circuit can be bigger than the sky box: keep the viewer inside it.
    this.sky.position.set(target.x, 0, target.z);
  }

  /**
   * Per frame, before rendering: moves the rain with `camera` and ages the spray. Cheap when
   * dry (it returns straight away).
   */
  update(dt: number, camera: THREE.Camera): void {
    this.rain.update(dt, camera);
    this.spraying.update(dt);
  }

  /**
   * Water thrown up behind a car on a wet track: (x, y, z) is the car's centre and (vx, vz) its
   * velocity, m/s. Call once per car per frame (with `update` once per frame); it does nothing
   * when the track is dry or the car is slow.
   */
  spray(x: number, y: number, z: number, vx: number, vz: number): void {
    this.spraying.emit(x, y, z, vx, vz);
  }

  /**
   * Start lights on the gantry over the start line: `lit` red lights (0–5), or all green when
   * `go`. Cheap to call every frame; the lamps only change when the state does.
   */
  setStartLights(lit: number, go: boolean): void {
    const columns = Number.isFinite(lit)
      ? THREE.MathUtils.clamp(Math.floor(lit), 0, LIGHT_COLUMNS)
      : 0;
    const shown = go ? -1 : columns;
    if (shown === this.lightsShown) return;
    this.lightsShown = shown;
    for (let c = 0; c < LIGHT_COLUMNS; c++) {
      const on = go || c < columns;
      const lamp = go ? LAMP_GREEN : on ? LAMP_RED : LAMP_OFF;
      const glow = go ? GLOW_GREEN : on ? GLOW_RED : GLOW_OFF;
      for (let r = 0; r < LIGHT_ROWS; r++) {
        this.lamps.setColorAt(c * LIGHT_ROWS + r, lamp);
        this.glows.setColorAt(c * LIGHT_ROWS + r, glow);
      }
    }
    for (const mesh of [this.lamps, this.glows]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    if (this.envSky) this.atmosphere.disposeSky(this.envSky);
    this.envTarget?.dispose();
    this.pmrem?.dispose();
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------ conditions

  /** Sets the lights, sky, fog, wet surfaces and rain from `this.look`. */
  private applyLook(): void {
    const look = this.look;
    const toward = (out: THREE.Vector3, elevationDeg: number, azimuthDeg: number) => {
      const elevation = THREE.MathUtils.degToRad(elevationDeg);
      const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
      return out.set(
        Math.cos(elevation) * Math.sin(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.cos(azimuth),
      );
    };
    toward(this.sunDirection, look.sunElevation, look.sunAzimuth);
    toward(this.lightDirection, look.lightElevation, look.lightAzimuth);
    this.atmosphere.set(look, this.sunDirection);
    this.hemi.color.copy(look.hemiSky);
    this.hemi.groundColor.copy(look.hemiGround);
    this.hemi.intensity = look.hemiIntensity;
    this.sun.color.copy(look.sunColor);
    this.sun.intensity = look.sunIntensity;
    this.sun.shadow.radius = look.shadowRadius;
    this.sun.shadow.intensity = look.shadowIntensity;
    this.scene.environmentIntensity = look.environmentIntensity;

    const wet = look.wetness;
    this.wet.value = wet;
    for (const s of this.wetSurfaces) {
      s.material.color.copy(s.color).multiplyScalar(THREE.MathUtils.lerp(1, s.darken, wet));
      s.material.roughness = THREE.MathUtils.lerp(s.roughness, s.wetRoughness, wet);
    }
    this.rain.set(look.rain, look.waterColor, 1.4, 0.6);
    this.spraying.wetness = wet;
    this.spraying.setLook(look.waterColor, 0.09 + 0.08 * wet);
  }

  /** (Re)renders the reflections from the sky as it looks now, into the same target. */
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
      this.envElevation = this.look.sunElevation;
      this.envNight = this.look.night;
      this.envCloud = this.look.cloud;
    } catch (error) {
      console.warn('Environment map unavailable; continuing without reflections.', error);
    }
  }

  /** Registers a material that rain darkens (colour × `darken`) and makes glossier. */
  private wettable<M extends THREE.MeshStandardMaterial>(
    material: M,
    darken: number,
    wetRoughness: number,
  ): M {
    this.wetSurfaces.push({
      material,
      color: material.color.clone(),
      roughness: material.roughness,
      darken,
      wetRoughness,
    });
    return material;
  }

  // ------------------------------------------------------------------ build

  /**
   * Grass under and around everything, out to where the fog hides its edge. Big, gentle
   * patches of lighter and darker grass (vertex colours) keep the distance from looking flat.
   */
  private buildGround(turf: THREE.Texture): void {
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of this.track.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const margin = Math.max(600, CLEAR_FOG_FAR) + this.track.wallOffset;
    const x0 = minX - margin;
    const z0 = minZ - margin;
    const width = maxX - minX + 2 * margin;
    const depth = maxZ - minZ + 2 * margin;
    const cells = 64;
    const patches = valueNoise(hashString(this.track.def.id), 260);
    const detail = valueNoise(hashString(this.track.def.id) + 1, 90);
    const mb = new MeshBuilder(true);
    const color = new THREE.Color();
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const x = x0 + (i / cells) * width;
        const z = z0 + (j / cells) * depth;
        const shade = 0.84 + patches(x, z) * 0.22 + detail(x, z) * 0.08;
        // Lighter patches are a little drier (warmer), darker ones a little lusher.
        const dry = patches(x, z) - 0.5;
        color.setRGB(shade * (1 + dry * 0.12), shade, shade * (1 - dry * 0.2));
        mb.vertex(x, 0, z, 0, 1, 0, x / TURF_TILE, z / TURF_TILE, color);
      }
    }
    for (let j = 0; j < cells; j++) {
      for (let i = 0; i < cells; i++) {
        const a = j * (cells + 1) + i;
        mb.quad(a, a + 1, a + cells + 2, a + cells + 1);
      }
    }
    const ground = new THREE.Mesh(
      mb.build(),
      this.wettable(
        new THREE.MeshStandardMaterial({
          map: turf,
          color: turfTint(this.track.def.theme.grass, turf),
          vertexColors: true,
          roughness: 1,
          metalness: 0,
        }),
        0.82,
        0.85,
      ),
    );
    ground.receiveShadow = true;
    // After the track surfaces lying on it, so the depth test skips shading what they cover.
    ground.renderOrder = 1;
    this.scene.add(ground);
  }

  /** Road, run-off, kerbs and paint: flat layers, each lifted and polygon-offset over the last. */
  private buildSurfaces(meshes: TrackMeshBuilder, turf: THREE.Texture): void {
    const track = this.track;
    const theme = track.def.theme;

    const tile = track.length / Math.max(1, Math.round(track.length / ASPHALT_TILE));
    const asphalt = asphaltTexture(1, 1);
    const puddles = noiseTexture(53, 256, 4, 4);
    this.disposables.push(asphalt, puddles);
    const road = new THREE.MeshStandardNodeMaterial({
      map: asphalt,
      roughness: 0.93,
      metalness: 0,
      ...layer(1),
    });
    // Wet asphalt: darker and glossy, so it mirrors the sky; standing water in the dips (where
    // the noise peaks) once the road is soaked. Dry, the nodes reduce to the plain material.
    const wet = this.wet;
    const water = texture(puddles, positionWorld.xz.div(PUDDLE_TILE)).r;
    const puddle = smoothstep(0.64, 0.8, water).mul(smoothstep(0.5, 1, wet));
    road.colorNode = materialColor.mul(mix(1, 0.5, wet)).mul(mix(1, 0.72, puddle));
    road.roughnessNode = mix(materialRoughness, mix(0.2, 0.04, puddle), wet);
    this.addFlat(meshes.road(tile), road);

    // Gravel where the physics has it: in the corners, when the track uses gravel traps.
    const gravelTraps = theme.runoffSurface === 'gravel';
    const isGravel = (i: number) => gravelTraps && track.kerbs[i]?.left === true;
    // Run-off grass is mown shorter and a touch lighter than the fields, so the edge reads.
    const runoffGrass = new THREE.Color(theme.grass).offsetHSL(0.01, -0.08, 0.03);
    this.addFlat(
      meshes.runoff(isGravel, false, TURF_TILE),
      this.wettable(
        new THREE.MeshStandardMaterial({
          map: turf,
          color: turfTint(runoffGrass.getHex(), turf),
          roughness: 1,
          metalness: 0,
          ...layer(1),
        }),
        0.82,
        0.8,
      ),
    );
    if (gravelTraps) {
      const gravel = gravelTexture();
      this.disposables.push(gravel);
      this.addFlat(
        meshes.runoff(isGravel, true, GRAVEL_TILE),
        this.wettable(
          new THREE.MeshStandardMaterial({ map: gravel, roughness: 1, metalness: 0, ...layer(1) }),
          0.7,
          0.6,
        ),
      );
    }

    this.addFlat(
      meshes.kerbs(),
      this.wettable(
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, ...layer(2) }),
        0.8,
        0.25,
      ),
    );
    this.addFlat(
      meshes.lines(),
      this.wettable(
        new THREE.MeshStandardMaterial({ color: 0xf4f4f0, roughness: 0.7, ...layer(2) }),
        0.88,
        0.25,
      ),
    );

    // Two rows of 0.8 m squares.
    const checker = checkerTexture(Math.max(2, Math.round((track.halfWidth * 2) / 0.8)), 2);
    this.disposables.push(checker);
    this.addFlat(
      meshes.startLine(1.6, LINE_Y + 0.002),
      this.wettable(
        new THREE.MeshStandardMaterial({ map: checker, roughness: 0.7, ...layer(3) }),
        0.85,
        0.25,
      ),
    );
  }

  private addFlat(geometry: THREE.BufferGeometry, material: THREE.Material): void {
    if (!geometry.index || geometry.index.count === 0) {
      geometry.dispose();
      material.dispose();
      return;
    }
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.scene.add(mesh);
  }

  /** The pit lane beside the start straight: a strip off the left of the track, and its wall. */
  private buildPitLane(): void {
    const track = this.track;
    const lateral = -(track.halfWidth + PIT_OFFSET);
    const positions: number[] = [];
    const indices: number[] = [];
    let n = 0;
    for (let d = 0; d <= PIT_LENGTH; d += 4) {
      const p = track.at(track.length - PIT_ENTRY + d);
      const lat = lateral * laneShare(d);
      for (const side of [-PIT_LANE_HALF_WIDTH, PIT_LANE_HALF_WIDTH]) {
        const off = lat + side;
        positions.push(p.x - p.tz * off, 0.02, p.z + p.tx * off);
      }
      if (n > 0) {
        const b = n * 2;
        indices.push(b - 2, b - 1, b, b - 1, b + 1, b);
      }
      n++;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    this.addFlat(
      geometry,
      new THREE.MeshStandardMaterial({
        color: 0x3b3e45,
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
        ...layer(2),
      }),
    );
    // The wall along the lane's outer side, where the lane runs straight.
    const a = track.at(track.length - PIT_ENTRY + PIT_BLEND);
    const b = track.at(track.length - PIT_ENTRY + PIT_LENGTH - PIT_BLEND);
    const off = lateral - PIT_LANE_HALF_WIDTH - 0.6;
    const ax = a.x - a.tz * off;
    const az = a.z + a.tx * off;
    const bx = b.x - b.tz * off;
    const bz = b.z + b.tx * off;
    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1, Math.hypot(bx - ax, bz - az)),
      new THREE.MeshStandardMaterial({ color: 0xdedede, roughness: 0.8, metalness: 0 }),
    );
    wall.position.set((ax + bx) / 2, 0.5, (az + bz) / 2);
    wall.rotation.y = Math.atan2(bx - ax, bz - az);
    wall.castShadow = true;
    wall.receiveShadow = true;
    this.scene.add(wall);
  }

  private buildBarriers(meshes: TrackMeshBuilder): void {
    const texture = barrierTexture(this.track.def.theme.barrier);
    this.disposables.push(texture);
    const walls = new THREE.Mesh(
      meshes.barriers(BARRIER_HEIGHT, BARRIER_THICKNESS, BARRIER_BLOCK),
      this.wettable(
        new THREE.MeshStandardMaterial({ map: texture, roughness: 0.8, metalness: 0 }),
        0.85,
        0.45,
      ),
    );
    // One draw call more in the shadow pass; the walls' shadows ground the track nicely.
    walls.castShadow = true;
    walls.receiveShadow = true;
    this.scene.add(walls);
  }

  /**
   * The start/finish gantry spanning the track at s = 0, with its banner and start lights.
   * Returns the lamps and their glows (instanced, coloured per lamp by setStartLights).
   */
  private buildGantry(): [THREE.InstancedMesh, THREE.InstancedMesh] {
    const track = this.track;
    const p = track.samples[0]!;
    // Local x across the track to the right, y up, z back towards the grid.
    const basis = groundBasis(p.x, p.z, -p.tz, p.tx);
    const post = track.wallOffset + BARRIER_THICKNESS + 0.6;
    const panelWidth = LIGHT_COLUMNS * LIGHT_SPACING + 0.4;
    const height = GANTRY_BEAM_Y + 0.85;
    const steel = 0x2c3036;
    const frame = merge([
      painted(box(0.8, height, 0.8, -post, height / 2, 0), steel),
      painted(box(0.8, height, 0.8, post, height / 2, 0), steel),
      painted(box(2 * post + 0.8, 1.7, 0.9, 0, GANTRY_BEAM_Y, 0), steel),
      // The light panel hangs under the beam, facing the grid: matt black, so lit lamps stand
      // out even with a low sun shining straight at it.
      painted(box(panelWidth, 1.75, 0.36, 0, GANTRY_BEAM_Y - 1.7, 0.1), 0x0a0b0d),
    ]).applyMatrix4(basis);
    const structure = new THREE.Mesh(
      frame,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.3 }),
    );
    structure.castShadow = true;
    structure.receiveShadow = true;
    this.scene.add(structure);

    // The banner reads from both sides of the beam.
    const bannerWidth = Math.min(2 * post - 2, 2 * (track.halfWidth + KERB_WIDTH) + 4);
    const texture = labelTexture('APEX GRAND PRIX', {
      width: 2048,
      height: Math.round((2048 * BANNER_HEIGHT) / bannerWidth),
      background: '#b3101a',
      color: '#ffffff',
    });
    this.disposables.push(texture);
    const banner = new THREE.Mesh(
      merge([
        new THREE.PlaneGeometry(bannerWidth, BANNER_HEIGHT).translate(0, GANTRY_BEAM_Y, 0.47),
        new THREE.PlaneGeometry(bannerWidth, BANNER_HEIGHT)
          .rotateY(Math.PI)
          .translate(0, GANTRY_BEAM_Y, -0.47),
      ]).applyMatrix4(basis),
      new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.6,
        // Slightly self-lit so it stays readable with the sun behind it.
        emissive: 0xffffff,
        emissiveMap: texture,
        emissiveIntensity: 0.12,
      }),
    );
    this.scene.add(banner);

    const count = LIGHT_COLUMNS * LIGHT_ROWS;
    const lamps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(0.24, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      count,
    );
    // No bloom pass: a soft additive halo in front of each lamp makes a lit one glow.
    const glowMap = glowTexture();
    this.disposables.push(glowMap);
    const glows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1.5, 1.5),
      new THREE.MeshBasicMaterial({
        map: glowMap,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      count,
    );
    const matrix = new THREE.Matrix4();
    for (let c = 0; c < LIGHT_COLUMNS; c++) {
      for (let r = 0; r < LIGHT_ROWS; r++) {
        // Column 0 on the left as the grid sees it.
        const x = (c - (LIGHT_COLUMNS - 1) / 2) * LIGHT_SPACING;
        const y = GANTRY_BEAM_Y - 1.3 - r * 0.75;
        const i = c * LIGHT_ROWS + r;
        lamps.setMatrixAt(i, matrix.makeTranslation(x, y, 0.28).premultiply(basis));
        lamps.setColorAt(i, LAMP_OFF);
        glows.setMatrixAt(i, matrix.makeTranslation(x, y, 0.55).premultiply(basis));
        glows.setColorAt(i, GLOW_OFF);
      }
    }
    this.scene.add(lamps, glows);
    return [lamps, glows];
  }

  /**
   * Grandstands behind the barrier on the right of the main straight, plus one on the outside
   * of the heaviest braking zone. Returns their footprints (roof included).
   */
  private buildGrandstands(): Footprint[] {
    const placements = this.standPlacements();
    if (placements.length === 0) return [];
    const structures: THREE.BufferGeometry[] = [];
    const crowd = new MeshBuilder();
    const unit = standGeometry(STAND_LENGTH);
    const corner = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const tile = CROWD_SEATS * CROWD_SEAT_WIDTH;
    for (const place of placements) {
      const basis = groundBasis(place.x, place.z, place.ax, place.az);
      structures.push(unit.clone().applyMatrix4(basis));
      // The crowd: one sloping sheet just above the seat rows, facing the track.
      normal.set(0, ROW_DEPTH, -ROW_RISE).normalize().transformDirection(basis);
      const sheet = (x: number, front: boolean) => {
        const z = front ? 0.3 : STAND_DEPTH;
        const y = STAND_FRONT + ROW_RISE * (front ? 1 : STAND_ROWS + 1) + 0.3;
        corner.set(x, y, z).applyMatrix4(basis);
        return crowd.vertex(
          corner.x,
          corner.y,
          corner.z,
          normal.x,
          normal.y,
          normal.z,
          x / tile,
          front ? 0 : 1,
        );
      };
      const half = STAND_LENGTH / 2;
      crowd.quad(sheet(-half, true), sheet(half, true), sheet(half, false), sheet(-half, false));
    }
    unit.dispose();

    const stands = new THREE.Mesh(
      merge(structures),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 }),
    );
    stands.castShadow = true;
    stands.receiveShadow = true;
    this.scene.add(stands);

    const texture = crowdTexture(STAND_ROWS);
    this.disposables.push(texture);
    const people = new THREE.Mesh(
      crowd.build(),
      new THREE.MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 }),
    );
    people.receiveShadow = true;
    this.scene.add(people);

    return placements.map((p) => ({
      x: p.x - p.az * (STAND_DEPTH / 2),
      z: p.z + p.ax * (STAND_DEPTH / 2),
      r: STAND_RADIUS,
    }));
  }

  private standPlacements(): StandPlacement[] {
    const track = this.track;
    const samples = track.samples;
    const n = samples.length;
    const spacing = track.length / n;
    const curvature = (i: number) => samples[((i % n) + n) % n]!.curvature;
    // The main straight: as far either way from the start line as the track stays nearly straight.
    const straight = (i: number) => Math.abs(curvature(i)) < 1 / 400;
    let back = 0;
    while (back < n / 3 && straight(-back - 1)) back++;
    let ahead = 0;
    while (ahead < n / 3 && straight(ahead + 1)) ahead++;
    const from = -back * spacing + 10;
    const to = ahead * spacing - 10;
    const half = STAND_LENGTH / 2;
    const out: StandPlacement[] = [];
    // Up to four in a row on the right, those nearest the grid and the line first.
    const slots: number[] = [];
    for (let k = -8; k <= 8; k++) {
      const centre = (k - 0.5) * STAND_SPACING;
      if (centre - half >= from && centre + half <= to) slots.push(centre);
    }
    if (slots.length === 0 && to - from >= STAND_LENGTH) slots.push((from + to) / 2);
    slots.sort((a, b) => Math.abs(a + 20) - Math.abs(b + 20));
    for (const centre of slots) if (out.length < 4) this.tryStand(centre, 1, out);

    // The heaviest braking zone: the tight corner after the longest run without one. The stand
    // goes on the outside, just before the turn-in.
    const tight = 1 / 120;
    let best = 0;
    let brake: { s: number; side: number } | null = null;
    for (let i = 0; i < n; i++) {
      if (Math.abs(curvature(i)) < tight || Math.abs(curvature(i - 1)) >= tight) continue;
      let run = 0;
      while (run < n && Math.abs(curvature(i - 1 - run)) < tight) run++;
      if (run * spacing <= best) continue;
      best = run * spacing;
      let peak = 0;
      for (let d = 0; d < 30; d++) {
        if (Math.abs(curvature(i + d)) > Math.abs(peak)) peak = curvature(i + d);
      }
      // A left turn (curvature > 0) runs wide to the right.
      brake = { s: samples[i]!.s - 15 - half, side: peak > 0 ? 1 : -1 };
    }
    if (brake && best >= STAND_LENGTH + 40) this.tryStand(brake.s, brake.side, out);
    return out;
  }

  /** Adds a stand centred at distance `s` on `side` (+1 right) if it fits clear of the track. */
  private tryStand(s: number, side: number, out: StandPlacement[]): void {
    const track = this.track;
    const p = track.at(s);
    const d = track.wallOffset + BARRIER_THICKNESS + STAND_GAP;
    const place: StandPlacement = {
      x: p.x - p.tz * d * side,
      z: p.z + p.tx * d * side,
      ax: p.tx * side,
      az: p.tz * side,
    };
    const half = STAND_LENGTH / 2;
    for (const other of out) {
      if (Math.hypot(other.x - place.x, other.z - place.z) < STAND_LENGTH + 1) return;
    }
    for (const u of [-half, 0, half]) {
      for (const v of [-1.5, STAND_DEPTH / 2, STAND_DEPTH + 0.3]) {
        // Local z (away from the track) is (-az, ax).
        const x = place.x + place.ax * u - place.az * v;
        const z = place.z + place.az * u + place.ax * v;
        if (Math.abs(track.project(x, z).lateral) < track.wallOffset + BARRIER_THICKNESS + 1) {
          return;
        }
      }
    }
    out.push(place);
  }

  /**
   * `theme.trees` trees scattered beyond the barriers, denser near the track: conifers and
   * broadleaves (instanced, one draw call each plus one for all the trunks).
   */
  private buildTrees(stands: ReadonlyArray<Footprint>): void {
    const track = this.track;
    const theme = track.def.theme;
    const wanted = Math.max(0, Math.floor(theme.trees));
    if (wanted === 0) return;
    const rand = mulberry32(hashString(track.def.id) ^ 0x5bd1e995);
    const samples = track.samples;
    const n = samples.length;
    const clear = track.wallOffset + TREE_CLEARANCE;
    // Every fourth sample, for a quick distance check before the exact one.
    const step = 4;
    const coarse = samples.filter((_, i) => i % step === 0);
    const slack = (step * track.length) / n;
    const pines: THREE.Matrix4[] = [];
    const leafy: THREE.Matrix4[] = [];
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let attempt = 0; attempt < wanted * 6 && pines.length + leafy.length < wanted; attempt++) {
      const p = samples[Math.floor(rand() * n)]!;
      const side = rand() < 0.5 ? -1 : 1;
      const out =
        track.wallOffset + TREE_NEAREST + Math.pow(rand(), 1.6) * (TREE_FARTHEST - TREE_NEAREST);
      const along = (rand() - 0.5) * 20;
      const pine = rand() < 0.5;
      const size = 0.75 + rand() * 0.8;
      const stretch = 0.85 + rand() * 0.4;
      const yaw = rand() * Math.PI * 2;
      const x = p.x - p.tz * out * side + p.tx * along;
      const z = p.z + p.tx * out * side + p.tz * along;
      let nearest = Infinity;
      for (const c of coarse) nearest = Math.min(nearest, (c.x - x) ** 2 + (c.z - z) ** 2);
      if (Math.sqrt(nearest) - slack < clear && Math.abs(track.project(x, z).lateral) < clear) {
        continue;
      }
      const near = TREE_STAND_CLEARANCE ** 2;
      if (stands.some((f) => (f.x - x) ** 2 + (f.z - z) ** 2 < near)) continue;
      position.set(x, 0, z);
      rotation.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, yaw);
      scale.set(size, size * stretch, size);
      (pine ? pines : leafy).push(new THREE.Matrix4().compose(position, rotation, scale));
    }
    const all = [...pines, ...leafy];
    if (all.length === 0) return;

    const trunks = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.2, 0.32, 3.2, 5, 1, true).translate(0, 1.6, 0),
      new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 }),
      all.length,
    );
    all.forEach((m, i) => trunks.setMatrixAt(i, m));
    this.scene.add(trunks);

    const grass = new THREE.Color(theme.grass);
    const color = new THREE.Color();
    const crowns = (geometry: THREE.BufferGeometry, base: number, matrices: THREE.Matrix4[]) => {
      if (matrices.length === 0) {
        geometry.dispose();
        return;
      }
      const mesh = new THREE.InstancedMesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }),
        matrices.length,
      );
      // A hint of the local grass in the leaves, and every tree a slightly different shade.
      const tint = new THREE.Color(base).lerp(grass, 0.2);
      matrices.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        color
          .copy(tint)
          .offsetHSL((rand() - 0.5) * 0.05, (rand() - 0.5) * 0.12, (rand() - 0.5) * 0.07);
        mesh.setColorAt(i, color);
      });
      this.scene.add(mesh);
    };
    crowns(
      merge([
        new THREE.ConeGeometry(2.3, 5.2, 8).translate(0, 4.6, 0),
        new THREE.ConeGeometry(1.6, 3.8, 8).translate(0, 7.4, 0),
      ]),
      0x2d5a33,
      pines,
    );
    crowns(
      new THREE.IcosahedronGeometry(2.6, 1).scale(1, 0.9, 1).translate(0, 5, 0),
      0x4b7a35,
      leafy,
    );
  }
}

/** Polygon offset for flat layer `level` (higher draws over lower; the ground is level 0). */
function layer(level: number): Partial<THREE.MeshStandardMaterialParameters> {
  return {
    polygonOffset: true,
    polygonOffsetFactor: -level,
    polygonOffsetUnits: -2 * level,
  };
}

/** Material colour that makes the neutral turf texture average out at `grass`. */
function turfTint(grass: number, turf: THREE.Texture): THREE.Color {
  const mean = (turf.userData as { mean?: number }).mean ?? 1;
  return new THREE.Color(grass).multiplyScalar(1 / mean);
}

/** Placement at (x, z) on the ground with local x along (ax, az), y up and z = x × y. */
function groundBasis(x: number, z: number, ax: number, az: number): THREE.Matrix4 {
  return new THREE.Matrix4()
    .makeBasis(
      new THREE.Vector3(ax, 0, az),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(-az, 0, ax),
    )
    .setPosition(x, 0, z);
}

function box(w: number, h: number, d: number, x: number, y: number, z: number) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  if (!merged) throw new Error('Could not merge the track scenery geometry');
  for (const part of parts) part.dispose();
  return merged;
}

function painted(geometry: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * One grandstand in its own frame: x along the track, z away from it, origin at the foot of the
 * front wall. Stepped concrete rows, a back wall and a roof on slim posts.
 */
function standGeometry(length: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) =>
    parts.push(painted(box(w, h, d, x, y, z), hex));
  add(length, STAND_FRONT, 0.3, 0, STAND_FRONT / 2, 0.15, 0x39414d);
  for (let r = 0; r < STAND_ROWS; r++) {
    const h = STAND_FRONT + (r + 1) * ROW_RISE;
    add(length, h, ROW_DEPTH, 0, h / 2, 0.3 + (r + 0.5) * ROW_DEPTH, r % 2 ? 0x96968f : 0x8a8a84);
  }
  add(length, ROOF_Y, 0.3, 0, ROOF_Y / 2, STAND_DEPTH + 0.15, 0x5b636f);
  const roofDepth = STAND_DEPTH + 2.1;
  add(length + 1.2, 0.3, roofDepth, 0, ROOF_Y + 0.15, STAND_DEPTH + 0.3 - roofDepth / 2, 0xe6e9ed);
  const posts = Math.max(2, Math.round(length / 16) + 1);
  for (let k = 0; k < posts; k++) {
    const x = -length / 2 + 0.4 + (k / (posts - 1)) * (length - 0.8);
    add(0.25, ROOF_Y - STAND_FRONT, 0.25, x, (ROOF_Y + STAND_FRONT) / 2, 0.15, 0x4a4f57);
  }
  return merge(parts);
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Smooth 2D value noise in [0, 1] with features about `cell` metres across. */
function valueNoise(seed: number, cell: number): (x: number, z: number) => number {
  const hash = (i: number, j: number): number => {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + seed) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, z) => {
    const gx = x / cell;
    const gz = z / cell;
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const sx = fx * fx * (3 - 2 * fx);
    const sz = fz * fz * (3 - 2 * fz);
    const a = hash(i, j);
    const b = hash(i + 1, j);
    const c = hash(i, j + 1);
    const d = hash(i + 1, j + 1);
    return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
  };
}
