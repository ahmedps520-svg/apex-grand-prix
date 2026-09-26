import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { emissive, mrt, normalView, output, pass } from 'three/tsl';
import * as THREE from 'three/webgpu';

/** What the frame gets over the plain render: nothing, a bloom, or a bloom with ambient occlusion. */
export type EffectsLevel = 'off' | 'bloom' | 'full';

type ColorNode = THREE.Node<'vec4'>;

/**
 * The bloom, on the frame's emissive light alone (the lamps, the brake lights, the strobes, the
 * lit windows and signs): the sunlit road and the sky never glow, so the day stays clean.
 */
const BLOOM_STRENGTH = 0.4;
const BLOOM_RADIUS = 0.3;
const BLOOM_THRESHOLD = 0.25;
/** Ambient occlusion at half resolution: the contact shadows under the cars and along the walls. */
const AO_SCALE = 0.5;

/**
 * Post-processing over the frame: the scene rendered to a texture with its emissive light kept
 * apart, darkened in the corners the light can't reach (full), with a bloom on the emissive
 * light (the brake lights, the lamps at night, the lit city), then tone-mapped to the screen.
 */
export class Effects {
  readonly pipeline: THREE.RenderPipeline;
  private readonly glow: ReturnType<typeof bloom>;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    readonly level: Exclude<EffectsLevel, 'off'>,
  ) {
    const scenePass = pass(scene, camera);
    scenePass.setMRT(
      mrt(level === 'full' ? { output, emissive, normal: normalView } : { output, emissive }),
    );
    let colour = scenePass.getTextureNode('output') as ColorNode;
    if (level === 'full') {
      const occlusion = ao(
        scenePass.getTextureNode('depth'),
        scenePass.getTextureNode('normal'),
        camera,
      );
      occlusion.resolutionScale = AO_SCALE;
      colour = colour.mul(occlusion.getTextureNode()) as ColorNode;
    }
    const glow = bloom(
      scenePass.getTextureNode('emissive') as ColorNode,
      BLOOM_STRENGTH,
      BLOOM_RADIUS,
      BLOOM_THRESHOLD,
    );
    this.glow = glow;
    this.pipeline = new THREE.RenderPipeline(renderer, colour.add(glow));
  }

  /** The bloom's numbers, for tuning by eye (the debug API). */
  tune(strength: number, radius: number, threshold: number): void {
    this.glow.strength.value = strength;
    this.glow.radius.value = radius;
    this.glow.threshold.value = threshold;
  }

  render(): void {
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
  }
}
