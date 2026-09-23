import * as THREE from 'three/webgpu';

export type Backend = 'WebGPU' | 'WebGL2';

const MAX_DEVICE_PIXEL_RATIO = 2;

/**
 * Owns the three.js WebGPURenderer. It uses WebGPU when the browser has it and falls back to
 * three.js's WebGL2 backend automatically; `forceWebGL` skips WebGPU entirely.
 */
export class RendererHost {
  readonly renderer: THREE.WebGPURenderer;
  backend: Backend = 'WebGL2';
  private resolutionScale = 1;
  private readonly resizeListeners: Array<(width: number, height: number) => void> = [];

  constructor(
    private readonly container: HTMLElement,
    forceWebGL: boolean,
  ) {
    this.renderer = new THREE.WebGPURenderer({
      antialias: true,
      powerPreference: 'high-performance',
      forceWebGL,
    });
    // Neutral tone mapping keeps saturated paint colours (reds especially) true to their hue.
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.domElement.id = 'game-canvas';
    container.appendChild(this.renderer.domElement);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    const backend = (this.renderer as unknown as { backend: { isWebGPUBackend?: boolean } })
      .backend;
    this.backend = backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2';
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    this.resize();
  }

  /** Device pixels per CSS pixel actually rendered (device ratio capped at 2, × user scale). */
  get pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO) * this.resolutionScale;
  }

  get scale(): number {
    return this.resolutionScale;
  }

  setResolutionScale(scale: number): void {
    this.resolutionScale = Math.min(Math.max(scale, 0.25), 1.5);
    this.resize();
  }

  /** Called if the GPU device (WebGPU) or context (WebGL2) is lost. */
  onDeviceLost(listener: (message: string) => void): void {
    this.renderer.onDeviceLost = (info) => {
      console.error('Graphics device lost:', info.message);
      listener(info.message);
    };
  }

  onResize(listener: (width: number, height: number) => void): void {
    this.resizeListeners.push(listener);
  }

  /** Size of the drawing buffer in device pixels. */
  get drawingBufferSize(): { width: number; height: number } {
    const canvas = this.renderer.domElement;
    return { width: canvas.width, height: canvas.height };
  }

  resize(): void {
    const width = Math.max(this.container.clientWidth, 1);
    const height = Math.max(this.container.clientHeight, 1);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setSize(width, height);
    for (const listener of this.resizeListeners) listener(width, height);
  }
}
