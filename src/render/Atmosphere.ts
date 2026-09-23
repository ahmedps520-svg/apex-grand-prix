import { SkyMesh } from 'three/addons/objects/SkyMesh.js';
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  dot,
  float,
  fog,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  rangeFogFactor,
  smoothstep,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { SceneLook } from './sceneLook';
import { noiseTexture } from './textures';

/** The sky is a box around the viewer; it draws at the far plane whatever its size. */
const SKY_SIZE = 2800;

type Vec3Node = THREE.Node<'vec3'>;

/**
 * Sky and fog for a circuit. The sky is three.js's analytic daylight model (SkyMesh: sun, haze,
 * scattered clouds), graded towards a twilight gradient at dusk and blended into a grey cloud
 * deck for overcast and rain. The fog's colour glows towards the sun, and the sky melts into
 * the same colour at the horizon, so the far ground never shows an edge against the sky. One
 * set of uniforms drives the visible sky, the copy the reflections are made from, and the fog.
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
    fog: uniform(new THREE.Color()),
    fogSun: uniform(new THREE.Color()),
    fogNear: uniform(1),
    fogFar: uniform(2),
    /** Unit direction to the sun, and the same flattened onto the ground. */
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    sunFlat: uniform(new THREE.Vector3(0, 0, 1)),
  };
  private readonly skies: Array<{ mesh: SkyMesh; reflection: boolean }> = [];
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
    for (const { mesh, reflection } of this.skies) this.applyTo(mesh, reflection);
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
