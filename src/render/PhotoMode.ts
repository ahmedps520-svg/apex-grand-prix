import { dof } from 'three/addons/tsl/display/DepthOfFieldNode.js';
import { sepia } from 'three/addons/tsl/display/Sepia.js';
import {
  float,
  hash,
  length,
  luminance,
  mix,
  mrt,
  output,
  pass,
  renderOutput,
  saturation,
  screenCoordinate,
  screenSize,
  screenUV,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import * as THREE from 'three/webgpu';

/**
 * Photo mode: a free camera around a car, a post-processing chain for the picture (exposure,
 * contrast, saturation, colour filters, vignette, film grain and depth of field), PNG capture
 * with an optional watermark, and the mouse / touch / keyboard / controller handling for the
 * camera. The panel with the settings is `ui/menu/PhotoScreen.tsx`.
 */

// ------------------------------------------------------------------ settings

export type PhotoFilter = 'none' | 'warm' | 'cool' | 'mono' | 'sepia';

export const PHOTO_FILTERS: ReadonlyArray<{ value: PhotoFilter; text: string }> = [
  { value: 'none', text: 'None' },
  { value: 'warm', text: 'Warm' },
  { value: 'cool', text: 'Cool' },
  { value: 'mono', text: 'Black & white' },
  { value: 'sepia', text: 'Sepia' },
];

/** Aperture stops the panel offers (f-numbers). */
export const PHOTO_APERTURES: readonly number[] = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16, 22];

/** Vertical field of view range, degrees. */
export const PHOTO_FOV_MIN = 10;
export const PHOTO_FOV_MAX = 100;
/** Camera roll range, ± degrees. */
export const PHOTO_ROLL_MAX = 45;
/** Manual focus range, metres. */
export const PHOTO_FOCUS_MIN = 0.5;
export const PHOTO_FOCUS_MAX = 300;
/** The camera never goes lower than this above the ground, metres. */
export const PHOTO_MIN_CLEARANCE = 0.2;

/** The camera's lens: shared with the panel's sliders (a `PhotoSettings` is one). */
export interface PhotoLens {
  /** Vertical field of view, degrees (10 … 100). */
  fov: number;
  /** Degrees, ± 45; positive turns the picture clockwise. */
  roll: number;
}

/** Everything the photo panel sets. A plain object, so it can be kept or saved as it is. */
export interface PhotoSettings extends PhotoLens {
  /** Exposure compensation, stops (−3 … +3). */
  exposure: number;
  /** 1 leaves the picture as it is (0.5 … 1.5). */
  contrast: number;
  /** 1 leaves the picture as it is, 0 is grey (0 … 2). */
  saturation: number;
  /** Darkening towards the corners, 0 … 1. */
  vignette: number;
  /** Film grain, 0 … 1. */
  grain: number;
  filter: PhotoFilter;
  /** Depth of field (the pipeline ignores it where it isn't supported). */
  dof: boolean;
  /** Focus on the car; otherwise at `focusDistance`. While on, the pipeline keeps `focusDistance` up to date. */
  autofocus: boolean;
  /** Metres along the view direction (0.5 … 300). */
  focusDistance: number;
  /** f-number (1.4 … 22): smaller means less in focus and a bigger blur. */
  aperture: number;
  /** Put a small "APEX GRAND PRIX" mark in the saved picture's corner. */
  watermark: boolean;
  /** Whether the side panel is shown (hide it to see the whole picture). */
  showPanel: boolean;
}

export function defaultPhotoSettings(): PhotoSettings {
  return {
    fov: 50,
    roll: 0,
    exposure: 0,
    contrast: 1,
    saturation: 1,
    vignette: 0.25,
    grain: 0,
    filter: 'none',
    dof: false,
    autofocus: true,
    focusDistance: 6,
    aperture: 2.8,
    watermark: true,
    showPanel: true,
  };
}

const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;

/** `value` if it is a finite number, otherwise `fallback`. */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function finiteVector(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

// ------------------------------------------------------------------ camera

/**
 * Camera controls for one frame, each −1 … 1 (a stick's deflection or a held key); the camera
 * scales them by its speeds and the frame time.
 */
export interface PhotoCameraInput {
  /** Swing the view right (+) or left: the camera circles the other way round the car. */
  orbitX: number;
  /** Tilt the view down (+, the camera rises) or up. */
  orbitY: number;
  /** Move the camera right (+) or left, keeping its angle. */
  moveX: number;
  /** Move the camera up (+) or down. */
  moveY: number;
  /** Move closer (+) or further away. */
  zoom: number;
  /** Roll the picture clockwise (+) or anticlockwise. */
  roll: number;
}

export function idlePhotoInput(): PhotoCameraInput {
  return { orbitX: 0, orbitY: 0, moveX: 0, moveY: 0, zoom: 0, roll: 0 };
}

const INPUT_KEYS = ['orbitX', 'orbitY', 'moveX', 'moveY', 'zoom', 'roll'] as const;

/** Radians per second at full deflection. */
const ORBIT_SPEED = 1.6;
/** Distance changes by e^ZOOM_SPEED per second at full deflection. */
const ZOOM_SPEED = 1.2;
/** Moves at this many times the camera distance per second (but at least 1 m/s). */
const MOVE_SPEED = 0.7;
/** Degrees per second. */
const ROLL_SPEED = 40;
/** How quickly the camera follows the controls (1/s): eases starts and stops. */
const RESPONSE = 12;
const MIN_DISTANCE = 0.8;
const MAX_DISTANCE = 250;
/** Largest pan or height offset of the focus point from the car, metres. */
const MAX_OFFSET = 40;
const MAX_PITCH = 85 * DEG;
const DEFAULT_DISTANCE = 6;
const DEFAULT_PITCH = 12 * DEG;
/** Focus point above the car's origin (its centre of mass) when nothing better is known. */
const DEFAULT_HEIGHT = 0.15;
/** Closer than this, the game camera is inside or on the car: start from a default view. */
const MIN_START_DISTANCE = 1.5;

const _forward = new THREE.Vector3();
const _position = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/**
 * A free camera for photos. It orbits a focus point near the target car (yaw, pitch and
 * distance); the focus point can be moved sideways (pan) and up or down (height), so the car
 * sits wherever the picture needs it and stays there while the camera circles. It also rolls
 * and zooms (field of view, 10–100°). The camera always stays at least 20 cm above the ground
 * (y = `ground`), and bad input (NaN, infinities, a huge frame time) can't make it NaN.
 *
 * Pure maths apart from writing the result into `camera`, so it can be unit tested.
 */
export class PhotoCamera {
  /** The camera the photo is rendered with: `update()` places it. */
  readonly camera: THREE.PerspectiveCamera;
  /** Field of view and roll, usually the photo settings (the panel's sliders change them). */
  lens: PhotoLens;
  /** Height of the ground, metres (the tracks are flat, at 0). */
  ground = 0;
  /** Direction the camera looks from, radians (0: from +z towards −z). */
  yaw = 0;
  /** Elevation above the focus point, radians (positive: looking down). */
  pitch = DEFAULT_PITCH;
  /** From the focus point, metres. */
  distance = DEFAULT_DISTANCE;
  /** Focus point offset sideways (along the view's right) from the car, metres. */
  pan = 0;
  /** Focus point offset upwards from the car, metres. */
  height = DEFAULT_HEIGHT;
  /** The point the camera looks at (updated by `update()`). */
  readonly focus = new THREE.Vector3();
  /** The car (updated by `update()`; the last good one if a target was NaN). */
  readonly target = new THREE.Vector3();
  /** The controls, eased. */
  private readonly rates = idlePhotoInput();

  constructor(
    lens: PhotoLens = { fov: 50, roll: 0 },
    camera = new THREE.PerspectiveCamera(lens.fov, 16 / 9, 0.1, 3200),
  ) {
    this.lens = lens;
    this.camera = camera;
    this.apply();
  }

  setAspect(aspect: number): void {
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /**
   * Starts from where the game camera `from` is: same position, direction, field of view and
   * roll, now circling the car at `target`. If the game camera was inside or on the car
   * (onboard), starts behind the car instead, looking the same way.
   */
  reset(from: THREE.PerspectiveCamera, target: THREE.Vector3): void {
    for (const key of INPUT_KEYS) this.rates[key] = 0;
    if (finiteVector(target)) this.target.copy(target);
    from.updateMatrixWorld();
    const position = from.getWorldPosition(_position);
    const forward = from.getWorldDirection(_forward);
    this.camera.aspect = from.aspect;
    this.camera.near = from.near;
    this.camera.far = from.far;
    this.lens.fov = clamp(finite(from.fov, 50), PHOTO_FOV_MIN, PHOTO_FOV_MAX);
    this.lens.roll = 0;

    const flat = Math.hypot(forward.x, forward.z);
    let placed = false;
    if (flat > 0.05 && finiteVector(position) && finiteVector(forward)) {
      this.yaw = Math.atan2(-forward.x, -forward.z);
      // Along the view ray to the vertical plane through the car, square to the view.
      const along =
        ((this.target.x - position.x) * forward.x + (this.target.z - position.z) * forward.z) /
        flat;
      const t = along / flat;
      if (t >= MIN_START_DISTANCE && t <= MAX_DISTANCE) {
        const fx = position.x + forward.x * t;
        const fy = position.y + forward.y * t;
        const fz = position.z + forward.z * t;
        this.distance = t;
        this.pitch = Math.asin(clamp(-forward.y, -1, 1));
        this.pan =
          (fx - this.target.x) * Math.cos(this.yaw) - (fz - this.target.z) * Math.sin(this.yaw);
        this.height = fy - this.target.y;
        placed = true;
        // Roll: how far the game camera's x axis turned from level about the view direction.
        _right.crossVectors(forward, WORLD_UP).normalize();
        _up.crossVectors(_right, forward);
        _axis.set(1, 0, 0).applyQuaternion(from.getWorldQuaternion(_quat));
        const roll = Math.atan2(_axis.dot(_up), _axis.dot(_right)) / DEG;
        this.lens.roll = clamp(finite(roll, 0), -PHOTO_ROLL_MAX, PHOTO_ROLL_MAX);
      }
    }
    if (!placed) {
      this.pitch = DEFAULT_PITCH;
      this.distance = DEFAULT_DISTANCE;
      this.pan = 0;
      this.height = DEFAULT_HEIGHT;
    }
    this.apply();
  }

  /** Swings the view right (+) and tilts it down (+) by these angles, radians (mouse drags). */
  orbitBy(right: number, down: number): void {
    this.yaw -= finite(right, 0);
    this.pitch += finite(down, 0);
    this.apply();
  }

  /** Moves the camera right (+) and up (+), metres, keeping its angle (mouse drags). */
  moveBy(right: number, up: number): void {
    this.pan += finite(right, 0);
    this.height += finite(up, 0);
    this.apply();
  }

  /** Multiplies the distance (wheel, pinch): below 1 moves closer. */
  zoomBy(factor: number): void {
    if (Number.isFinite(factor) && factor > 0) this.distance *= factor;
    this.apply();
  }

  /** Metres per CSS pixel at the focus point, for a view `viewHeight` CSS pixels tall. */
  metresPerPixel(viewHeight: number): number {
    const fov = clamp(finite(this.lens.fov, 50), PHOTO_FOV_MIN, PHOTO_FOV_MAX) * DEG;
    return (2 * this.distance * Math.tan(fov / 2)) / Math.max(viewHeight, 1);
  }

  /**
   * Moves the camera by this frame's controls and places `camera` looking at the car at
   * `target`. Returns true when the controls changed the lens (roll), so a panel showing it
   * can refresh.
   */
  update(dt: number, input: PhotoCameraInput, target: THREE.Vector3): boolean {
    const step = clamp(finite(dt, 0), 0, 0.1);
    if (finiteVector(target)) this.target.copy(target);
    const ease = 1 - Math.exp(-step * RESPONSE);
    const r = this.rates;
    for (const key of INPUT_KEYS) {
      const wanted = clamp(finite(input[key], 0), -1, 1);
      r[key] += (wanted - r[key]) * ease;
      if (Math.abs(r[key]) < 1e-4 && wanted === 0) r[key] = 0;
    }
    this.yaw -= r.orbitX * ORBIT_SPEED * step;
    this.pitch += r.orbitY * ORBIT_SPEED * step;
    this.distance *= Math.exp(-r.zoom * ZOOM_SPEED * step);
    const move = Math.max(1, this.distance * MOVE_SPEED) * step;
    this.pan += r.moveX * move;
    this.height += r.moveY * move;
    const roll = this.lens.roll;
    this.lens.roll = finite(roll, 0) + r.roll * ROLL_SPEED * step;
    this.apply();
    return this.lens.roll !== roll;
  }

  /** Clamps the state and writes the pose into `camera`. */
  private apply(): void {
    const lens = this.lens;
    lens.fov = clamp(finite(lens.fov, 50), PHOTO_FOV_MIN, PHOTO_FOV_MAX);
    lens.roll = clamp(finite(lens.roll, 0), -PHOTO_ROLL_MAX, PHOTO_ROLL_MAX);
    this.yaw = finite(this.yaw, 0) % (Math.PI * 2);
    this.distance = clamp(finite(this.distance, DEFAULT_DISTANCE), MIN_DISTANCE, MAX_DISTANCE);
    this.pan = clamp(finite(this.pan, 0), -MAX_OFFSET, MAX_OFFSET);
    const ground = finite(this.ground, 0);
    const target = this.target;
    // The focus point stays above the ground…
    this.height = clamp(finite(this.height, DEFAULT_HEIGHT), ground - target.y, MAX_OFFSET);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);
    this.focus.set(
      target.x + cosYaw * this.pan,
      target.y + this.height,
      target.z - sinYaw * this.pan,
    );
    // …and the camera 20 cm above it: the lowest pitch that keeps it there at this distance.
    const lowest = Math.asin(
      clamp((ground + PHOTO_MIN_CLEARANCE - this.focus.y) / this.distance, -1, 1),
    );
    this.pitch = clamp(finite(this.pitch, DEFAULT_PITCH), Math.max(-MAX_PITCH, lowest), MAX_PITCH);
    const cosPitch = Math.cos(this.pitch);
    const camera = this.camera;
    camera.position.set(
      this.focus.x + this.distance * cosPitch * sinYaw,
      this.focus.y + this.distance * Math.sin(this.pitch),
      this.focus.z + this.distance * cosPitch * cosYaw,
    );
    // Rounding can't be allowed to put it under the ground either.
    camera.position.y = Math.max(camera.position.y, ground + PHOTO_MIN_CLEARANCE);
    camera.up.set(0, 1, 0);
    camera.lookAt(this.focus);
    camera.rotateZ(lens.roll * DEG);
    if (camera.fov !== lens.fov) {
      camera.fov = lens.fov;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }
}

// ------------------------------------------------------------------ pipeline

/** Colour filters: a tint, and how much of black & white and of sepia. */
const FILTER_LOOKS: Record<
  PhotoFilter,
  { tint: [number, number, number]; mono: number; sepia: number }
> = {
  none: { tint: [1, 1, 1], mono: 0, sepia: 0 },
  warm: { tint: [1.08, 1, 0.84], mono: 0, sepia: 0 },
  cool: { tint: [0.88, 0.98, 1.12], mono: 0, sepia: 0 },
  mono: { tint: [1, 1, 1], mono: 1, sepia: 0 },
  sepia: { tint: [1, 1, 1], mono: 0, sepia: 1 },
};

/** Depth of field: the largest blur radius, pixels of a 1080-line picture, at f/2.8 and 50 mm. */
const BOKEH_RADIUS = 14;
const MAX_BOKEH_RADIUS = 28;

/** A three.js node: what TSL functions take and return. */
type AnyNode = THREE.Node;
type ColorNode = THREE.Node<'vec4'>;

/**
 * The photo's rendering: the scene, then depth of field, exposure, the renderer's tone
 * mapping, contrast, saturation, a colour filter, vignette and film grain, built from TSL nodes
 * on three.js's `RenderPipeline` (the r183+ name of `PostProcessing`). Every setting is a
 * uniform, so changing one never recompiles anything; turning depth of field on or off swaps
 * the output node (one recompile of the final pass).
 *
 * Depth of field uses three's `DepthOfFieldNode` (a gather bokeh at half resolution). It runs on
 * WebGPU and on the WebGL2 backend alike; `dofSupported` is false only where the WebGL2 context
 * can't render to the half-float targets it needs, and `dofNote` then says why.
 */
export class PhotoPipeline {
  readonly settings: PhotoSettings;
  readonly dofSupported: boolean;
  /** Why depth of field is off here ('' when it is supported). */
  readonly dofNote: string;
  private readonly renderer: THREE.WebGPURenderer;
  private readonly pipeline: THREE.RenderPipeline;
  private readonly scenePass: THREE.PassNode;
  private camera: THREE.PerspectiveCamera;
  private readonly exposure = uniform(1);
  private readonly contrast = uniform(1);
  private readonly saturation = uniform(1);
  private readonly tint = uniform(new THREE.Vector3(1, 1, 1));
  private readonly mono = uniform(0);
  private readonly sepia = uniform(0);
  private readonly vignette = uniform(0);
  private readonly grain = uniform(0);
  private readonly seed = uniform(0);
  private readonly focusDistance = uniform(6);
  private readonly focalRange = uniform(10);
  private readonly bokehScale = uniform(8);
  private readonly plainOutput: AnyNode;
  private dofOutput: AnyNode | null = null;
  private dofNode: { dispose(): void } | null = null;
  private dofShown = false;
  private focusTarget: THREE.Vector3 | null = null;
  private frame = 0;

  constructor(
    renderer: THREE.WebGPURenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    settings: PhotoSettings = defaultPhotoSettings(),
  ) {
    this.renderer = renderer;
    this.camera = camera;
    this.settings = settings;
    const support = dofSupport(renderer);
    this.dofSupported = support === '';
    this.dofNote = support;
    this.scenePass = pass(scene, camera);
    // An MRT, so the surfaces that ask the game's passes for reflections (their own MRT
    // channel) still write their colour here.
    this.scenePass.setMRT(mrt({ output }));
    this.plainOutput = this.grade(this.scenePass.getTextureNode('output'));
    this.pipeline = new THREE.RenderPipeline(renderer, this.plainOutput);
    // Tone mapping and sRGB happen in `grade`, before the adjustments made on the final image.
    this.pipeline.outputColorTransform = false;
  }

  /** Renders another scene or from another camera. */
  setScene(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    this.scenePass.scene = scene;
    this.scenePass.camera = camera;
    this.camera = camera;
  }

  /** With autofocus on, keeps this point (the car) in focus; null focuses at `focusDistance`. */
  setFocusTarget(point: THREE.Vector3 | null): void {
    this.focusTarget = point;
  }

  /**
   * Compiles the scene's materials for the photo's render target ahead of the first frame
   * (optional: without it the first frame takes longer).
   */
  async compile(): Promise<void> {
    await this.scenePass.compileAsync(this.renderer);
  }

  /** Renders the photo to the canvas (or to the renderer's current render target). */
  render(): void {
    const s = this.settings;
    this.exposure.value = 2 ** clamp(finite(s.exposure, 0), -5, 5);
    this.contrast.value = clamp(finite(s.contrast, 1), 0, 3);
    this.saturation.value = clamp(finite(s.saturation, 1), 0, 3);
    const look = FILTER_LOOKS[s.filter] ?? FILTER_LOOKS.none;
    this.tint.value.set(...look.tint);
    this.mono.value = look.mono;
    this.sepia.value = look.sepia;
    this.vignette.value = clamp(finite(s.vignette, 0), 0, 1);
    this.grain.value = clamp(finite(s.grain, 0), 0, 1);
    this.frame = (this.frame + 1) % 997;
    this.seed.value = this.frame * 101;

    const withDof = s.dof && this.dofSupported;
    if (withDof) this.updateFocus();
    if (withDof !== this.dofShown) {
      this.dofShown = withDof;
      this.pipeline.outputNode = withDof ? this.dofGraph() : this.plainOutput;
      this.pipeline.needsUpdate = true;
    }
    this.pipeline.render();
  }

  dispose(): void {
    this.pipeline.dispose();
    this.scenePass.dispose();
    this.dofNode?.dispose();
    this.dofNode = null;
    this.dofOutput = null;
  }

  /** Depth-of-field uniforms from the settings: focus, and range and blur from the aperture. */
  private updateFocus(): void {
    const s = this.settings;
    const camera = this.camera;
    let focus = clamp(finite(s.focusDistance, 6), PHOTO_FOCUS_MIN, PHOTO_FOCUS_MAX);
    const target = this.focusTarget;
    if (s.autofocus && target && finiteVector(target)) {
      camera.getWorldDirection(_forward);
      camera.getWorldPosition(_position);
      const along = _forward.dot(_axis.subVectors(target, _position));
      focus = clamp(finite(along, focus), PHOTO_FOCUS_MIN, PHOTO_FOCUS_MAX);
      s.focusDistance = Math.round(focus * 10) / 10;
    }
    const f = clamp(finite(s.aperture, 2.8), 1, 32);
    this.focusDistance.value = focus;
    // Everything within the range is (nearly) sharp; smaller f-numbers narrow it.
    this.focalRange.value = clamp(focus * (f / 1.4), 0.25, 5000);
    // Longer lenses (narrower views) and smaller f-numbers blur the background more.
    const fov = clamp(finite(camera.fov, 50), PHOTO_FOV_MIN, PHOTO_FOV_MAX) * DEG;
    const focalLength = 12 / Math.tan(fov / 2);
    const lens = clamp(Math.sqrt(focalLength / 50), 0.7, 1.8);
    const lines = Math.max(this.renderer.domElement.height, 1) / 1080;
    const radius = Math.min(BOKEH_RADIUS * (2.8 / f) ** 0.75 * lens, MAX_BOKEH_RADIUS);
    this.bokehScale.value = radius * lines;
  }

  /** The output with depth of field, built the first time it is needed. */
  private dofGraph(): AnyNode {
    if (!this.dofOutput) {
      const node = dof(
        this.scenePass.getTextureNode('output'),
        this.scenePass.getViewZNode(),
        this.focusDistance,
        this.focalRange,
        this.bokehScale,
      );
      this.dofNode = node;
      this.dofOutput = this.grade(node as unknown as ColorNode);
    }
    return this.dofOutput;
  }

  /** Exposure and tone mapping on the HDR colour, then the adjustments on the final sRGB image. */
  private grade(hdr: ColorNode): AnyNode {
    const display = renderOutput(vec4(hdr.rgb.mul(this.exposure), 1));
    let rgb = display.rgb;
    rgb = rgb.sub(0.5).mul(this.contrast).add(0.5).clamp(0, 1);
    rgb = saturation(rgb, this.saturation);
    rgb = mix(rgb, vec3(luminance(rgb)), this.mono);
    rgb = mix(rgb, (sepia(vec4(rgb, 1)) as ColorNode).rgb, this.sepia);
    rgb = rgb.mul(this.tint);
    // Vignette: round whatever the aspect, 0 in the middle and 1 in the corners.
    const aspect = screenSize.x.div(screenSize.y);
    const offset = screenUV.sub(0.5).mul(vec2(aspect, 1));
    const corner = length(offset).div(length(vec2(aspect, 1).mul(0.5)));
    rgb = rgb.mul(float(1).sub(smoothstep(0.3, 1.05, corner).mul(this.vignette).mul(0.85)));
    // Grain: monochrome noise per pixel, strongest in the mid-tones, new every frame.
    const pixel = screenCoordinate.floor();
    const noise = hash(pixel.x.add(hash(pixel.y.add(this.seed)).mul(1048576))).sub(0.5);
    const tone = luminance(rgb).clamp(0, 1);
    const weight = tone.mul(tone.oneMinus()).mul(3).add(0.25);
    rgb = rgb.add(noise.mul(this.grain).mul(weight).mul(0.32));
    return vec4(rgb.clamp(0, 1), 1);
  }
}

/** '' if depth of field can run with this renderer, otherwise why not. */
function dofSupport(renderer: THREE.WebGPURenderer): string {
  const backend = renderer.backend as unknown as {
    isWebGLBackend?: boolean;
    extensions?: { has(name: string): boolean };
  };
  if (!backend.isWebGLBackend) return '';
  // Its blur passes render to half-float targets (two at once for the near and far fields).
  const extensions = backend.extensions;
  if (extensions && !extensions.has('EXT_color_buffer_float')) {
    return 'Depth of field needs half-float render targets, which this WebGL2 device lacks.';
  }
  return '';
}

// ------------------------------------------------------------------ capture

export interface CaptureOptions {
  /** Adds "APEX GRAND PRIX", small, in the bottom-right corner. */
  watermark?: boolean;
}

/**
 * Renders a frame with `render` (e.g. `() => pipeline.render()`) and saves it as a PNG at the
 * canvas's resolution. The canvas is copied in the same task as the render: WebGL2 clears its
 * drawing buffer once the frame is shown (the renderer doesn't preserve it), and a WebGPU
 * canvas only holds the frame until the next one starts. If that copy comes out blank anyway,
 * the frame is rendered again into a render target and read back from there.
 */
export async function capturePng(
  renderer: THREE.WebGPURenderer,
  render: () => void,
  options: CaptureOptions = {},
): Promise<Blob> {
  const source = renderer.domElement;
  const width = Math.max(source.width, 1);
  const height = Math.max(source.height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas for the photo.');
  render();
  ctx.drawImage(source, 0, 0, width, height);
  if (isBlank(canvas)) await readBack(renderer, render, ctx, width, height);
  if (options.watermark) drawWatermark(ctx, width, height);
  return toPng(canvas);
}

/**
 * Renders into a render target and copies its pixels into `ctx`. Rows come back top first from
 * WebGPU (padded to 256 bytes) and bottom first from WebGL2.
 */
export async function readBack(
  renderer: THREE.WebGPURenderer,
  render: () => void,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): Promise<void> {
  const target = new THREE.RenderTarget(width, height, { depthBuffer: false });
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    render();
  } finally {
    renderer.setRenderTarget(previous);
  }
  try {
    const data = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
    if (!(data instanceof Uint8Array)) throw new Error('Unexpected pixel format');
    const row = width * 4;
    const stride = height > 1 ? (data.length - row) / (height - 1) : row;
    const bottomUp = (renderer.backend as unknown as { isWebGLBackend?: boolean }).isWebGLBackend;
    const image = ctx.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      const from = (bottomUp ? height - 1 - y : y) * stride;
      image.data.set(data.subarray(from, from + row), y * row);
    }
    ctx.putImageData(image, 0, 0);
  } finally {
    target.dispose();
  }
}

/** True if a picture is empty: fully transparent, or one flat colour. */
function isBlank(canvas: HTMLCanvasElement): boolean {
  const probe = document.createElement('canvas');
  probe.width = 32;
  probe.height = 18;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(canvas, 0, 0, probe.width, probe.height);
  const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
  let opaque = false;
  let varied = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! > 0) opaque = true;
    for (let c = 0; c < 3; c++) if (Math.abs(data[i + c]! - data[c]!) > 2) varied = true;
    if (opaque && varied) return false;
  }
  return true;
}

/** "APEX GRAND PRIX" in the game's logo style, small, in the bottom-right corner. */
export function drawWatermark(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  const size = clamp(Math.round(Math.min(height, width * 0.75) * 0.024), 11, 72);
  const margin = Math.round(size * 0.9);
  ctx.save();
  ctx.font = `italic 800 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(size * 0.08)}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const first = 'APEX ';
  const second = 'GRAND PRIX';
  const x = width - margin - ctx.measureText(first).width - ctx.measureText(second).width;
  const y = height - margin;
  ctx.globalAlpha = 0.88;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';
  ctx.shadowBlur = size * 0.35;
  ctx.shadowOffsetY = size * 0.06;
  ctx.fillStyle = '#f2f4f8';
  ctx.fillText(first, x, y);
  ctx.fillStyle = '#ff3b2f';
  ctx.fillText(second, x + ctx.measureText(first).width, y);
  ctx.restore();
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded.'))),
      'image/png',
    );
  });
}

/** A file name for a photo taken now: apex-grand-prix-2026-09-23-101530.png. */
export function photoFileName(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `apex-grand-prix-${day}-${time}.png`;
}

/** Offers the photo as a download. */
export function downloadPhoto(blob: Blob, name = photoFileName()): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ------------------------------------------------------------------ controls

/** What the photo controls read this frame. */
export interface PhotoControlsFrame {
  camera: PhotoCameraInput;
  /** One-shot presses: take the photo; show or hide the panel. */
  capture: boolean;
  togglePanel: boolean;
}

/** Standard-mapping gamepad buttons and axes. */
const PAD = { SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7 } as const;
const STICK_DEADZONE = 0.15;
/** Mouse / touch: radians of orbit per CSS pixel dragged, and zoom per wheel pixel. */
const DRAG_ORBIT = 0.006;
const WHEEL_ZOOM = 0.0015;

interface Pointer {
  x: number;
  y: number;
  /** Moves the camera instead of orbiting (right or middle button, or Shift held). */
  move: boolean;
}

/**
 * Mouse, touch, keyboard and controller handling for the photo camera.
 *
 * - Mouse / touch on the 3D view: drag to orbit; right-drag, Shift-drag or two fingers to move;
 *   wheel or pinch to zoom. These move the camera straight away.
 * - Keyboard (`read`): W/S zoom, A/D move sideways, R/F up and down, Q/E roll, J/L and I/K
 *   orbit (the arrow keys too while the panel is hidden), C takes the photo, H hides the panel.
 * - Controller (`read`): the right stick orbits; with the panel hidden the left stick moves,
 *   L2/R2 zoom and L1/R1 roll (with it shown they work the panel). □ / X takes the photo and
 *   △ / Y hides or shows the panel.
 */
export class PhotoControls {
  private readonly frameInput: PhotoControlsFrame = {
    camera: idlePhotoInput(),
    capture: false,
    togglePanel: false,
  };
  private readonly keys = new Set<string>();
  private readonly pointers = new Map<number, Pointer>();
  private readonly listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions]> =
    [];
  private previousButtons: boolean[] = [];
  private pendingCapture = false;
  private pendingToggle = false;
  /** Distance between two touching fingers, and their midpoint, when they last moved. */
  private span = 0;
  private readonly middle = { x: 0, y: 0 };

  constructor(
    private readonly surface: HTMLElement,
    private readonly camera: PhotoCamera,
  ) {
    this.listen(surface, 'pointerdown', (e) => this.onPointerDown(e as PointerEvent));
    this.listen(surface, 'pointermove', (e) => this.onPointerMove(e as PointerEvent));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.listen(surface, type, (e) => this.onPointerUp(e as PointerEvent));
    }
    this.listen(surface, 'wheel', (e) => this.onWheel(e as WheelEvent), { passive: false });
    this.listen(surface, 'contextmenu', (e) => e.preventDefault());
    this.listen(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    this.listen(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    this.listen(window, 'blur', () => this.keys.clear());
  }

  /**
   * This frame's camera controls from the keys and the pad, plus one-shot presses. With the
   * panel shown, the pad's left stick, triggers and shoulder buttons (and the arrow keys) stay
   * with the panel.
   */
  read(pad: Gamepad | null, panelOpen: boolean): PhotoControlsFrame {
    const out = this.frameInput;
    const input = out.camera;
    const key = (code: string) => (this.keys.has(code) ? 1 : 0);
    const arrows = panelOpen ? 0 : 1;
    input.orbitX = key('KeyL') - key('KeyJ') + arrows * (key('ArrowRight') - key('ArrowLeft'));
    input.orbitY = key('KeyK') - key('KeyI') + arrows * (key('ArrowDown') - key('ArrowUp'));
    input.moveX = key('KeyD') - key('KeyA');
    input.moveY = key('KeyR') - key('KeyF');
    input.zoom = key('KeyW') - key('KeyS');
    input.roll = key('KeyE') - key('KeyQ');
    out.capture = this.pendingCapture;
    out.togglePanel = this.pendingToggle;
    this.pendingCapture = false;
    this.pendingToggle = false;

    if (pad) {
      const buttons = pad.buttons.map((b) => b.pressed);
      const pressed = (i: number) => buttons[i] === true && this.previousButtons[i] !== true;
      this.previousButtons = buttons;
      const axis = (i: number) => stick(pad.axes[i] ?? 0);
      const value = (i: number) => pad.buttons[i]?.value ?? 0;
      input.orbitX += axis(2);
      input.orbitY += axis(3);
      if (!panelOpen) {
        input.moveX += axis(0);
        input.moveY -= axis(1);
        input.zoom += value(PAD.R2) - value(PAD.L2);
        input.roll += (buttons[PAD.R1] ? 1 : 0) - (buttons[PAD.L1] ? 1 : 0);
      }
      if (pressed(PAD.SQUARE)) out.capture = true;
      if (pressed(PAD.TRIANGLE)) out.togglePanel = true;
    } else {
      this.previousButtons = [];
    }
    for (const k of INPUT_KEYS) input[k] = clamp(input[k], -1, 1);
    return out;
  }

  dispose(): void {
    for (const [target, type, fn, options] of this.listeners) {
      target.removeEventListener(type, fn, options);
    }
    this.listeners.length = 0;
    this.keys.clear();
    this.pointers.clear();
  }

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    this.pointers.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      move: e.button === 1 || e.button === 2 || e.shiftKey,
    });
    this.surface.setPointerCapture?.(e.pointerId);
    this.measureFingers();
  }

  private onPointerMove(e: PointerEvent): void {
    const pointer = this.pointers.get(e.pointerId);
    if (!pointer) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (this.pointers.size >= 2) {
      // Two fingers: move with their midpoint, zoom with their spread.
      const middle = { ...this.middle };
      const span = this.span;
      this.measureFingers();
      const metres = this.camera.metresPerPixel(this.surface.clientHeight);
      this.camera.moveBy(-(this.middle.x - middle.x) * metres, (this.middle.y - middle.y) * metres);
      if (span > 0 && this.span > 0) this.camera.zoomBy(span / this.span);
      return;
    }
    if (pointer.move || e.shiftKey) {
      // The scene follows the pointer: the camera moves the other way.
      const metres = this.camera.metresPerPixel(this.surface.clientHeight);
      this.camera.moveBy(-dx * metres, dy * metres);
    } else {
      this.camera.orbitBy(dx * DRAG_ORBIT, dy * DRAG_ORBIT);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (!this.pointers.delete(e.pointerId)) return;
    this.measureFingers();
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const pixels =
      e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.camera.zoomBy(Math.exp(clamp(pixels, -400, 400) * WHEEL_ZOOM));
  }

  private measureFingers(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) {
      this.span = 0;
      return;
    }
    this.span = Math.hypot(a.x - b.x, a.y - b.y);
    this.middle.x = (a.x + b.x) / 2;
    this.middle.y = (a.y + b.y) / 2;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (!down) {
      this.keys.delete(e.code);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    this.keys.add(e.code);
    if (e.repeat) return;
    if (e.code === 'KeyC') this.pendingCapture = true;
    if (e.code === 'KeyH') this.pendingToggle = true;
  }

  private listen(
    target: EventTarget,
    type: string,
    fn: EventListener,
    options: AddEventListenerOptions = {},
  ): void {
    target.addEventListener(type, fn, options);
    this.listeners.push([target, type, fn, options]);
  }
}

/** A stick axis with a dead zone, and finer near the centre. */
function stick(value: number): number {
  const v = finite(value, 0);
  const magnitude = Math.abs(v);
  if (magnitude < STICK_DEADZONE) return 0;
  const t = Math.min((magnitude - STICK_DEADZONE) / (1 - STICK_DEADZONE), 1);
  return Math.sign(v) * t * t;
}
