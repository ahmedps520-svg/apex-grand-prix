import { h, render } from 'preact';
import * as THREE from 'three/webgpu';
import { EngineAudio, type AudioFrame } from '../audio/EngineAudio';
import { RaceEngineer, RadioVoice, type RadioInput } from '../audio/RaceRadio';
import { CHAMPIONSHIP_POINTS, PAINTS } from '../content/paints';
import { TRACKS, trackById } from '../content/tracks';
import { InputManager } from '../input/InputManager';
import { RumbleMixer, canRumble } from '../input/rumble';
import { TouchControls, hasTouch } from '../input/TouchControls';
import { CarView } from '../render/CarView';
import { ChaseCamera } from '../render/ChaseCamera';
import { Cones } from '../render/Cones';
import { createCarRenderState, interpolateCar, type CarRenderState } from '../render/interpolate';
import type { RendererHost } from '../render/RendererHost';
import { TestGroundScene } from '../render/TestGroundScene';
import { TrackScene } from '../render/TrackScene';
import {
  FLAG_LIMITER,
  FLAG_SHIFTING,
  SIM_HZ,
  neutralInput,
  type AidLevel,
  type SessionConfig,
  type SpawnPoint,
} from '../shared/protocol';
import type { RaceStatus } from '../sim/race/RaceDirector';
import { Track } from '../sim/track/Track';
import { carById, type CarModel } from '../sim/vehicle/cars';
import { TEST_MULE } from '../sim/vehicle/spec';
import { HelpPanel } from '../ui/HelpPanel';
import { Hud } from '../ui/Hud';
import { FocusManager } from '../ui/menu/focus';
import { MenuRoot } from '../ui/menu/MenuRoot';
import { promptFamily } from '../ui/menu/prompts';
import {
  MenuStore,
  isChampionship,
  type Championship,
  type MenuActions,
  type SessionSetup,
} from '../ui/menu/store';
import { Minimap, type MinimapCar } from '../ui/Minimap';
import { PerfOverlay } from '../ui/PerfOverlay';
import { QuickMenu, choiceItem, percentItem, type MenuItem } from '../ui/QuickMenu';
import { RadioBox } from '../ui/RadioBox';
import { RaceHud, lapTime } from '../ui/RaceHud';
import { TelemetryPanel } from '../ui/TelemetryPanel';
import type { Toasts } from '../ui/Toasts';
import { WheelSetup } from '../ui/WheelSetup';
import { DragTimer, formatDragResult } from './dragTimer';
import { GhostRecorder, loadGhost, sampleGhost, saveGhost, type GhostLap } from './ghost';
import { loadRecords, loadSeason, saveRecord, saveSeason } from './records';
import {
  defaultSettings,
  exportSettings,
  importSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings';
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
  /** Top menu screen, or '' while driving. */
  screen: string;
  mode: string;
  cars: number;
  race: { phase: string; lap: number; position: number } | null;
  errors: string[];
}

declare global {
  interface Window {
    __apex?: DebugApi;
  }
}

type Scenery = TestGroundScene | TrackScene;

const STATS_INTERVAL = 0.5;
/** The first shift light comes on this far below the shift point. */
const SHIFT_LIGHT_RANGE = 1900;
/** Rival colours: every paint the player can pick, plus a few more. */
const AI_PAINTS = [...PAINTS.map((p) => p.hex), 0x2a9d4a, 0x6d4c41, 0x8e1b1b, 0x4a6fa5];
const AI_NAMES = [
  'K. Arvidsen',
  'M. Okonkwo',
  'L. Castellane',
  'T. Varga',
  'R. Holloway',
  'S. Moravec',
  'D. Quintero',
  'J. Lindqvist',
  'A. Ferreira',
  'N. Tanabe',
  'E. Brandt',
];
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

const cssColor = (hex: number): string => `#${hex.toString(16).padStart(6, '0')}`;

function colourDistance(a: number, b: number): number {
  const dr = ((a >> 16) & 255) - ((b >> 16) & 255);
  const dg = ((a >> 8) & 255) - ((b >> 8) & 255);
  const db = (a & 255) - (b & 255);
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Rival paints that can't be mistaken for the player's. */
function rivalPaints(player: number): number[] {
  return AI_PAINTS.filter((hex) => colourDistance(hex, player) > 90);
}

/**
 * The whole game on the main thread: menus, the session being driven (proving ground or a
 * circuit with AI), rendering, HUDs, sound and rumble. The simulation runs in the worker.
 */
export class Game {
  private readonly settings: Settings = loadSettings();
  private readonly sim = new SimClient();
  private readonly input = new InputManager();
  private scenery: Scenery;
  private cones: Cones | null = null;
  private readonly cars: CarView[] = [];
  private readonly states: CarRenderState[] = [];
  private readonly camera: ChaseCamera;
  private readonly carPosition = new THREE.Vector3();
  private readonly hud: Hud;
  private readonly raceHud: RaceHud;
  private readonly perf: PerfOverlay;
  private readonly help: HelpPanel;
  private readonly telemetry: TelemetryPanel;
  private readonly quickMenu: QuickMenu;
  private readonly wheelSetup: WheelSetup;
  private readonly menus: MenuStore;
  private readonly focus: FocusManager;
  private readonly menuHost: HTMLElement;
  private minimap: Minimap | null = null;
  private carModel: CarModel = carById('gt');
  private readonly minimapCars: MinimapCar[] = [];
  private readonly audio = new EngineAudio();
  private readonly engineer = new RaceEngineer();
  private readonly radio = new RadioVoice();
  private readonly radioBox: RadioBox;
  private readonly radioInput: RadioInput = {
    mode: 'race',
    phase: 'grid',
    lapsDone: 0,
    laps: 0,
    position: 1,
    cars: 1,
    lastLap: 0,
    bestLap: 0,
    rivalBest: 0,
    gapAhead: null,
    gapBehind: null,
    finished: false,
  };
  private readonly rumble: RumbleMixer;
  private readonly touch: TouchControls;
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
  private readonly ghostRecorder = new GhostRecorder();
  private readonly ghostState = createCarRenderState();
  /** Time trial: the lap to beat, shown as a see-through car. */
  private ghost: GhostLap | null = null;
  private ghostView: CarView | null = null;
  private ghostModelId = '';
  private ghostLaps = 0;
  private readonly debug: DebugApi;
  private readonly idleInput = neutralInput();

  /** The running session (null only before the first one starts). */
  private session: SessionConfig | null = null;
  private track: Track | null = null;
  /** False while the menus show a car idling in the background. */
  private driving = false;
  private paused = false;
  private race: RaceStatus | null = null;
  private resultsShown = false;
  /** Championship round being raced, or -1. */
  private seasonRound = -1;
  /** Rival colours for the championship being raced. */
  private seasonPaints: number[] | null = null;
  private finishedAt = -1;
  private bestLapSeen = Infinity;
  private records = loadRecords();
  private lastTime = -1;
  private frames = 0;
  private lastPadName = '';
  private lastWheelId = '';
  private soundCheckAt = -1;
  private backHold = 0;
  private wasControlling = false;

  // Rolling stats for the overlay.
  private statTime = 0;
  private statFrames = 0;
  private statWorst = 0;
  private statSteps = 0;
  private statStepCount = 0;
  private statLastTotalSteps = 0;

  constructor(
    private readonly host: RendererHost,
    private readonly ui: HTMLElement,
    private readonly toasts: Toasts,
  ) {
    const settings = this.settings;
    const { width, height } = host.renderer.domElement.getBoundingClientRect();
    this.camera = new ChaseCamera(width / Math.max(height, 1));
    host.onResize((w, h2) => this.camera.setAspect(w / h2));
    host.setResolutionScale(settings.resolutionScale);

    this.scenery = this.buildProvingGround();
    this.rumble = new RumbleMixer(settings.rumble);

    const upshift = TEST_MULE.gearbox.upshiftRpm;
    this.hud = new Hud(ui, { upshiftRpm: upshift, shiftLightsFrom: upshift - SHIFT_LIGHT_RANGE });
    this.raceHud = new RaceHud(ui);
    this.radioBox = new RadioBox(ui);
    this.radio.onMessage = (text) => this.radioBox.show(text);
    this.perf = new PerfOverlay(
      ui,
      (delta) => this.setScale(Math.round((this.host.scale + delta) * 10) / 10),
      () => this.cycleCamera(),
      () => this.resetCar(),
    );
    this.telemetry = new TelemetryPanel(ui);
    this.quickMenu = new QuickMenu(ui, this.quickMenuItems());
    this.quickMenu.setHint('◀ ▶ choose · ▲ ▼ change');
    this.help = new HelpPanel(ui);
    this.help.setVisible(false);
    this.wheelSetup = new WheelSetup(ui);
    this.wheelSetup.onSave = (profile) => {
      this.settings.wheels[profile.id] = profile;
      this.input.wheelProfiles = this.settings.wheels;
      this.save();
    };
    this.wheelSetup.onClose = () => {
      this.input.wheelCaptured = false;
    };

    this.touch = new TouchControls(ui);
    this.input.touch = this.touch;

    this.menuHost = document.createElement('div');
    this.menuHost.className = 'menu-host';
    ui.appendChild(this.menuHost);
    this.menus = new MenuStore(settings, this.menuActions());
    this.menus.championship.value = loadSeason(isChampionship);
    this.focus = new FocusManager(() => this.focusScope());

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
      screen: 'title',
      mode: '',
      cars: 0,
      race: null,
      errors: [],
    };
    window.__apex = this.debug;
    this.sim.onError = (message) => {
      this.debug.errors.push(message);
      this.toasts.show(`Simulation error: ${message}`, { timeout: 0 });
    };
    this.sim.onWarning = (message) => this.toasts.show(message, { timeout: 6 });
    this.applySettings();
  }

  async start(): Promise<void> {
    this.scenery.buildEnvironment(this.host.renderer);
    // `?drive` skips the menus and starts free driving (handy for testing).
    const direct = new URLSearchParams(window.location.search).has('drive');
    await this.startSession(this.freeSetup(), !direct);
    this.menus.set(direct ? [] : ['title']);
    render(h(MenuRoot, { store: this.menus }), this.menuHost);
    this.applyHudVisibility();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.pause();
        this.sim.pause();
        this.audio.suspend();
        this.rumble.stop(this.input.activePad);
      } else {
        if (!this.paused) this.sim.resume();
        if (!this.paused) this.audio.resume();
      }
    });
    window.addEventListener('gamepadconnected', (event) => {
      const pad = (event as GamepadEvent).gamepad;
      this.toasts.show(`Controller connected: ${pad.id.replace(/\s*\(.*\)\s*$/, '')}`);
    });
    window.addEventListener('gamepaddisconnected', () =>
      this.toasts.show('Controller disconnected'),
    );
    // Browsers only start audio from a user gesture. (iPad only counts the end of a touch.)
    const unlock = () => this.audio.unlock();
    for (const type of ['keydown', 'pointerdown', 'pointerup', 'touchend']) {
      window.addEventListener(type, unlock, { capture: true });
    }

    await this.host.renderer.compileAsync(this.scenery.scene, this.camera.camera);
    this.host.renderer.setAnimationLoop((time) => this.frame(time));
  }

  // ---------------------------------------------------------------- sessions

  private freeSetup(): SessionSetup {
    return { ...this.menus.setup.value, mode: 'free' };
  }

  private configFor(setup: SessionSetup): SessionConfig {
    return {
      mode: setup.mode,
      trackId: setup.mode === 'free' ? '' : setup.trackId || TRACKS[0]?.id || '',
      carId: setup.carId,
      location: setup.location,
      opponents: setup.opponents,
      laps: setup.laps,
      difficulty: setup.difficulty,
      gridSlot: Math.min(setup.gridSlot, setup.opponents),
      aids: { ...this.settings.aids },
      seed: (Math.random() * 1e9) | 0,
    };
  }

  /** Builds the scene and cars for a session and starts it in the worker. */
  private async startSession(setup: SessionSetup, idle = false): Promise<void> {
    const config = this.configFor(setup);
    this.rumble.stop(this.input.activePad);
    const previous = this.session;
    this.session = config;
    // The proving ground is built at start-up; circuits are built when first driven.
    const changed = previous ? previous.trackId !== config.trackId : config.trackId !== '';
    if (changed) this.buildScenery(config);
    this.buildCars(config.mode === 'race' ? config.opponents + 1 : 1, carById(config.carId));
    this.setupGhost(config);
    await this.sim.start(config);
    this.race = null;
    this.resultsShown = false;
    this.finishedAt = -1;
    this.bestLapSeen = Infinity;
    this.raceHud.reset();
    this.engineer.reset();
    this.radio.stop();
    this.radioBox.hide();
    this.camera.reset();
    this.camera.mode = idle ? 'orbit' : this.settings.camera;
    this.driving = !idle;
    this.paused = false;
    this.menus.inSession.value = !idle;
    this.applyHudVisibility();
  }

  /** Time trial: loads the circuit's ghost lap (or clears it for other modes). */
  private setupGhost(config: SessionConfig): void {
    this.ghostRecorder.reset();
    this.ghostLaps = 0;
    this.ghost = config.mode === 'timeTrial' ? loadGhost(config.trackId) : null;
    if (this.ghost) this.showGhost(this.ghost);
    else if (this.ghostView) this.ghostView.root.visible = false;
  }

  private showGhost(lap: GhostLap): void {
    const model = carById(lap.carId);
    if (!this.ghostView || this.ghostModelId !== model.id) {
      if (this.ghostView) {
        this.ghostView.root.removeFromParent();
        this.ghostView.dispose();
      }
      const view = new CarView(model.spec, lap.paint, model.style);
      view.root.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          m.transparent = true;
          m.opacity = 0.3;
          m.depthWrite = false;
        }
      });
      const wheels = this.ghostState.wheels;
      wheels.forEach((w, i) => {
        w.length = (i < 2 ? model.spec.front : model.spec.rear).staticLength;
      });
      this.ghostView = view;
      this.ghostModelId = model.id;
    }
    this.ghostView.setPaint(lap.paint);
    if (this.ghostView.root.parent !== this.scenery.scene)
      this.scenery.scene.add(this.ghostView.root);
    this.ghostView.root.visible = false;
  }

  /** Records the lap being driven and moves the ghost along with it. */
  private updateGhost(dt: number, me: RaceStatus['cars'][number], player: CarRenderState): void {
    const session = this.session;
    if (!session) return;
    if (me.lap > this.ghostLaps) {
      // A lap was completed: keep it if it beats the ghost.
      this.ghostLaps = me.lap;
      const lap = this.ghostRecorder.finish(
        session.trackId,
        session.carId,
        this.settings.paint,
        me.lastLap,
      );
      if (lap && (!this.ghost || lap.lapTime < this.ghost.lapTime)) {
        this.ghost = lap;
        saveGhost(lap);
        this.showGhost(lap);
      }
      this.ghostRecorder.reset();
    }
    if (me.currentLap > 0) this.ghostRecorder.record(me.currentLap, player);
    const view = this.ghostView;
    if (!view) return;
    const show =
      this.settings.ghost &&
      this.ghost !== null &&
      me.currentLap > 0 &&
      sampleGhost(this.ghost, me.currentLap, this.ghostState);
    view.root.visible = show;
    if (!show) return;
    const state = this.ghostState;
    for (const w of state.wheels) w.spin = (w.spin + (state.speed * dt) / 0.34) % (Math.PI * 2);
    view.update(state);
  }

  private buildProvingGround(): TestGroundScene {
    const scene = new TestGroundScene();
    this.cones = new Cones(scene.conePlacements, TEST_MULE.body);
    scene.scene.add(this.cones.mesh);
    return scene;
  }

  private buildScenery(config: SessionConfig): void {
    // Take out what outlives the scenery, so disposing it doesn't free their materials.
    for (const car of this.cars) car.root.removeFromParent();
    this.ghostView?.root.removeFromParent();
    this.scenery.dispose();
    this.minimap?.dispose();
    this.minimap = null;
    this.cones = null;
    const def = config.trackId ? trackById(config.trackId) : undefined;
    if (def) {
      this.track = new Track(def);
      this.scenery = new TrackScene(this.track);
      this.minimap = new Minimap(this.ui, this.track);
    } else {
      this.track = null;
      this.scenery = this.buildProvingGround();
    }
    this.scenery.buildEnvironment(this.host.renderer);
    for (const car of this.cars) this.scenery.scene.add(car.root);
    void this.host.renderer.compileAsync(this.scenery.scene, this.camera.camera);
  }

  private buildCars(count: number, model: CarModel): void {
    if (model.id !== this.carModel.id) {
      // A different car: rebuild every view.
      while (this.cars.length > 0) {
        const car = this.cars.pop()!;
        car.root.removeFromParent();
        car.dispose();
        this.states.pop();
        this.minimapCars.pop();
      }
      this.carModel = model;
      this.rumble.limiterRpm = model.spec.engine.limiterRpm;
      const upshift = model.spec.gearbox.upshiftRpm;
      this.hud.setEngine({ upshiftRpm: upshift, shiftLightsFrom: upshift - SHIFT_LIGHT_RANGE });
    }
    while (this.cars.length > count) {
      const car = this.cars.pop()!;
      car.root.removeFromParent();
      car.dispose();
      this.states.pop();
      this.minimapCars.pop();
    }
    while (this.cars.length < count) {
      const i = this.cars.length;
      this.cars.push(new CarView(model.spec, this.paintFor(i), model.style));
      this.states.push(createCarRenderState());
      this.minimapCars.push({ x: 0, z: 0, color: '#fff', player: i === 0 });
    }
    for (const car of this.cars) {
      if (!car.root.parent) this.scenery.scene.add(car.root);
    }
    this.repaint();
  }

  private paintFor(car: number): number {
    const player = this.settings.paint;
    if (car === 0) return player;
    const fixed = this.seasonPaints?.[car];
    if (fixed !== undefined) return fixed;
    const rivals = rivalPaints(player);
    return rivals[(car - 1) % rivals.length] ?? 0x9e9e9e;
  }

  /** Applies the player's paint (and rivals that avoid it) to every car and minimap dot. */
  private repaint(): void {
    for (let i = 0; i < this.cars.length; i++) {
      const paint = this.paintFor(i);
      this.cars[i]!.setPaint(paint);
      const dot = this.minimapCars[i];
      if (dot) dot.color = cssColor(paint);
    }
  }

  private pause(): void {
    if (!this.driving || this.paused) return;
    this.paused = true;
    this.sim.pause();
    this.audio.suspend();
    this.radio.stop();
    this.rumble.stop(this.input.activePad);
    this.menus.set(['pause']);
    this.applyHudVisibility();
  }

  private resume(): void {
    this.menus.set([]);
    if (this.paused) {
      this.paused = false;
      this.sim.resume();
      this.audio.resume();
    }
    this.applyHudVisibility();
  }

  private quitToMenu(): void {
    this.seasonRound = -1;
    this.seasonPaints = null;
    this.menus.set(['main']);
    if (this.paused) {
      this.paused = false;
      this.sim.resume();
      this.audio.resume();
    }
    // The menus idle on the circuit just driven (no rebuild), or on the proving ground.
    const trackId = this.session?.trackId;
    const backdrop: SessionSetup = trackId
      ? { ...this.menus.setup.value, mode: 'timeTrial', trackId }
      : this.freeSetup();
    void this.startSession(backdrop, true).then(() => this.menus.set(['main']));
  }

  private applyHudVisibility(): void {
    const driving = this.driving && !this.menus.open;
    this.hud.root.hidden = !driving;
    this.raceHud.setVisible(driving && this.session?.mode !== 'free');
    this.minimap?.setVisible(driving);
    this.telemetry.setVisible(driving && this.settings.telemetry);
    this.perf.setVisible(this.settings.overlay);
    const device = this.input.lastDevice;
    this.touch.setVisible(driving && hasTouch() && (device === 'touch' || device === 'none'));
  }

  // ---------------------------------------------------------------- frame

  private frame(timeMs: number): void {
    const now = timeMs / 1000;
    // Real frame time for statistics; a capped copy for animation so a hitch can't fling things.
    const realDt = this.lastTime < 0 ? 1 / 60 : Math.max(now - this.lastTime, 0);
    const dt = Math.min(realDt, 0.1);
    this.lastTime = now;

    const input = this.input;
    input.wheelCaptured = this.wheelSetup.visible;
    input.update();
    this.handleDevices();
    const menusOpen = this.menus.open;
    if (this.wheelSetup.visible) this.wheelSetup.update(input.wheelPad, dt);
    else if (menusOpen) this.handleMenuInput(dt);
    else if (this.driving) this.handleActions();
    this.menus.prompts.value = promptFamily(
      this.settings.prompts,
      input.lastDevice,
      input.padFamily,
    );
    this.menus.padFamily.value = input.padFamily;

    const controls = this.driving && !this.menus.open && !this.wheelSetup.visible;
    if (controls) this.applyHudVisibility();
    this.sim.tick(now, [controls ? input.driver : this.idleInput]);

    const snapshot = this.sim.latest;
    const view = this.sim.latestView;
    if (snapshot && view) {
      const count = Math.min(snapshot.carCount, this.cars.length);
      for (let i = 0; i < count; i++) {
        interpolateCar(view, i, snapshot.alpha, this.states[i]!);
        this.cars[i]!.update(this.states[i]!);
      }
      const player = this.states[0]!;
      this.cones?.update(dt, player);
      this.camera.update(dt, player);
      this.race = snapshot.race;
      if (controls) {
        this.hud.update(player, dt);
        this.telemetry.update(dt, player, {
          steer: input.raw.steer,
          throttle: input.raw.throttle,
          brake: input.raw.brake,
          device: this.deviceName(),
        });
      }
      this.updateRace(dt, player, count);
      this.updateAudio(dt, player);
      if (controls) this.rumble.update(dt, player, input.activePad);
      else if (this.wasControlling) this.rumble.stop(input.activePad);
      this.wasControlling = controls;
      if (this.session?.mode === 'free' && controls) {
        for (const result of this.dragTimer.update(dt, player.pos.x, player.pos.z, player.speed)) {
          this.toasts.show(formatDragResult(result, this.settings.units), { timeout: 8 });
        }
      }
      this.carPosition.set(player.pos.x, player.pos.y, player.pos.z);
      this.scenery.follow(this.carPosition);
      this.statSteps += snapshot.steps;
      this.statStepCount++;
    }
    this.quickMenu.update(dt);
    if (this.menus.top === 'tester') this.updateTester();

    this.host.renderer.render(this.scenery.scene, this.camera.camera);

    this.frames++;
    if (this.frames === 2) document.body.classList.add('running');
    this.updateStats(realDt);
    this.updateDebug(snapshot !== null);
  }

  private updateRace(dt: number, player: CarRenderState, count: number): void {
    const race = this.race;
    const track = this.track;
    if (this.scenery instanceof TrackScene) {
      const lights = race ? race.lights : 0;
      const green = race !== null && race.phase === 'racing' && race.time < 1.5;
      this.scenery.setStartLights(lights, green);
    }
    if (this.minimap && track) {
      for (let i = 0; i < count; i++) {
        const dot = this.minimapCars[i]!;
        dot.x = this.states[i]!.pos.x;
        dot.z = this.states[i]!.pos.z;
      }
      this.minimap.update(this.minimapCars.slice(0, count));
    }
    if (!race || !track || !this.driving || this.menus.open) return;
    // Grid intro: the camera circles the car until the lights start coming on.
    const intro = race.phase === 'grid' && race.mode === 'race';
    if (intro && this.camera.mode !== 'orbit') this.camera.mode = 'orbit';
    else if (!intro && this.camera.mode === 'orbit') {
      this.camera.mode = this.settings.camera;
      this.camera.reset();
    }
    // Wrong way: heading against the track direction while moving.
    const pr = track.project(player.pos.x, player.pos.z);
    const sample = track.samples[pr.index]!;
    const q = player.rot;
    const fx = -2 * (q.x * q.z + q.w * q.y);
    const fz = -(1 - 2 * (q.x * q.x + q.y * q.y));
    const wrongWay = fx * sample.tx + fz * sample.tz < -0.4 && Math.abs(player.speed) > 3;
    const session = this.session!;
    const record = this.records[session.trackId] ?? null;
    this.raceHud.update(dt, race, 0, record, wrongWay);
    this.updateRadio(dt, race);

    const me = race.cars[0];
    if (!me) return;
    if (session.mode === 'timeTrial') this.updateGhost(dt, me, player);
    // Keep the track record (time trial and races).
    if (me.bestLap > 0 && me.bestLap < this.bestLapSeen) {
      this.bestLapSeen = me.bestLap;
      const previous = this.records[session.trackId];
      if (previous === undefined || me.bestLap < previous) {
        this.records = saveRecord(session.trackId, me.bestLap);
        if (previous !== undefined) {
          this.toasts.show(`New track record: ${lapTime(me.bestLap)}`, { timeout: 5 });
        }
      }
    }
    // Race over: results a few seconds after the player finished.
    if (session.mode === 'race' && me.finished && !this.resultsShown) {
      if (this.finishedAt < 0) this.finishedAt = this.lastTime;
      if (this.lastTime - this.finishedAt > 4 || race.phase === 'finished') this.showResults(race);
    }
  }

  /** Feeds the race engineer and plays what they say. */
  private updateRadio(dt: number, race: RaceStatus): void {
    this.radioBox.update(dt);
    const me = race.cars[0];
    if (!me || race.mode === 'free') return;
    const r = this.radioInput;
    r.mode = race.mode;
    r.phase = race.phase;
    r.lapsDone = me.lap;
    r.laps = race.laps;
    r.position = me.position;
    r.cars = race.cars.length;
    r.lastLap = me.lastLap;
    r.bestLap = me.bestLap;
    r.finished = me.finished;
    let rivalBest = 0;
    for (let i = 1; i < race.cars.length; i++) {
      const best = race.cars[i]!.bestLap;
      if (best > 0 && (rivalBest === 0 || best < rivalBest)) rivalBest = best;
    }
    r.rivalBest = rivalBest;
    const ahead = race.cars[race.order[me.position - 2] ?? -1];
    const behind = race.cars[race.order[me.position] ?? -1];
    r.gapAhead = ahead && me.lap > 0 ? Math.max(me.gapToLeader - ahead.gapToLeader, 0) : null;
    r.gapBehind = behind && me.lap > 0 ? Math.max(behind.gapToLeader - me.gapToLeader, 0) : null;
    for (const message of this.engineer.update(dt, r)) this.radio.say(message);
  }

  private showResults(race: RaceStatus): void {
    this.resultsShown = true;
    const def = this.session ? trackById(this.session.trackId) : undefined;
    const leaderTime = race.cars[race.order[0] ?? 0]?.finishTime ?? 0;
    const season = this.menus.championship.value;
    const inSeason = season !== null && this.seasonRound >= 0 && season.round === this.seasonRound;
    this.menus.results.value = {
      mode: 'race',
      trackName: def?.name ?? '',
      championship: inSeason,
      rows: race.order.map((car, i) => {
        const c = race.cars[car]!;
        return {
          position: i + 1,
          name: this.driverName(car),
          player: car === 0,
          bestLap: c.bestLap,
          time: c.finished ? c.finishTime : NaN,
          gap: c.finished ? c.finishTime - leaderTime : NaN,
        };
      }),
    };
    if (inSeason) this.scoreRound(season, race);
    this.menus.set(['results']);
    this.applyHudVisibility();
  }

  private driverName(car: number): string {
    const season = this.seasonRound >= 0 ? this.menus.championship.value : null;
    const name = season?.names[car];
    if (name) return name;
    return car === 0 ? 'You' : (AI_NAMES[(car - 1) % AI_NAMES.length] ?? `Driver ${car}`);
  }

  /** Championship points for the race just finished (finishers only). */
  private scoreRound(season: Championship, race: RaceStatus): void {
    const points = [...season.points];
    const last = points.map(() => 0);
    race.order.forEach((car, i) => {
      const scored = race.cars[car]?.finished ? (CHAMPIONSHIP_POINTS[i] ?? 0) : 0;
      if (car < points.length) {
        points[car] = (points[car] ?? 0) + scored;
        last[car] = scored;
      }
    });
    const next: Championship = { ...season, points, last, round: season.round + 1 };
    this.menus.championship.value = next;
    this.seasonRound = -1;
    saveSeason(next);
  }

  private startChampionship(races: number): void {
    const setup = { ...this.menus.setup.value, mode: 'race' as const };
    const count = Math.min(Math.max(races, 1), TRACKS.length);
    // A random pick of circuits, raced in calendar order.
    const picked = new Set<string>();
    const pool = TRACKS.map((t) => t.id);
    while (picked.size < count) picked.add(pool[(Math.random() * pool.length) | 0]!);
    const tracks = pool.filter((id) => picked.has(id));
    const field = setup.opponents + 1;
    const rivals = rivalPaints(this.settings.paint);
    const names = ['You'];
    const paints = [this.settings.paint];
    for (let car = 1; car < field; car++) {
      names.push(AI_NAMES[(car - 1) % AI_NAMES.length] ?? `Driver ${car}`);
      paints.push(rivals[(car - 1) % rivals.length] ?? 0x9e9e9e);
    }
    const season: Championship = {
      tracks,
      round: 0,
      points: new Array<number>(field).fill(0),
      last: new Array<number>(field).fill(0),
      names,
      paints,
      setup,
    };
    this.menus.championship.value = season;
    saveSeason(season);
    this.nextRound();
  }

  /** Starts the next race of the season; the grid lines up in championship order. */
  private nextRound(): void {
    const season = this.menus.championship.value;
    if (!season || season.round >= season.tracks.length) return;
    const field = season.points.length;
    const order = season.points
      .map((points, car) => ({ car, points }))
      .sort((a, b) => b.points - a.points || a.car - b.car);
    const gridSlot =
      season.round === 0 ? Math.floor(field / 2) : order.findIndex((o) => o.car === 0);
    const trackId = season.tracks[season.round]!;
    const def = trackById(trackId);
    const setup: SessionSetup = {
      ...season.setup,
      mode: 'race',
      trackId,
      opponents: field - 1,
      gridSlot: Math.max(0, Math.min(gridSlot, field - 1)),
    };
    this.menus.update(setup);
    this.seasonRound = season.round;
    this.seasonPaints = season.paints;
    this.menus.set([]);
    if (def) this.toasts.show(`Round ${season.round + 1} of ${season.tracks.length}: ${def.name}`);
    void this.startSession(setup).then(() => this.resume());
  }

  /** Menus: controller, keyboard and wheel events go to the focus engine and the screens. */
  private handleMenuInput(dt: number): void {
    const top = this.menus.top;
    if (this.input.capturing) {
      for (const e of this.input.ui) {
        if (e.event === 'back' && e.source === 'key') this.input.cancelCapture();
      }
      return;
    }
    // The tester shows ○ / B like any other button: hold it to leave.
    const pad = this.input.activePad;
    if (top === 'tester') {
      this.backHold = pad?.buttons[1]?.pressed ? this.backHold + dt : 0;
      if (this.backHold > 1) {
        this.backHold = 0;
        this.menus.pop();
        return;
      }
    }
    for (const { event, source } of this.input.ui) {
      if (top === 'title') {
        this.menus.set(['main']);
        break;
      }
      if (top === 'tester' && source === 'pad' && event !== 'up' && event !== 'down') continue;
      if (this.focus.handle(event)) continue;
      if (event === 'back' || event === 'pause') {
        if (top === 'pause') this.resume();
        else if (top !== 'results' && top !== 'main') this.menus.pop();
      }
    }
    this.focus.sync();
    this.applyHudVisibility();
  }

  private focusScope(): HTMLElement | null {
    const modal = this.menuHost.querySelector<HTMLElement>('[data-modal]');
    if (modal) return modal;
    return this.menuHost.querySelector<HTMLElement>('.menu-screen');
  }

  /** Controller name changes, and the wheel setup the first time a new wheel shows up. */
  private handleDevices(): void {
    const input = this.input;
    const padKey = input.padConnected ? input.padName : '';
    if (padKey !== this.lastPadName) {
      this.lastPadName = padKey;
      this.help.setPad(input.padConnected ? input.padFamily : null, input.padName);
      this.menus.rumbleSupported.value = canRumble(input.activePad);
    }
    const wheel = input.wheelPad;
    const wheelName = wheel ? wheel.id.replace(/\s*\(.*\)\s*$/, '') : null;
    if (this.menus.wheelName.value !== wheelName) this.menus.wheelName.value = wheelName;
    const wheelId = wheel?.id ?? '';
    if (wheelId === this.lastWheelId) return;
    this.lastWheelId = wheelId;
    if (!wheel) return;
    const settings = this.settings;
    if (settings.wheels[wheel.id]) {
      this.toasts.show('Steering wheel ready. Settings → Wheel to adjust it.', { timeout: 5 });
    } else if (!settings.wheelsPrompted.includes(wheel.id) && this.driving) {
      settings.wheelsPrompted.push(wheel.id);
      this.save();
      this.wheelSetup.startWizard(wheel, null);
    } else {
      this.toasts.show('Steering wheel found: set it up in Settings → Wheel (or press K).', {
        timeout: 6,
      });
    }
  }

  private handleActions(): void {
    const settings = this.settings;
    for (const action of this.input.actions) {
      switch (action) {
        case 'pause':
          this.pause();
          return;
        case 'reset':
          this.resetCar();
          break;
        case 'camera':
          this.cycleCamera();
          break;
        case 'overlay':
          settings.overlay = !settings.overlay;
          this.save();
          break;
        case 'telemetry':
          settings.telemetry = !settings.telemetry;
          this.save();
          break;
        case 'help':
          this.help.setVisible(!this.help.visible);
          break;
        case 'units':
          settings.units = settings.units === 'metric' ? 'imperial' : 'metric';
          this.applySettings();
          this.save();
          break;
        case 'mute':
          settings.audio.muted = !settings.audio.muted;
          this.applySettings();
          this.toasts.show(settings.audio.muted ? 'Sound off' : 'Sound on', { timeout: 1.5 });
          this.save();
          break;
        case 'menuNext':
        case 'menuPrev':
        case 'menuUp':
        case 'menuDown':
          this.quickMenu.handle(action);
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

  // ---------------------------------------------------------------- settings & actions

  private menuActions(): MenuActions {
    return {
      startSession: (setup) => {
        this.seasonRound = -1;
        this.seasonPaints = null;
        this.menus.set([]);
        void this.startSession(setup).then(() => this.resume());
      },
      restartSession: () => {
        this.menus.set([]);
        const mode = this.session?.mode;
        if (mode === 'race' || mode === 'timeTrial') {
          void this.startSession({ ...this.menus.setup.value, mode }).then(() => this.resume());
        } else {
          this.resume();
          this.resetCar();
        }
      },
      resume: () => this.resume(),
      resetCar: () => {
        this.resume();
        this.resetCar();
      },
      quitToMenu: () => this.quitToMenu(),
      settingsChanged: () => {
        this.applySettings();
        this.save();
      },
      openWheelSetup: () => this.openWheelSetup(),
      testRumble: () => this.rumble.test(this.input.activePad),
      exportSettings: () => this.exportSettings(),
      importSettings: async (file) => {
        const loaded = importSettings(await file.text());
        if (!loaded) return 'That file is not an APEX GRAND PRIX settings file.';
        this.replaceSettings(loaded);
        return null;
      },
      resetSettings: () => this.replaceSettings(defaultSettings()),
      capture: (kind, done) => this.input.startCapture(kind, done),
      cancelCapture: () => this.input.cancelCapture(),
      record: (trackId) => this.records[trackId] ?? null,
      startChampionship: (races) => this.startChampionship(races),
      nextRound: () => this.nextRound(),
    };
  }

  private replaceSettings(next: Settings): void {
    // Keep the same object: the menus hold a reference to it.
    Object.assign(this.settings, next);
    this.applySettings();
    this.save();
    this.menus.revision.value++;
  }

  /** Pushes the current settings into every part of the game. */
  private applySettings(): void {
    const s = this.settings;
    this.input.padSettings = s.pad;
    this.input.bindings = s.bindings;
    this.input.wheelProfiles = s.wheels;
    this.hud.setUnits(s.units);
    this.audio.setVolume(s.audio.volume);
    this.audio.setMuted(s.audio.muted);
    this.rumble.settings = s.rumble;
    this.radio.enabled = s.radio.voice && !s.audio.muted;
    this.radio.volume = s.radio.volume;
    this.radioBox.enabled = s.radio.subtitles;
    if (!s.radio.subtitles) this.radioBox.hide();
    this.repaint();
    if (s.touchSteering === 'tilt' && this.touch.steeringMode !== 'tilt') {
      void this.touch.enableTilt().then((ok) => {
        if (!ok) this.toasts.show('Tilt steering needs motion access; using drag steering.');
      });
    } else if (s.touchSteering === 'drag') {
      this.touch.steeringMode = 'drag';
    }
    if (Math.abs(this.host.scale - s.resolutionScale) > 1e-3) {
      this.host.setResolutionScale(s.resolutionScale);
    }
    if (this.camera.mode !== 'orbit') this.camera.mode = s.camera;
    this.sim.command({ kind: 'setAids', car: 0, aids: { ...s.aids } });
    this.applyHudVisibility();
  }

  private save(): void {
    saveSettings(this.settings);
    this.quickMenu.refresh();
    this.applyHudVisibility();
  }

  private exportSettings(): void {
    const blob = new Blob([exportSettings(this.settings)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'apex-grand-prix-settings.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  private quickMenuItems(): MenuItem[] {
    const s = this.settings;
    const apply = () => {
      this.applySettings();
      this.save();
    };
    return [
      choiceItem(
        'Traction control',
        AID_OPTIONS,
        () => s.aids.tc,
        (v) => ((s.aids.tc = v), apply()),
      ),
      choiceItem(
        'ABS',
        AID_OPTIONS,
        () => s.aids.abs,
        (v) => ((s.aids.abs = v), apply()),
      ),
      choiceItem(
        'Gearbox',
        [
          { value: 'auto', text: 'Automatic' },
          { value: 'manual', text: 'Manual (paddles)' },
        ] as const,
        () => s.aids.gearbox,
        (v) => ((s.aids.gearbox = v), apply()),
      ),
      choiceItem(
        'Throttle curve',
        CURVE_OPTIONS,
        () => s.pad.throttleCurve,
        (v) => ((s.pad.throttleCurve = v), apply()),
      ),
      choiceItem(
        'Brake curve',
        CURVE_OPTIONS,
        () => s.pad.brakeCurve,
        (v) => ((s.pad.brakeCurve = v), apply()),
      ),
      percentItem(
        'Steering sensitivity',
        0.5,
        1.5,
        0.1,
        () => s.aids.steerSensitivity,
        (v) => ((s.aids.steerSensitivity = v), apply()),
      ),
      choiceItem(
        'Steering smoothing',
        [
          { value: 'low', text: 'Low' },
          { value: 'medium', text: 'Medium' },
          { value: 'high', text: 'High' },
        ] as const,
        () => s.aids.steerSmoothing,
        (v) => ((s.aids.steerSmoothing = v), apply()),
      ),
      percentItem(
        'Stick centre precision',
        0,
        1,
        0.1,
        () => s.pad.steerLinearity,
        (v) => ((s.pad.steerLinearity = v), apply()),
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
          apply();
        },
      ),
      choiceItem(
        'Location',
        LOCATIONS,
        () => this.menus.setup.value.location,
        (v) => this.teleport(v),
        true,
      ),
    ];
  }

  private teleport(to: SpawnPoint): void {
    if (this.session?.mode !== 'free') return;
    this.menus.update({ location: to });
    this.rumble.stop(this.input.activePad);
    this.sim.command({ kind: 'teleport', car: 0, to });
    this.camera.reset();
    this.quickMenu.refresh();
  }

  private openWheelSetup(): void {
    const wheel = this.input.wheelPad;
    if (!wheel) {
      this.toasts.show(
        'No steering wheel found. Connect it, press one of its buttons, then try again.',
        { timeout: 6 },
      );
      return;
    }
    const profile = this.settings.wheels[wheel.id];
    if (profile) this.wheelSetup.openSettings(wheel, profile);
    else this.wheelSetup.startWizard(wheel, null);
  }

  private updateTester(): void {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    this.menus.pads.value = Array.from(pads)
      .filter((p): p is Gamepad => p !== null && p.connected)
      .map((p) => ({
        index: p.index,
        id: p.id,
        mapping: p.mapping,
        axes: Array.from(p.axes),
        buttons: p.buttons.map((b) => ({ pressed: b.pressed, value: b.value })),
        rumble: canRumble(p),
      }));
  }

  private updateAudio(dt: number, state: CarRenderState): void {
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
    const frame = this.audioFrame;
    let slip = 0;
    let offRoad = 0;
    let contacts = 0;
    for (const w of state.wheels) {
      if (!w.contact) continue;
      contacts++;
      slip = Math.max(slip, w.slip);
      if (w.surface === 1 || w.surface === 3) offRoad++;
    }
    frame.rpm = state.rpm;
    frame.throttle = state.throttle;
    frame.limiter = (state.flags & FLAG_LIMITER) !== 0;
    frame.shifting = (state.flags & FLAG_SHIFTING) !== 0;
    frame.speed = Math.abs(state.speed);
    frame.slip = slip;
    frame.offRoad = contacts > 0 ? offRoad / contacts : 0;
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
      case 'touch':
        return 'touch';
      default:
        return input.padConnected ? input.padName : 'no input yet';
    }
  }

  private resetCar(): void {
    this.rumble.stop(this.input.activePad);
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

  private setScale(scale: number): void {
    this.host.setResolutionScale(scale);
    this.settings.resolutionScale = this.host.scale;
    this.save();
    this.toasts.show(`Resolution scale ${Math.round(this.host.scale * 100)}%`, { timeout: 1.5 });
  }

  private updateDebug(hasSnapshot: boolean): void {
    const debug = this.debug;
    const state = this.states[0];
    debug.ready = this.frames > 2 && hasSnapshot;
    debug.frames = this.frames;
    debug.simSteps = this.sim.latest?.totalSteps ?? 0;
    debug.simTime = this.sim.latest?.simTime ?? 0;
    if (state) {
      debug.speed = state.speed;
      debug.x = state.pos.x;
      debug.z = state.pos.z;
      debug.gear = state.gear;
      debug.manualGearbox = state.manualGearbox;
      debug.tcLevel = state.tcLevel;
    }
    debug.telemetry = this.telemetry.visible;
    debug.menu.visible = this.quickMenu.visible;
    debug.menu.label = this.quickMenu.selected.label;
    debug.menu.value = this.quickMenu.selected.value();
    debug.screen = this.menus.top ?? '';
    debug.mode = this.session?.mode ?? '';
    debug.cars = this.cars.length;
    const me = this.race?.cars[0];
    debug.race =
      this.race && me ? { phase: this.race.phase, lap: me.lap, position: me.position } : null;
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
        this.statLastTotalSteps > 0 && totalSteps >= this.statLastTotalSteps
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
