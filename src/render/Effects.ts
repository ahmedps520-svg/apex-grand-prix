import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import {
  emissive,
  float,
  luminance,
  mix,
  mrt,
  normalView,
  output,
  pass,
  renderOutput,
  screenUV,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

type ColorNode = THREE.Node<'vec4'>;
type FloatNode = THREE.Node<'float'>;

/** What the frame gets over the plain render. */
export interface EffectsOptions {
  /** A bloom on the emissive light (lamps, brake lights, lit windows). */
  bloom: boolean;
  /** Ambient occlusion: the contact shadows under the cars and along the walls. */
  ao: boolean;
  /** Screen-space ray-traced reflections on the surfaces that ask for them (see `reflective`). */
  ssr: boolean;
  /** Edge smoothing: the scene pass has no MSAA, so post-processing brings its own. */
  aa: 'off' | 'fxaa' | 'smaa';
  /** A light colour grade and vignette. */
  grade: boolean;
}

/** The MRT channel a surface writes its reflection into: (strength, roughness). */
const REFLECT = 'reflect';
/** What surfaces write by default: no reflection. */
const NO_REFLECTION = vec2(0, 1);

/** The surfaces that ask for reflections, and what they ask for (their MRT output). */
const requests = new Set<WeakRef<THREE.NodeMaterial>>();
const asked = new WeakMap<THREE.NodeMaterial, THREE.MRTNode>();
/** Pipelines tracing reflections right now. */
let tracing = 0;

/**
 * Asks for screen-space reflections on a surface: `strength` 0 … 1 of what the ray finds is
 * added to it, blurred by `roughness`. The request is attached to the material only while a
 * pipeline traces reflections: a material with an MRT output of its own draws nothing else
 * into a target without that MRT (the renderer's own frame buffer included).
 */
export function reflective(
  material: THREE.NodeMaterial,
  strength: FloatNode | number,
  roughness: FloatNode | number,
): void {
  asked.set(material, mrt({ [REFLECT]: vec2(strength, roughness) }));
  requests.add(new WeakRef(material));
  if (tracing > 0) attach(material, true);
}

function attach(material: THREE.NodeMaterial, on: boolean): void {
  const want = on ? (asked.get(material) ?? null) : null;
  if (material.mrtNode === want) return;
  material.mrtNode = want;
  material.needsUpdate = true;
}

/** A pipeline starts tracing reflections: the requests go on. */
export function startTracing(): void {
  tracing++;
  if (tracing === 1) setTracing(true);
}

/** A pipeline stops: the requests come off once no pipeline traces. */
export function stopTracing(): void {
  tracing = Math.max(0, tracing - 1);
  if (tracing === 0) setTracing(false);
}

/** Attaches (or takes off) every surface's reflection request. */
function setTracing(on: boolean): void {
  for (const ref of requests) {
    const material = ref.deref();
    if (material) attach(material, on);
    else requests.delete(ref);
  }
}

/** Surfaces with their reflection request attached now (for the tests). */
export function reflectionRequestsAttached(): number {
  let n = 0;
  for (const ref of requests) if (ref.deref()?.mrtNode) n++;
  return n;
}

/** The bloom, on the frame's emissive light alone: the sunlit road and the sky never glow. */
const BLOOM_STRENGTH = 0.4;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 0.25;
/** Ambient occlusion and the reflections at half resolution. */
const AO_SCALE = 0.5;
const SSR_SCALE = 0.5;
/** How far a reflected ray travels (metres) and how thick it takes the surfaces it meets to be. */
const SSR_DISTANCE = 60;
const SSR_THICKNESS = 0.6;

/**
 * Post-processing over the frame: the scene rendered to a texture with its normals, emissive
 * light and reflection requests kept apart; darkened in the corners the light can't reach (AO);
 * screen-space reflections traced along each reflective pixel's mirror ray (the wet road
 * mirrors the cars, the paint the cars beside it); a bloom on the emissive light; a light
 * grade; tone-mapped, then smoothed (SMAA before the tone mapping, FXAA after it).
 */
export class Effects {
  readonly pipeline: THREE.RenderPipeline;
  /** A key for the options, to tell when a rebuild is due. */
  readonly key: string;
  private readonly glow: ReturnType<typeof bloom> | null = null;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    readonly options: EffectsOptions,
  ) {
    this.key = effectsKey(options);
    const scenePass = pass(scene, camera);
    const outputs: Record<string, THREE.Node> = { output, emissive };
    if (options.ao || options.ssr) outputs.normal = normalView;
    if (options.ssr) outputs[REFLECT] = NO_REFLECTION;
    scenePass.setMRT(mrt(outputs));

    let colour = scenePass.getTextureNode('output') as ColorNode;
    if (options.ao) {
      const occlusion = ao(
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('normal'),
        camera,
      );
      occlusion.resolutionScale = AO_SCALE;
      colour = colour.mul(occlusion.getTextureNode()) as ColorNode;
    }
    if (options.ssr) {
      startTracing();
      // The tracer samples its inputs where the rays land, so it gets the pass's own textures
      // (the frame as rendered, before the occlusion).
      const request = scenePass.getTextureNode(REFLECT);
      const traced = ssr(
        scenePass.getTextureNode('output'),
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('normal') as unknown as THREE.Node<'vec3'>,
        {
          metalnessNode: request.r,
          roughnessNode: request.g,
          camera,
        },
      );
      traced.resolutionScale = SSR_SCALE;
      traced.maxDistance.value = SSR_DISTANCE;
      traced.thickness.value = SSR_THICKNESS;
      traced.quality.value = 0.6;
      // What the rays find, already weighted by the surface's strength, on top of the frame.
      colour = vec4(colour.rgb.add(traced.rgb), colour.a) as ColorNode;
    }
    if (options.bloom) {
      const glow = bloom(
        scenePass.getTextureNode('emissive') as ColorNode,
        BLOOM_STRENGTH,
        BLOOM_RADIUS,
        BLOOM_THRESHOLD,
      );
      this.glow = glow;
      colour = colour.add(glow) as ColorNode;
    }
    if (options.grade) colour = grade(colour);

    this.pipeline = new THREE.RenderPipeline(renderer);
    if (options.aa === 'fxaa') {
      // FXAA works on the finished, display-ready image.
      this.pipeline.outputColorTransform = false;
      this.pipeline.outputNode = fxaa(renderOutput(colour));
    } else if (options.aa === 'smaa') {
      // SMAA before the tone mapping, which the pipeline then applies.
      this.pipeline.outputNode = smaa(colour);
    } else {
      this.pipeline.outputNode = colour;
    }
  }

  /** The bloom's numbers, for tuning by eye (the debug API). */
  tune(strength: number, radius: number, threshold: number): void {
    if (!this.glow) return;
    this.glow.strength.value = strength;
    this.glow.radius.value = radius;
    this.glow.threshold.value = threshold;
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
    if (this.options.ssr) stopTracing();
  }
}

/** Nothing to add over the plain render (which keeps the renderer's MSAA). */
export const noEffects = (o: EffectsOptions): boolean => !o.bloom && !o.ao && !o.ssr && !o.grade;

export const effectsKey = (o: EffectsOptions): string =>
  `${o.bloom ? 'b' : ''}${o.ao ? 'a' : ''}${o.ssr ? 'r' : ''}${o.grade ? 'g' : ''}:${o.aa}`;

/** A touch more contrast and colour, and the corners a little darker, like a camera's lens. */
function grade(colour: ColorNode): ColorNode {
  const rgb = colour.rgb;
  const grey = vec3(luminance(rgb));
  const saturated = mix(grey, rgb, 1.08);
  // Contrast around a mid grey in linear light.
  const mid = float(0.18);
  const contrasted = saturated.div(mid).pow(1.06).mul(mid);
  const edge = screenUV.sub(0.5).length().mul(1.35);
  const vignette = mix(float(1), float(0.84), smoothstep(0.55, 1.1, edge));
  return vec4(contrasted.mul(vignette), colour.a) as ColorNode;
}
