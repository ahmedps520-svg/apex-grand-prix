import * as THREE from 'three/webgpu';
import { EngineAudio, type AudioFrame } from '../audio/EngineAudio';
import { InputManager } from '../input/InputManager';
import { CarView } from '../render/CarView';
import { ChaseCamera } from '../render/ChaseCamera';
import { Cones } from '../render/Cones';
import { createCarRenderState, interpolateCar } from '../render/interpolate';
import type { RendererHost } from '../render/RendererHost';
import { TestGroundScene } from '../render/TestGroundScene';
import {
  FLAG_LIMITER,
  FLAG_SHIFTING,
  SIM_HZ,
  neutralInput,
  type AidLevel,
  type SpawnPoint,
} from '../shared/protocol';
import { TEST_MULE } from '../sim/vehicle/spec';
import { HelpPanel } from '../ui/HelpPanel';
import { Hud } from '../ui/Hud';
import { PerfOverlay } from '../ui/PerfOverlay';
import { QuickMenu, choiceItem, percentItem, type MenuItem } from '../ui/QuickMenu';
import { TelemetryPanel } from '../ui/TelemetryPanel';
import type { Toasts } from '../ui/Toasts';
import { WheelSetup } from '../ui/WheelSetup';
import { DragTimer, formatDragResult } from './dragTimer';
import { loadSettings, saveSettings, type Settings } from './settings';
import { SimClient } from './SimClient';

/** Read-only hooks for automated browser tests (and curious players with devtools open). */
export interface DebugApi {
  ready: boolean;
  backend: string;
  frames: number;
  simSteps: number;
  /** Simulated seconds; compare with wall time to check the physics runs in real time. */
  simTime: number;
  speed: number;
  /** Car position on the ground plane, metres. */
  x: number;
  z: number;
  gear: number;
  manualGearbox: boolean;
  tcLevel: number;
  telemetry: boolean;
  menu: { visible: boolean; label: string; value: string };
  errors: string[];
}

declare global {
  interface Window {
    __apex?: DebugApi;
  }
}

const STATS_INTERVAL = 0.5;
/** The first shift light comes on this far below the shift point. */
const SHIFT_LIGHT_RANGE = 1900;

const AID_OPTIONS: ReadonlyArray<{ value: AidLevel; text: string }> = [
  { value: 'off', text: 'Off' },
  { value: 'low', text: 'Low' },
  { value: 'high', text: 'High' },
];
const CURVE_OPTIONS = [
  { value: 'linear', text: 'Linear' },
  { value: 'progressive', text: 'Progressive' },
  { value: 'aggressive', text: 'Aggressive' },
] as const;
const LOCATIONS: ReadonlyArray<{ value: SpawnPoint; text: string }> = [
  { value: 'loop', text: 'Handling loop' },
  { value: 'drag', text: 'Drag strip' },
  { value: 'skidpad', text: 'Skidpad' },
];

/** Round 2 game: one car on the proving ground. Wires sim ⇄ input ⇄ renderer ⇄ UI together. */
export class Game {
  private readonly settings: Settings = loadSettings();
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
  private readonly telemetry: TelemetryPanel;
  private readonly menu: QuickMenu;
  private readonly wheelSetup: WheelSetup;
  private readonly audio = new EngineAudio();
  private readonly audioFrame: AudioFrame = {
    rpm: 0,
    throttle: 0,
    limiter: false,
    shifting: false,
    speed: 0,
    slip: 0,
    offRoad: 0,
  };
  private readonly dragTimer = new DragTimer();
  private readonly debug: DebugApi;
  private readonly idleInput = neutralInput();
  private location: SpawnPoint = 'loop';

  private lastTime = -1;
  private frames = 0;
  private helpAutoHidden = false;
  private lastPadName = '';
  private lastWheelId = '';
  /** When to check whether controller input managed to start the audio (see updateAudio). */
  private soundCheckAt = -1;

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
    const settings = this.settings;
    const { width, height } = host.renderer.domElement.getBoundingClientRect();
    this.camera = new ChaseCamera(width / Math.max(height, 1));
    this.camera.mode = settings.camera;
    if (new URLSearchParams(window.location.search).get('cam') === 'orbit') {
      this.camera.mode = 'orbit';
    }
    host.onResize((w, h) => this.camera.setAspect(w / h));
    host.setResolutionScale(settings.resolutionScale);

    this.world.scene.add(this.car.root);
    this.cones = new Cones(this.world.conePlacements, TEST_MULE.body);
    this.world.scene.add(this.cones.mesh);

    this.input.padSettings = settings.pad;
    this.input.wheelProfiles = settings.wheels;

    const upshift = TEST_MULE.gearbox.upshiftRpm;
    this.hud = new Hud(ui, { upshiftRpm: upshift, shiftLightsFrom: upshift - SHIFT_LIGHT_RANGE });
    this.hud.setUnits(settings.units);
    this.perf = new PerfOverlay(
      ui,
      (delta) => this.changeScale(delta),
      () => this.cycleCamera(),
      () => this.resetCar(),
    );
    this.perf.setVisible(settings.overlay);
    this.telemetry = new TelemetryPanel(ui);
    this.telemetry.setVisible(settings.telemetry);
    this.menu = new QuickMenu(ui, this.menuItems());
    this.menu.setHint('◀ ▶ choose · ▲ ▼ change');
    this.help = new HelpPanel(ui);
    this.wheelSetup = new WheelSetup(ui);
    this.wheelSetup.onSave = (profile) => {
      settings.wheels[profile.id] = profile;
      this.input.wheelProfiles = settings.wheels;
      this.save();
    };
    this.wheelSetup.onClose = () => {
      this.input.wheelCaptured = false;
    };

    this.audio.setVolume(settings.audio.volume);
    this.audio.setMuted(settings.audio.muted);

    this.debug = {
      ready: false,
      backend: host.backend,
      frames: 0,
      simSteps: 0,
      simTime: 0,
      speed: 0,
      x: 0,
      z: 0,
      gear: 0,
      manualGearbox: false,
      tcLevel: 0,
      telemetry: false,
      menu: { visible: false, label: '', value: '' },
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
    this.applyAids();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.sim.pause();
        this.audio.suspend();
      } else {
        this.sim.resume();
        this.audio.resume();
      }
    });
    window.addEventListener('pageshow', () => this.sim.resume());
    window.addEventListener('gamepadconnected', (event) => {
      const pad = (event as GamepadEvent).gamepad;
      this.toasts.show(`Controller connected: ${pad.id.replace(/\s*\(.*\)\s*$/, '')}`);
    });
    window.addEventListener('gamepaddisconnected', () =>
      this.toasts.show('Controller disconnected'),
    );
    // Browsers only start audio from a user gesture.
    const unlock = () => this.audio.unlock();
    // (iPad only counts the end of a touch as a gesture.)
    for (const type of ['keydown', 'pointerdown', 'pointerup', 'touchend']) {
      window.addEventListener(type, unlock, { capture: true });
    }

    // Compile shaders before the first visible frame to avoid a hitch when driving starts.
    await this.host.renderer.compileAsync(this.world.scene, this.camera.camera);
    this.host.renderer.setAnimationLoop((time) => this.frame(time));
  }

  private frame(timeMs: number): void {
    const now = timeMs / 1000;
    // Real frame time for statistics; a capped copy for animation so a hitch can't fling things.
    const realDt = this.lastTime < 0 ? 1 / 60 : Math.max(now - this.lastTime, 0);
    const dt = Math.min(realDt, 0.1);
    this.lastTime = now;

    this.input.wheelCaptured = this.wheelSetup.visible;
    this.input.update();
    this.handleDevices();
    if (!this.wheelSetup.visible) this.handleActions();
    else this.wheelSetup.update(this.input.wheelPad, dt);
    const driving = this.wheelSetup.visible ? this.idleInput : this.input.driver;
    this.sim.tick(now, [driving]);

    const snapshot = this.sim.latest;
    const view = this.sim.latestView;
    const state = this.carState;
    if (snapshot && view) {
      interpolateCar(view, 0, snapshot.alpha, state);
      this.car.update(state);
      this.cones.update(dt, state);
      this.camera.update(dt, state);
      this.hud.update(state, dt);
      this.telemetry.update(dt, state, {
        steer: this.input.raw.steer,
        throttle: this.input.raw.throttle,
        brake: this.input.raw.brake,
        device: this.deviceName(),
      });
      this.updateAudio(dt);
      for (const result of this.dragTimer.update(dt, state.pos.x, state.pos.z, state.speed)) {
        this.toasts.show(formatDragResult(result, this.settings.units), { timeout: 8 });
      }
      this.carPosition.set(state.pos.x, state.pos.y, state.pos.z);
      this.world.follow(this.carPosition);
      this.statSteps += snapshot.steps;
      this.statStepCount++;
    }
    this.menu.update(dt);

    this.host.renderer.render(this.world.scene, this.camera.camera);

    this.frames++;
    if (this.frames === 2) document.body.classList.add('running');
    this.updateStats(realDt);
    const debug = this.debug;
    debug.ready = this.frames > 2 && snapshot !== null;
    debug.frames = this.frames;
    debug.simSteps = snapshot?.totalSteps ?? 0;
    debug.simTime = snapshot?.simTime ?? 0;
    debug.speed = state.speed;
    debug.x = state.pos.x;
    debug.z = state.pos.z;
    debug.gear = state.gear;
    debug.manualGearbox = state.manualGearbox;
    debug.tcLevel = state.tcLevel;
    debug.telemetry = this.telemetry.visible;
    debug.menu.visible = this.menu.visible;
    debug.menu.label = this.menu.selected.label;
    debug.menu.value = this.menu.selected.value();
  }

  /** Controller name changes, and the wheel setup the first time a new wheel shows up. */
  private handleDevices(): void {
    const input = this.input;
    const padKey = input.padConnected ? input.padName : '';
    if (padKey !== this.lastPadName) {
      this.lastPadName = padKey;
      this.help.setPad(input.padConnected ? input.padFamily : null, input.padName);
    }
    const wheel = input.wheelPad;
    const wheelId = wheel?.id ?? '';
    if (wheelId === this.lastWheelId) return;
    this.lastWheelId = wheelId;
    if (!wheel) return;
    const settings = this.settings;
    if (settings.wheels[wheel.id]) {
      this.toasts.show('Steering wheel ready. Press K for wheel settings.', { timeout: 5 });
    } else if (!settings.wheelsPrompted.includes(wheel.id)) {
      settings.wheelsPrompted.push(wheel.id);
      this.save();
      this.wheelSetup.startWizard(wheel, null);
    } else {
      this.toasts.show('Steering wheel found. Press K to set it up.', { timeout: 6 });
    }
  }

  private handleActions(): void {
    const input = this.input;
    const d = input.driver;
    if (!this.helpAutoHidden && (d.throttle > 0.1 || d.brake > 0.1 || Math.abs(d.steer) > 0.2)) {
      this.help.setVisible(false);
      this.helpAutoHidden = true;
    }
    const settings = this.settings;
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
          settings.overlay = this.perf.isVisible;
          this.save();
          break;
        case 'telemetry':
          this.telemetry.setVisible(!this.telemetry.visible);
          settings.telemetry = this.telemetry.visible;
          this.save();
          break;
        case 'help':
          this.helpAutoHidden = true;
          this.help.setVisible(!this.help.visible);
          break;
        case 'units':
          settings.units = settings.units === 'metric' ? 'imperial' : 'metric';
          this.hud.setUnits(settings.units);
          this.save();
          break;
        case 'mute':
          settings.audio.muted = !settings.audio.muted;
          this.audio.setMuted(settings.audio.muted);
          this.toasts.show(settings.audio.muted ? 'Sound off' : 'Sound on', { timeout: 1.5 });
          this.save();
          break;
        case 'menuNext':
        case 'menuPrev':
        case 'menuUp':
        case 'menuDown':
          this.menu.handle(action);
          break;
        case 'teleportLoop':
          this.teleport('loop');
          break;
        case 'teleportDrag':
          this.teleport('drag');
          break;
        case 'teleportSkidpad':
          this.teleport('skidpad');
          break;
        case 'wheelSetup':
          this.openWheelSetup();
          break;
      }
    }
  }

  private menuItems(): MenuItem[] {
    const s = this.settings;
    const aids = () => this.applyAids();
    return [
      choiceItem(
        'Traction control',
        AID_OPTIONS,
        () => s.aids.tc,
        (v) => ((s.aids.tc = v), aids()),
      ),
      choiceItem(
        'ABS',
        AID_OPTIONS,
        () => s.aids.abs,
        (v) => ((s.aids.abs = v), aids()),
      ),
      choiceItem(
        'Gearbox',
        [
          { value: 'auto', text: 'Automatic' },
          { value: 'manual', text: 'Manual (paddles)' },
        ] as const,
        () => s.aids.gearbox,
        (v) => ((s.aids.gearbox = v), aids()),
      ),
      choiceItem(
        'Throttle curve',
        CURVE_OPTIONS,
        () => s.pad.throttleCurve,
        (v) => ((s.pad.throttleCurve = v), this.save()),
      ),
      choiceItem(
        'Brake curve',
        CURVE_OPTIONS,
        () => s.pad.brakeCurve,
        (v) => ((s.pad.brakeCurve = v), this.save()),
      ),
      percentItem(
        'Steering sensitivity',
        0.5,
        1.5,
        0.1,
        () => s.aids.steerSensitivity,
        (v) => ((s.aids.steerSensitivity = v), aids()),
      ),
      choiceItem(
        'Steering smoothing',
        [
          { value: 'low', text: 'Low' },
          { value: 'medium', text: 'Medium' },
          { value: 'high', text: 'High' },
        ] as const,
        () => s.aids.steerSmoothing,
        (v) => ((s.aids.steerSmoothing = v), aids()),
      ),
      percentItem(
        'Stick centre precision',
        0,
        1,
        0.1,
        () => s.pad.steerLinearity,
        (v) => ((s.pad.steerLinearity = v), this.save()),
      ),
      percentItem(
        'Stick dead zone',
        0,
        0.2,
        0.02,
        () => s.pad.steerDeadzone,
        (v) => ((s.pad.steerDeadzone = v), this.save()),
      ),
      percentItem(
        'Resolution',
        0.5,
        1.5,
        0.1,
        () => this.host.scale,
        (v) => this.setScale(v),
      ),
      percentItem(
        'Volume',
        0,
        1,
        0.1,
        () => (s.audio.muted ? 0 : s.audio.volume),
        (v) => {
          s.audio.volume = v;
          s.audio.muted = v === 0;
          this.audio.setVolume(v);
          this.audio.setMuted(s.audio.muted);
          this.save();
        },
      ),
      choiceItem(
        'Location',
        LOCATIONS,
        () => this.location,
        (v) => this.teleport(v),
        true,
      ),
    ];
  }

  private applyAids(): void {
    this.sim.command({ kind: 'setAids', car: 0, aids: { ...this.settings.aids } });
    this.save();
  }

  private save(): void {
    saveSettings(this.settings);
    this.menu.refresh();
  }

  private teleport(to: SpawnPoint): void {
    this.location = to;
    this.sim.command({ kind: 'teleport', car: 0, to });
    this.camera.reset();
    this.menu.refresh();
  }

  private openWheelSetup(): void {
    const wheel = this.input.wheelPad;
    if (!wheel) {
      this.toasts.show(
        'No steering wheel found. Connect it, press one of its buttons, then press K again.',
        { timeout: 6 },
      );
      return;
    }
    const profile = this.settings.wheels[wheel.id];
    if (profile) this.wheelSetup.openSettings(wheel, profile);
    else this.wheelSetup.startWizard(wheel, null);
  }

  private updateAudio(dt: number): void {
    // Controller presses don't count as a user gesture in most browsers, so sound may stay off
    // for pad and wheel players until they click, tap or press a key once: tell them.
    const device = this.input.lastDevice;
    if (this.soundCheckAt < 0 && (device === 'gamepad' || device === 'wheel')) {
      this.audio.unlock();
      this.soundCheckAt = this.lastTime + 1.5;
    } else if (this.soundCheckAt > 0 && this.lastTime > this.soundCheckAt) {
      this.soundCheckAt = 0;
      if (!this.audio.running && !this.settings.audio.muted) {
        this.toasts.show('Sound starts after one click, tap or key press.', { timeout: 6 });
      }
    }
    const state = this.carState;
    const frame = this.audioFrame;
    let slip = 0;
    let grass = 0;
    let contacts = 0;
    for (const w of state.wheels) {
      if (!w.contact) continue;
      contacts++;
      slip = Math.max(slip, w.slip);
      if (w.surface === 1) grass++;
    }
    frame.rpm = state.rpm;
    frame.throttle = state.throttle;
    frame.limiter = (state.flags & FLAG_LIMITER) !== 0;
    frame.shifting = (state.flags & FLAG_SHIFTING) !== 0;
    frame.speed = Math.abs(state.speed);
    frame.slip = slip;
    frame.offRoad = contacts > 0 ? grass / contacts : 0;
    this.audio.update(dt, frame);
  }

  private deviceName(): string {
    const input = this.input;
    switch (input.lastDevice) {
      case 'wheel':
        return 'wheel';
      case 'gamepad':
        return input.padName;
      case 'keyboard':
        return 'keyboard';
      default:
        return input.padConnected ? input.padName : 'no input yet';
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
      this.save();
    }
  }

  private changeScale(delta: number): void {
    this.setScale(Math.round((this.host.scale + delta) * 10) / 10);
  }

  private setScale(scale: number): void {
    this.host.setResolutionScale(scale);
    this.settings.resolutionScale = this.host.scale;
    this.save();
    this.toasts.show(`Resolution scale ${Math.round(this.host.scale * 100)}%`, { timeout: 1.5 });
  }

  /** `dt` is the real (uncapped) frame time, so fps and physics rate are honest when slow. */
  private updateStats(dt: number): void {
    this.statTime += dt;
    this.statFrames++;
    this.statWorst = Math.max(this.statWorst, dt);
    if (this.statTime < STATS_INTERVAL) return;
    const snapshot = this.sim.latest;
    const totalSteps = snapshot?.totalSteps ?? 0;
    const info = this.host.renderer.info.render;
    const { width, height } = this.host.drawingBufferSize;
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
      device: this.deviceName(),
    });
    this.statLastTotalSteps = totalSteps;
    this.statTime = 0;
    this.statFrames = 0;
    this.statWorst = 0;
    this.statSteps = 0;
    this.statStepCount = 0;
  }
}
