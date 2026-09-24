import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  dot,
  float,
  fog,
  instanceIndex,
  max,
  mix,
  normalView,
  normalize,
  positionWorld,
  pow,
  rangeFogFactor,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { mulberry32 } from '../shared/math';
import type { SceneLook } from './sceneLook';
import { noiseTexture } from './textures';

/** The sky is a box around the viewer; it draws at the far plane whatever its size. */
const SKY_SIZE = 2800;
/** Stars: how many, how far out (in the sky's own units) and how big on the dome. */
const STAR_COUNT = 1400;
const STAR_RADIUS = 0.88;
const STAR_SIZE = 0.0011;
/** The moon: 25° up, opposite the sun's bearing, half a degree across at the stars' distance. */
const MOON_ELEVATION = (25 * Math.PI) / 180;
const MOON_RADIUS = 0.0039;

type Vec3Node = THREE.Node<'vec3'>;

/**
 * Sky and fog for a circuit. The sky is three.js's analytic daylight model (SkyMesh: sun, haze,
 * scattered clouds), graded towards a twilight gradient at dusk and blended into a grey cloud
 * deck for overcast and rain. The fog's colour glows towards the sun, and the sky melts into
 * the same colour at the horizon, so the far ground never shows an edge against the sky. One
 * set of uniforms drives the visible sky, the copy the reflections are made from, and the fog.
 * A night sky (stars and a moon) can hang under the visible sky, coming up with the night.
 */
export class Atmosphere {
  private readonly clouds = noiseTexture(41, 256, 5, 4);
  private readonly u = {
    overcast: uniform(0),
    horizon: uniform(new THREE.Color()),
    zenith: uniform(new THREE.Color()),
    mottle: uniform(0.5),
    haze: uniform(0),
    twilight: uniform(0),
    duskZenith: uniform(new THREE.Color()),
    /** How far into the night: the stars and the moon come up with it. */
    night: uniform(0),
    fog: uniform(new THREE.Color()),
    fogSun: uniform(new THREE.Color()),
    fogNear: uniform(1),
    fogFar: uniform(2),
    /** Unit direction to the sun, and the same flattened onto the ground. */
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    sunFlat: uniform(new THREE.Vector3(0, 0, 1)),
  };
  private readonly skies: Array<{ mesh: SkyMesh; reflection: boolean }> = [];
  private readonly moons: THREE.Object3D[] = [];
  private readonly nightParts: Array<{ dispose(): void }> = [];
  private look: SceneLook | null = null;

  /** Fog for `Scene.fogNode`: range fog in the haze colour of each view direction. */
  createFog(): THREE.Node<'vec4'> {
    const dir = normalize(positionWorld.sub(cameraPosition));
    return fog(this.haze(dir), rangeFogFactor(this.u.fogNear, this.u.fogFar));
  }

  /** A new sky mesh; `reflection` makes the softer, sunless one for environment maps. */
  createSky(reflection = false): SkyMesh {
    const sky = new SkyMesh();
    sky.scale.setScalar(SKY_SIZE);
    // SkyMesh's own colour: a vec4.
    const base = sky.material.colorNode as THREE.Node<'vec4'> | null;
    if (base) {
      const u = this.u;
      const dir = normalize(positionWorld.sub(cameraPosition));
      const up = max(dir.y, 0);
      const haze = this.haze(dir);

      // Twilight: deep blue overhead down to the horizon's haze, glowing round the sun.
      const toSun = max(dot(dir, u.sun), 0);
      const glow = pow(toSun, 6).mul(0.45).add(pow(toSun, 60).mul(1.2));
      const twilight = mix(haze, u.duskZenith, pow(smoothstep(0, 0.75, up), 0.6)).add(
        u.fogSun.mul(glow),
      );
      const daylight = mix(base.rgb, twilight, u.twilight.mul(0.85));
      const clear = mix(daylight, haze, u.haze.mul(float(1).sub(smoothstep(0, 0.09, up))));

      // The deck: the view ray met with a flat cloud base, two octaves of drifting noise on it,
      // uniform at the horizon (so it meets the fog exactly) and mottled overhead.
      const deck = dir.xz.div(up.add(0.1));
      const drift = time.mul(0.004);
      const n1 = texture(this.clouds, deck.mul(0.16).add(vec2(drift, 0))).r;
      const n2 = texture(this.clouds, deck.mul(0.47).add(vec2(0, drift.mul(1.6)))).r;
      const noise = n1.mul(0.65).add(n2.mul(0.35)).sub(0.5);
      const mottle = noise.mul(u.mottle).mul(smoothstep(0.02, 0.3, up));
      const cloudDeck = mix(u.horizon, u.zenith, smoothstep(0, 0.45, up)).mul(float(1).add(mottle));
      sky.material.colorNode = vec4(mix(clear, cloudDeck, u.overcast), 1);
    }
    // Drawn last: the sky shader then only runs where nothing else was drawn.
    sky.renderOrder = 2;
    this.skies.push({ mesh: sky, reflection });
    if (this.look) this.applyTo(sky, reflection);
    return sky;
  }

  /** Sets the sky and fog to `look`, with the sun towards `sunDirection` (unit length). */
  set(look: SceneLook, sunDirection: THREE.Vector3): void {
    this.look = look;
    const u = this.u;
    u.overcast.value = look.sky.overcast;
    u.horizon.value.copy(look.sky.horizon);
    u.zenith.value.copy(look.sky.zenith);
    u.mottle.value = look.sky.mottle;
    u.haze.value = look.sky.haze;
    u.twilight.value = look.sky.twilight;
    u.duskZenith.value.copy(look.sky.duskZenith);
    u.fog.value.copy(look.fogColor);
    u.fogSun.value.copy(look.fogSunColor);
    u.fogNear.value = look.fogNear;
    u.fogFar.value = look.fogFar;
    u.sun.value.copy(sunDirection);
    u.sunFlat.value.set(sunDirection.x, 0, sunDirection.z);
    if (u.sunFlat.value.lengthSq() < 1e-8) u.sunFlat.value.set(0, 0, 1);
    u.sunFlat.value.normalize();
    u.night.value = look.night;
    for (const moon of this.moons) this.placeMoon(moon, sunDirection);
    for (const { mesh, reflection } of this.skies) this.applyTo(mesh, reflection);
  }

  /**
   * The night sky, to add to a sky made by `createSky` (it follows it): a field of stars over
   * the dome and a full moon opposite the sun, 25° up. They come up with the night and go
   * under a closed cloud deck; the stars twinkle a little.
   */
  createNightSky(seed = 1): THREE.Group {
    const u = this.u;
    const clear = u.night.mul(float(1).sub(u.overcast));
    const rand = mulberry32(seed);
    const group = new THREE.Group();
    // Stars: tiny spheres spread evenly over the dome (a uniform height is uniform on a
    // sphere), brighter, larger and warmer at random, each twinkling to its own beat.
    const starGeo = new THREE.IcosahedronGeometry(STAR_SIZE, 0);
    const starMat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    starMat.fog = false;
    const beat = sin(time.mul(2.1).add(instanceIndex.toFloat().mul(0.37)));
    starMat.opacityNode = clear.mul(beat.mul(0.18).add(0.82));
    const stars = new THREE.InstancedMesh(starGeo, starMat, STAR_COUNT);
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    for (let i = 0; i < STAR_COUNT; i++) {
      const y = 0.06 + rand() * 0.94;
      const a = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      const scale = 0.6 + rand() * rand() * 1.6;
      matrix
        .makeScale(scale, scale, scale)
        .setPosition(Math.cos(a) * r * STAR_RADIUS, y * STAR_RADIUS, Math.sin(a) * r * STAR_RADIUS);
      stars.setMatrixAt(i, matrix);
      const bright = 0.35 + rand() * 0.65;
      const warm = rand();
      color.setRGB(
        bright * (0.85 + warm * 0.15),
        bright * (0.9 + warm * 0.08),
        bright * (1 - warm * 0.1),
      );
      stars.setColorAt(i, color);
    }
    stars.frustumCulled = false;
    stars.renderOrder = 3;
    // The moon: a pale disc (a small sphere reads the same) in a soft glow that fades to its rim.
    const moonMat = new THREE.MeshBasicNodeMaterial({
      color: 0xf6f1e2,
      transparent: true,
      depthWrite: false,
    });
    moonMat.fog = false;
    moonMat.opacityNode = clear;
    const glowMat = new THREE.MeshBasicNodeMaterial({
      color: 0xc9d4ff,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    glowMat.fog = false;
    glowMat.opacityNode = clear.mul(pow(max(normalView.z, 0), 3).mul(0.35));
    const moon = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 24, 16), moonMat);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS * 3.4, 24, 16), glowMat);
    glow.renderOrder = 3;
    disc.renderOrder = 4;
    moon.add(glow, disc);
    group.add(stars, moon);
    this.moons.push(moon);
    this.nightParts.push(starGeo, starMat, moonMat, glowMat, disc.geometry, glow.geometry);
    this.placeMoon(moon, u.sun.value);
    return group;
  }

  /** Disposes a sky made by `createSky` and forgets it. */
  disposeSky(sky: SkyMesh): void {
    const i = this.skies.findIndex((s) => s.mesh === sky);
    if (i >= 0) this.skies.splice(i, 1);
    sky.removeFromParent();
    sky.geometry.dispose();
    sky.material.dispose();
  }

  dispose(): void {
    this.clouds.dispose();
    this.skies.length = 0;
    this.moons.length = 0;
    for (const part of this.nightParts.splice(0)) part.dispose();
  }

  /** The moon opposite the sun's bearing, 25° up, out among the stars. */
  private placeMoon(moon: THREE.Object3D, sun: THREE.Vector3): void {
    const flat = Math.hypot(sun.x, sun.z);
    const dx = flat > 1e-6 ? -sun.x / flat : 0;
    const dz = flat > 1e-6 ? -sun.z / flat : -1;
    const cos = Math.cos(MOON_ELEVATION);
    moon.position.set(dx * cos, Math.sin(MOON_ELEVATION), dz * cos).multiplyScalar(STAR_RADIUS);
  }

  /** The horizon's haze colour looking along `dir`: warmer (at a low sun) towards the sun. */
  private haze(dir: Vec3Node): Vec3Node {
    const u = this.u;
    const flat = normalize(vec3(dir.x, 0, dir.z).add(vec3(1e-4, 0, 0)));
    const toward = max(dot(flat, u.sunFlat), 0);
    return mix(u.fog, u.fogSun, pow(toward, 2.5));
  }

  private applyTo(sky: SkyMesh, reflection: boolean): void {
    const look = this.look;
    if (!look) return;
    const s = look.sky;
    sky.turbidity.value = s.turbidity;
    sky.rayleigh.value = s.rayleigh;
    sky.mieCoefficient.value = s.mieCoefficient;
    sky.mieDirectionalG.value = s.mieDirectionalG;
    sky.cloudCoverage.value = s.cloudCoverage;
    sky.cloudDensity.value = s.cloudDensity;
    sky.showSunDisc.value = s.sunDisc;
    sky.sunPosition.value.copy(this.u.sun.value);
    if (reflection) {
      // Without the sun disc and with a softer glow round it: blurred into the map, they make
      // anything facing a low sun (the start lights' panel, a car's paint) glare pale.
      sky.showSunDisc.value = 0;
      sky.mieCoefficient.value *= 0.3;
      sky.mieDirectionalG.value = 0.7;
    }
  }
}
