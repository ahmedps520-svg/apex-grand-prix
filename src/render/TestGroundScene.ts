import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import * as THREE from 'three/webgpu';
import {
  DRAG_STRIP,
  LOOP_POINTS,
  LOOP_WIDTH,
  PAD_HALF_X,
  PAD_HALF_Z,
  SKIDPAD,
  SLALOM,
  SPAWN,
} from '../content/testGround';
import { mulberry32 } from '../shared/math';
import { asphaltTexture, checkerTexture, grassTexture, labelTexture } from './textures';

const SUN_ELEVATION = THREE.MathUtils.degToRad(38);
const SUN_AZIMUTH = THREE.MathUtils.degToRad(215);
const SHADOW_EXTENT = 40;
const GROUND_EXTENT = 2600;
const LINE_Y = 0.012;
/** Drag strip distance boards: size of the sign face and height of its centre, metres. */
const BOARD_WIDTH = 3;
const BOARD_HEIGHT = 1.5;
const BOARD_Y = 1.9;

export interface ConePlacement {
  x: number;
  z: number;
}

/**
 * Round 1 environment: a big asphalt test pad with a painted loop, a 1 km drag strip and a
 * skidpad, surrounded by grass.
 */
export class TestGroundScene {
  readonly scene = new THREE.Scene();
  readonly conePlacements: ConePlacement[] = [];
  private readonly sun: THREE.DirectionalLight;
  private readonly sky: SkyMesh;
  private readonly sunDirection = new THREE.Vector3();
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** White paint shared by all the painted lines, offset so it never z-fights the asphalt. */
  private readonly paint = new THREE.MeshStandardMaterial({
    color: 0xf4f4f0,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  constructor() {
    this.sunDirection.set(
      Math.cos(SUN_ELEVATION) * Math.sin(SUN_AZIMUTH),
      Math.sin(SUN_ELEVATION),
      Math.cos(SUN_ELEVATION) * Math.cos(SUN_AZIMUTH),
    );

    this.sky = createSky(this.sunDirection);
    this.scene.add(this.sky);
    this.scene.fog = new THREE.Fog(0xc9d6e3, 400, GROUND_EXTENT * 0.95);

    const hemi = new THREE.HemisphereLight(0xc3d8ff, 0x5b6446, 0.35);
    this.scene.add(hemi);

    this.sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
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

    this.buildGround();
    const loop = this.buildLoop();
    // The loop's start line, just ahead of the spawn.
    this.buildCheckerLines(SPAWN.x, LOOP_WIDTH, [SPAWN.z - 10]);
    // The loop's main straight runs along x = 0 towards -z and ends at the loop's fourth point.
    this.buildBrakingBoards(-LOOP_WIDTH / 2 - 3, LOOP_POINTS[3]![1]);
    this.buildDragStrip();
    this.buildSkidpad();
    this.buildTrees();
    this.placeCones(loop);
  }

  /** Reflections for shiny surfaces: a pre-filtered copy of the sky. */
  /** The sun's shadow map size and softness (PCF radius in texels). */
  setShadows(size: number, softness: number): void {
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.radius = softness;
  }

  buildEnvironment(renderer: THREE.WebGPURenderer): void {
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const envScene = new THREE.Scene();
      envScene.add(createSky(this.sunDirection));
      const target = pmrem.fromScene(envScene, 0.02);
      this.scene.environment = target.texture;
      this.scene.environmentIntensity = 0.55;
      this.disposables.push(target, pmrem);
    } catch (error) {
      console.warn('Environment map unavailable; continuing without reflections.', error);
    }
  }

  /** Keeps the shadow-casting light centred on the car. */
  follow(target: THREE.Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(this.sunDirection, 150);
    this.sun.target.updateMatrixWorld();
  }

  dispose(): void {
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose();
    });
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------------ build

  private buildGround(): void {
    const width = PAD_HALF_X * 2;
    const length = PAD_HALF_Z * 2;
    // One asphalt tile per 7 m in both directions.
    const asphalt = asphaltTexture(width / 7, length / 7);
    this.disposables.push(asphalt);
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.93, metalness: 0 }),
    );
    pad.receiveShadow = true;
    this.scene.add(pad);

    // Grass all around the pad (a big square with the pad cut out, so nothing overlaps).
    const outer = new THREE.Shape()
      .moveTo(-GROUND_EXTENT, -GROUND_EXTENT)
      .lineTo(GROUND_EXTENT, -GROUND_EXTENT)
      .lineTo(GROUND_EXTENT, GROUND_EXTENT)
      .lineTo(-GROUND_EXTENT, GROUND_EXTENT)
      .closePath();
    const hole = new THREE.Path()
      .moveTo(-PAD_HALF_X, -PAD_HALF_Z)
      .lineTo(-PAD_HALF_X, PAD_HALF_Z)
      .lineTo(PAD_HALF_X, PAD_HALF_Z)
      .lineTo(PAD_HALF_X, -PAD_HALF_Z)
      .closePath();
    outer.holes.push(hole);
    const grass = grassTexture(1 / 9);
    this.disposables.push(grass);
    const grassMesh = new THREE.Mesh(
      new THREE.ShapeGeometry(outer).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: grass, roughness: 1, metalness: 0 }),
    );
    grassMesh.receiveShadow = true;
    this.scene.add(grassMesh);
  }

  /** Painted edge lines and a dashed centre line along the loop. Returns the sampled loop. */
  private buildLoop(): SampledLoop {
    const curve = new THREE.CatmullRomCurve3(
      LOOP_POINTS.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      'centripetal',
    );
    const length = curve.getLength();
    const count = Math.ceil(length);
    const points = curve.getSpacedPoints(count).slice(0, count);
    const loop: SampledLoop = { points, spacing: length / count };
    const half = LOOP_WIDTH / 2;
    const geometry = mergeRibbons([
      ribbon(loop, -half, 0.25),
      ribbon(loop, half, 0.25),
      ribbon(loop, 0, 0.15, (s) => s % 9 < 3),
    ]);
    const lines = new THREE.Mesh(geometry, this.paint);
    lines.receiveShadow = true;
    this.scene.add(lines);
    return loop;
  }

  /** Checkered lines `width` metres wide, centred on `x`, across a straight along z. */
  private buildCheckerLines(x: number, width: number, zs: readonly number[]): void {
    // Half-metre squares, two rows deep.
    const texture = checkerTexture(Math.round(width / 0.5), 2);
    this.disposables.push(texture);
    const geometry = new THREE.PlaneGeometry(width, 1).rotateX(-Math.PI / 2);
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.7,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    for (const z of zs) {
      const line = new THREE.Mesh(geometry, material);
      line.position.set(x, LINE_Y, z);
      line.receiveShadow = true;
      this.scene.add(line);
    }
  }

  /** 150 / 100 / 50 m boards at `x`, counting down to `endZ` on a straight driven towards -z. */
  private buildBrakingBoards(x: number, endZ: number): void {
    const boardMat = new THREE.MeshStandardMaterial({ color: 0xf5f5f5, roughness: 0.6 });
    const postMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xd23b2f, roughness: 0.6 });
    const panelGeo = new THREE.BoxGeometry(1.4, 0.9, 0.08);
    const postGeo = new THREE.BoxGeometry(0.1, 1.4, 0.1);
    const stripeGeo = new THREE.BoxGeometry(1.2, 0.12, 0.09);
    [150, 100, 50].forEach((distance, i) => {
      const board = new THREE.Group();
      const panel = new THREE.Mesh(panelGeo, boardMat);
      panel.position.y = 1.4;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 0.7;
      board.add(panel, post);
      for (let s = 0; s < 3 - i; s++) {
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.y = 1.18 + s * 0.2;
        board.add(stripe);
      }
      board.position.set(x, 0, endZ + distance);
      board.traverse((o) => (o.castShadow = true));
      this.scene.add(board);
    });
  }

  /** Edge lines, start and finish lines and trackside boards for the drag strip. */
  private buildDragStrip(): void {
    const { x, zStart, length, halfWidth } = DRAG_STRIP;
    // Past the finish the strip carries on as a braking zone to near the end of the pad.
    const zEnd = -PAD_HALF_Z + 10;
    const lines = new THREE.Mesh(
      mergeRibbons([
        strip(x - halfWidth, zStart + 20, zEnd, 0.25),
        strip(x + halfWidth, zStart + 20, zEnd, 0.25),
      ]),
      this.paint,
    );
    lines.receiveShadow = true;
    this.scene.add(lines);
    this.buildCheckerLines(x, halfWidth * 2, [zStart, zStart - length]);
    const boardX = x - halfWidth - 3;
    this.buildDistanceBoards(boardX);
    this.buildBrakingBoards(boardX, zEnd);
  }

  /** Numbered boards at `x`, every `markerSpacing` metres after the drag strip's start line. */
  private buildDistanceBoards(x: number): void {
    const { zStart, length, markerSpacing } = DRAG_STRIP;
    const count = Math.floor(length / markerSpacing);
    // Every board has the same stand (a dark backing panel on two posts): one instanced mesh.
    const stand = mergeGeometries([
      new THREE.BoxGeometry(BOARD_WIDTH + 0.1, BOARD_HEIGHT + 0.1, 0.06).translate(0, BOARD_Y, 0),
      new THREE.BoxGeometry(0.12, BOARD_Y, 0.12).translate(-1.1, BOARD_Y / 2, -0.09),
      new THREE.BoxGeometry(0.12, BOARD_Y, 0.12).translate(1.1, BOARD_Y / 2, -0.09),
    ]);
    if (!stand) throw new Error('Could not build the distance board geometry');
    const stands = new THREE.InstancedMesh(
      stand,
      new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.8 }),
      count,
    );
    stands.castShadow = true;
    this.scene.add(stands);
    const face = new THREE.PlaneGeometry(BOARD_WIDTH, BOARD_HEIGHT);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const distance = (i + 1) * markerSpacing;
      const z = zStart - distance;
      stands.setMatrixAt(i, matrix.makeTranslation(x, 0, z));
      const texture = labelTexture(String(distance));
      this.disposables.push(texture);
      const sign = new THREE.Mesh(
        face,
        new THREE.MeshStandardMaterial({
          map: texture,
          roughness: 0.6,
          // Slightly self-lit, like reflective sign paint: the sun is behind the boards.
          emissive: 0xffffff,
          emissiveMap: texture,
          emissiveIntensity: 0.3,
          // Keeps the face in front of the backing panel even far away.
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      // Facing +z, towards the approaching cars.
      sign.position.set(x, BOARD_Y, z + 0.035);
      this.scene.add(sign);
    }
  }

  /** Painted circle: solid inner and outer edges and a dashed line on the driving radius. */
  private buildSkidpad(): void {
    const { x, z, radius, halfWidth } = SKIDPAD;
    const circumference = 2 * Math.PI * radius;
    // About 1 m per sample, with a whole number of 3 m-on, 6 m-off dashes around the circle.
    const dashes = Math.round(circumference / 9);
    const count = dashes * 9;
    const points: THREE.Vector3[] = [];
    for (let i = 0; i < count; i++) {
      // Anticlockwise seen from above, the way the skidpad spawn drives.
      const angle = (i / count) * Math.PI * 2;
      points.push(new THREE.Vector3(x + Math.cos(angle) * radius, 0, z - Math.sin(angle) * radius));
    }
    const circle: SampledLoop = { points, spacing: circumference / count };
    const period = circumference / dashes;
    const lines = new THREE.Mesh(
      mergeRibbons([
        ribbon(circle, -halfWidth, 0.25),
        ribbon(circle, halfWidth, 0.25),
        ribbon(circle, 0, 0.15, (s) => s % period < period / 3),
      ]),
      this.paint,
    );
    lines.receiveShadow = true;
    this.scene.add(lines);
  }

  private buildTrees(): void {
    const rand = mulberry32(42);
    const count = 480;
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.25, 0.35, 3, 6).translate(0, 1.5, 0),
      new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 }),
      count,
    );
    const crown = new THREE.InstancedMesh(
      new THREE.ConeGeometry(2.4, 7, 7).translate(0, 6, 0),
      new THREE.MeshStandardMaterial({ color: 0x2f5a2c, roughness: 0.95 }),
      count,
    );
    const matrix = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      // A band of trees beyond the pad edge, denser near it: pick how far out, then a point
      // spread evenly along the pad outline grown by that much (rounded at the corners).
      const out = 12 + Math.pow(rand(), 2) * 640;
      // Walk along a quarter of that outline (half the +z edge, the corner arc, half the +x
      // edge), then mirror into a random quadrant.
      const arc = (Math.PI / 2) * out;
      const t = rand() * (PAD_HALF_X + arc + PAD_HALF_Z);
      if (t < PAD_HALF_X) {
        p.set(t, 0, PAD_HALF_Z + out);
      } else if (t < PAD_HALF_X + arc) {
        const a = (t - PAD_HALF_X) / out;
        p.set(PAD_HALF_X + Math.sin(a) * out, 0, PAD_HALF_Z + Math.cos(a) * out);
      } else {
        p.set(PAD_HALF_X + out, 0, PAD_HALF_Z + PAD_HALF_X + arc - t);
      }
      if (rand() < 0.5) p.x = -p.x;
      if (rand() < 0.5) p.z = -p.z;
      const scale = 0.7 + rand() * 0.9;
      s.set(scale, scale * (0.8 + rand() * 0.5), scale);
      q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
      matrix.compose(p, q, s);
      trunk.setMatrixAt(i, matrix);
      crown.setMatrixAt(i, matrix);
    }
    trunk.castShadow = false;
    crown.castShadow = false;
    this.scene.add(trunk, crown);
  }

  /**
   * A slalom row beside the straight, small cone groups at the apex of each corner and a ring
   * inside the skidpad.
   */
  private placeCones(loop: SampledLoop): void {
    for (let z = SLALOM.zStart; z >= SLALOM.zEnd; z -= SLALOM.spacing) {
      this.conePlacements.push({ x: SLALOM.x, z });
    }
    const pts = loop.points;
    const n = pts.length;
    const curvature = (i: number): number => {
      const a = pts[(i - 4 + n) % n]!;
      const b = pts[i]!;
      const c = pts[(i + 4) % n]!;
      const t1 = new THREE.Vector3().subVectors(b, a).normalize();
      const t2 = new THREE.Vector3().subVectors(c, b).normalize();
      // Signed: > 0 turning left, < 0 turning right.
      return (t1.z * t2.x - t1.x * t2.z) / (8 * loop.spacing);
    };
    let lastApex = -1000;
    for (let i = 0; i < n; i++) {
      const k = curvature(i);
      const prev = Math.abs(curvature((i - 1 + n) % n));
      const next = Math.abs(curvature((i + 1) % n));
      if (Math.abs(k) > 1 / 90 && Math.abs(k) >= prev && Math.abs(k) >= next && i - lastApex > 40) {
        lastApex = i;
        const p = pts[i]!;
        const t = new THREE.Vector3().subVectors(pts[(i + 1) % n]!, p).normalize();
        // The apex is on the inside of the turn: left for left turns, right for right turns.
        const side = k > 0 ? -1 : 1;
        const nx = -t.z * side;
        const nz = t.x * side;
        for (let j = -1; j <= 1; j++) {
          const q = pts[(i + j * 3 + n) % n]!;
          this.conePlacements.push({
            x: q.x + nx * (LOOP_WIDTH / 2 + 0.8),
            z: q.z + nz * (LOOP_WIDTH / 2 + 0.8),
          });
        }
      }
    }
    // Evenly spaced just inside the skidpad's inner line.
    const ring = SKIDPAD.radius - SKIDPAD.halfWidth - 1.2;
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      this.conePlacements.push({
        x: SKIDPAD.x + Math.cos(angle) * ring,
        z: SKIDPAD.z + Math.sin(angle) * ring,
      });
    }
  }
}

interface SampledLoop {
  points: THREE.Vector3[];
  /** Metres between consecutive points. */
  spacing: number;
}

function createSky(sunDirection: THREE.Vector3): SkyMesh {
  const sky = new SkyMesh();
  sky.scale.setScalar(2800);
  sky.turbidity.value = 3.2;
  sky.rayleigh.value = 1.1;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.86;
  sky.cloudCoverage.value = 0.32;
  sky.sunPosition.value.copy(sunDirection);
  return sky;
}

/** Flat strip following the loop at a lateral offset (right of the driving direction > 0). */
function ribbon(
  loop: SampledLoop,
  offset: number,
  width: number,
  include?: (distance: number) => boolean,
): Float32Array {
  const pts = loop.points;
  const n = pts.length;
  const verts: number[] = [];
  const edge = (i: number, lateral: number): [number, number, number] => {
    const prev = pts[(i - 1 + n) % n]!;
    const next = pts[(i + 1) % n]!;
    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const p = pts[i]!;
    return [p.x - tz * lateral, LINE_Y, p.z + tx * lateral];
  };
  for (let i = 0; i < n; i++) {
    if (include && !include((i + 0.5) * loop.spacing)) continue;
    const j = (i + 1) % n;
    const a0 = edge(i, offset - width / 2);
    const b0 = edge(i, offset + width / 2);
    const a1 = edge(j, offset - width / 2);
    const b1 = edge(j, offset + width / 2);
    verts.push(...a0, ...b0, ...a1, ...b0, ...b1, ...a1);
  }
  return new Float32Array(verts);
}

/** Straight strip along z, centred on `x`, between `z0` and `z1`. */
function strip(x: number, z0: number, z1: number, width: number): Float32Array {
  const near = Math.max(z0, z1);
  const far = Math.min(z0, z1);
  const a0 = [x - width / 2, LINE_Y, near];
  const b0 = [x + width / 2, LINE_Y, near];
  const a1 = [x - width / 2, LINE_Y, far];
  const b1 = [x + width / 2, LINE_Y, far];
  // Wound like a `ribbon` driven towards -z, so it faces up.
  return new Float32Array([...a0, ...b0, ...a1, ...b0, ...b1, ...a1]);
}

/** One up-facing geometry from the triangles of several strips or ribbons. */
function mergeRibbons(parts: Float32Array[]): THREE.BufferGeometry {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const positions = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    positions.set(p, offset);
    offset += p.length;
  }
  const normals = new Float32Array(total);
  for (let i = 1; i < total; i += 3) normals[i] = 1;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}
