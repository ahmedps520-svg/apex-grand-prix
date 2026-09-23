import * as THREE from 'three/webgpu';
import { InputManager } from '../input/InputManager';
import { CarView } from '../render/CarView';
import { ChaseCamera } from '../render/ChaseCamera';
import { Cones } from '../render/Cones';
import { createCarRenderState, interpolateCar } from '../render/interpolate';
import type { RendererHost } from '../render/RendererHost';
import { TestGroundScene } from '../render/TestGroundScene';
import { SIM_HZ } from '../shared/protocol';
import { TEST_MULE } from '../sim/vehicle/spec';
import { HelpPanel } from '../ui/HelpPanel';
import { Hud } from '../ui/Hud';
import { PerfOverlay } from '../ui/PerfOverlay';
import type { Toasts } from '../ui/Toasts';
import { loadSettings, saveSettings, type QuickSettings } from './quickSettings';
import { SimClient } from './SimClient';

/** Read-only hooks for automated browser tests (and curious players with devtools open). */
export interface DebugApi {
  ready: boolean;
  backend: string;
  frames: number;
  simSteps: number;
  speed: number;
  errors: string[];
}

declare global {
  interface Window {
    __apex?: DebugApi;
  }
}

const STATS_INTERVAL = 0.5;

/** Round 1 game: one car on the test ground. Wires sim ⇄ input ⇄ renderer ⇄ UI together. */
export class Game {
  private readonly settings: QuickSettings = loadSettings();
  private readonly sim = new SimClient();
  private readonly input = new InputManager();
  private readonly world = new TestGroundScene();
  private readonly car = new CarView(TEST_MULE);
  private readonly cones: Cones;
  private readonly camera: ChaseCamera;
  private readonly carState = createCarRenderState();
  private readonly carPosition = new THREE.Vector3();
  private readonly hud: Hud;
  private readonly perf: PerfOverlay;
  private readonly help: HelpPanel;
  private readonly debug: DebugApi;

  private lastTime = -1;
  private frames = 0;
  private helpAutoHidden = false;
  private lastPadName = '';

  // Rolling stats for the overlay.
  private statTime = 0;
  private statFrames = 0;
  private statWorst = 0;
  private statSteps = 0;
  private statStepCount = 0;
  private statLastTotalSteps = 0;

  constructor(
    private readonly host: RendererHost,
    ui: HTMLElement,
    private readonly toasts: Toasts,
  ) {
    const { width, height } = host.renderer.domElement.getBoundingClientRect();
    this.camera = new ChaseCamera(width / Math.max(height, 1));
    this.camera.mode = this.settings.camera;
    if (new URLSearchParams(window.location.search).get('cam') === 'orbit')
      this.camera.mode = 'orbit';
    host.onResize((w, h) => this.camera.setAspect(w / h));
    host.setResolutionScale(this.settings.resolutionScale);

    this.world.scene.add(this.car.root);
    this.cones = new Cones(this.world.conePlacements, TEST_MULE.body);
    this.world.scene.add(this.cones.mesh);

    this.hud = new Hud(ui);
    this.hud.setUnits(this.settings.units);
    this.perf = new PerfOverlay(
      ui,
      (delta) => this.changeScale(delta),
      () => this.cycleCamera(),
      () => this.resetCar(),
    );
    this.perf.setVisible(this.settings.overlay);
    this.help = new HelpPanel(ui);

    this.debug = {
      ready: false,
      backend: host.backend,
      frames: 0,
      simSteps: 0,
      speed: 0,
      errors: [],
    };
    window.__apex = this.debug;
    this.sim.onError = (message) => {
      this.debug.errors.push(message);
      this.toasts.show(`Simulation error: ${message}`, { timeout: 0 });
    };
    this.sim.onWarning = (message) => this.toasts.show(message, { timeout: 6 });
  }

  async start(): Promise<void> {
    this.world.buildEnvironment(this.host.renderer);
    await this.sim.init(1);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.sim.pause();
      else this.sim.resume();
    });
    window.addEventListener('pageshow', () => this.sim.resume());
    window.addEventListener('gamepadconnected', (event) => {
      const pad = (event as GamepadEvent).gamepad;
      this.toasts.show(`Controller connected: ${pad.id.replace(/\s*\(.*\)\s*$/, '')}`);
    });
    window.addEventListener('gamepaddisconnected', () =>
      this.toasts.show('Controller disconnected'),
    );

    // Compile shaders before the first visible frame to avoid a hitch when driving starts.
    await this.host.renderer.compileAsync(this.world.scene, this.camera.camera);
    this.host.renderer.setAnimationLoop((time) => this.frame(time));
  }

  private frame(timeMs: number): void {
    const now = timeMs / 1000;
    const dt = this.lastTime < 0 ? 1 / 60 : Math.min(Math.max(now - this.lastTime, 0), 0.1);
    this.lastTime = now;

    this.input.update();
    this.handleActions();
    this.sim.tick(now, [this.input.driver]);

    const snapshot = this.sim.latest;
    const view = this.sim.latestView;
    if (snapshot && view) {
      interpolateCar(view, 0, snapshot.alpha, this.carState);
      this.car.update(this.carState);
      this.cones.update(dt, this.carState);
      this.camera.update(dt, this.carState);
      this.hud.update(this.carState);
      this.carPosition.set(this.carState.pos.x, this.carState.pos.y, this.carState.pos.z);
      this.world.follow(this.carPosition);
      this.statSteps += snapshot.steps;
      this.statStepCount++;
    }

    this.host.renderer.render(this.world.scene, this.camera.camera);

    this.frames++;
    if (this.frames === 2) document.body.classList.add('running');
    this.updateStats(dt);
    this.debug.ready = this.frames > 2 && snapshot !== null;
    this.debug.frames = this.frames;
    this.debug.simSteps = snapshot?.totalSteps ?? 0;
    this.debug.speed = this.carState.speed;
  }

  private handleActions(): void {
    const input = this.input;
    const padKey = input.padConnected ? input.padName : '';
    if (padKey !== this.lastPadName) {
      this.lastPadName = padKey;
      this.help.setPad(input.padConnected ? input.padFamily : null, input.padName);
    }
    const d = input.driver;
    if (!this.helpAutoHidden && (d.throttle > 0.1 || d.brake > 0.1 || Math.abs(d.steer) > 0.2)) {
      this.help.setVisible(false);
      this.helpAutoHidden = true;
    }
    for (const action of input.actions) {
      switch (action) {
        case 'reset':
          this.resetCar();
          break;
        case 'camera':
          this.cycleCamera();
          break;
        case 'overlay':
          this.perf.setVisible(!this.perf.isVisible);
          this.settings.overlay = this.perf.isVisible;
          saveSettings(this.settings);
          break;
        case 'help':
          this.helpAutoHidden = true;
          this.help.setVisible(!this.help.visible);
          break;
        case 'scaleUp':
          this.changeScale(0.1);
          break;
        case 'scaleDown':
          this.changeScale(-0.1);
          break;
        case 'units':
          this.settings.units = this.settings.units === 'metric' ? 'imperial' : 'metric';
          this.hud.setUnits(this.settings.units);
          saveSettings(this.settings);
          break;
      }
    }
  }

  private resetCar(): void {
    this.sim.command({ kind: 'resetCar', car: 0 });
    this.camera.reset();
  }

  private cycleCamera(): void {
    const mode = this.camera.cycle();
    if (mode !== 'orbit') {
      this.settings.camera = mode;
      saveSettings(this.settings);
    }
  }

  private changeScale(delta: number): void {
    const next = Math.round((this.host.scale + delta) * 10) / 10;
    this.host.setResolutionScale(next);
    this.settings.resolutionScale = this.host.scale;
    saveSettings(this.settings);
    this.toasts.show(`Resolution scale ${Math.round(this.host.scale * 100)}%`, { timeout: 1.5 });
  }

  private updateStats(dt: number): void {
    this.statTime += dt;
    this.statFrames++;
    this.statWorst = Math.max(this.statWorst, dt);
    if (this.statTime < STATS_INTERVAL) return;
    const snapshot = this.sim.latest;
    const totalSteps = snapshot?.totalSteps ?? 0;
    const info = this.host.renderer.info.render;
    const { width, height } = this.host.drawingBufferSize;
    const input = this.input;
    this.perf.update({
      version: __APP_VERSION__,
      backend: this.host.description,
      fps: this.statFrames / this.statTime,
      frameMs: (this.statTime / this.statFrames) * 1000,
      worstMs: this.statWorst * 1000,
      drawCalls: info.drawCalls,
      triangles: info.triangles,
      width,
      height,
      scale: this.host.scale,
      devicePixelRatio: window.devicePixelRatio || 1,
      simHz:
        this.statLastTotalSteps > 0
          ? (totalSteps - this.statLastTotalSteps) / this.statTime
          : SIM_HZ,
      stepsPerFrame: this.statStepCount > 0 ? this.statSteps / this.statStepCount : 0,
      stepCostUs: snapshot?.stepCostUs ?? 0,
      device:
        input.lastDevice === 'gamepad'
          ? input.padName
          : input.lastDevice === 'keyboard'
            ? 'Keyboard'
            : input.padConnected
              ? input.padName
              : 'none yet',
    });
    this.statLastTotalSteps = totalSteps;
    this.statTime = 0;
    this.statFrames = 0;
    this.statWorst = 0;
    this.statSteps = 0;
    this.statStepCount = 0;
  }
}
