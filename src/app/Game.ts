import { h, render } from 'preact';
import * as THREE from 'three/webgpu';
import { EngineAudio, OTHER_VOICES, type AudioFrame, type OtherEngine } from '../audio/EngineAudio';
import { bearingPan } from '../audio/synth';
import { MenuAudio } from '../audio/MenuAudio';
import { RaceEngineer, RadioVoice, type RadioInput } from '../audio/RaceRadio';
import {
  darkness,
  darknessAt,
  DAY_MINUTES,
  gripFactor,
  hourOf,
  isRaining,
  isTimeOfDay,
  isWeather,
  sunElevationAt,
  type Conditions,
  type Weather,
} from '../content/conditions';
import { rivalName } from '../content/drivers';
import { ladderStanding } from '../content/ladder';
import { randomLivery, type Livery } from '../content/livery';
import { CHAMPIONSHIP_POINTS, PAINTS } from '../content/paints';
import { TRACKS, trackById } from '../content/tracks';
import { InputManager } from '../input/InputManager';
import { RumbleMixer, canRumble } from '../input/rumble';
import { TouchControls, hasTouch } from '../input/TouchControls';
import { CarView } from '../render/CarView';
import { ChaseCamera, type CameraMode } from '../render/ChaseCamera';
import { Cones } from '../render/Cones';
import { Props } from '../render/Props';
import { createCarRenderState, interpolateCar, type CarRenderState } from '../render/interpolate';
import type { RendererHost } from '../render/RendererHost';
import { TestGroundScene } from '../render/TestGroundScene';
import { TrackScene, type Footprint } from '../render/TrackScene';
import { CityScene, DETAIL_LEVELS, detectDetail } from '../render/CityScene';
import { CityMinimap, type MinimapMarker } from '../ui/CityMinimap';
import { CITY_SUN_ELEVATION, cityHourOf } from '../content/city/day';
import { cityMap } from '../content/city/map';
import { PROP_SPECS, cityPropPlacements } from '../content/city/props';
import {
  POLICE_PAINT,
  policeModel,
  pedestrianSlotsFor,
  policeSlotsFor,
  racerModel,
  racerSlotsFor,
  trafficModel,
  trafficPaint,
  trafficSlotsFor,
} from '../content/city/fleet';
import { SpikeStrips } from '../render/SpikeStrips';
import { Skill } from './Skill';
import { SkillHud } from '../ui/SkillHud';
import { MAP_MAX_X, MAP_MAX_Z, MAP_MIN_X, MAP_MIN_Z } from '../content/city/terrain';
import {
  PhotoCamera,
  PhotoControls,
  PhotoPipeline,
  capturePng,
  defaultPhotoSettings,
  downloadPhoto,
  photoFileName,
} from '../render/PhotoMode';
import { TvDirector } from '../render/TvCamera';
import {
  CAR_STRIDE,
  FLAG_HORN,
  FLAG_LIMITER,
  FLAG_SHIFTING,
  FLAG_SIREN,
  SIM_HZ,
  PED_STRIDE,
  SOFT_FLOATS,
  SOFT_NODES,
  neutralInput,
  type AidLevel,
  type PoliceStatus,
  type RoamRaceStatus,
  type SessionConfig,
  type RoamStart,
  type SpawnPoint,
  type WeatherMix,
} from '../shared/protocol';
import { forwardOf, mulberry32, vec3, yawOf } from '../shared/math';
import type { RaceStatus } from '../sim/race/RaceDirector';
import { computeRacingLine, type RacingLine } from '../sim/race/racingLine';
import { lineOptionsFor } from '../sim/world';
import { Track } from '../sim/track/Track';
import { CARS, carById, type CarModel } from '../sim/vehicle/cars';
import { TEST_MULE } from '../sim/vehicle/spec';
import { el, setText } from '../ui/dom';
import { HelpPanel } from '../ui/HelpPanel';
import { Hud } from '../ui/Hud';
import { FocusManager, type UiEvent } from '../ui/menu/focus';
import { MenuRoot } from '../ui/menu/MenuRoot';
import { PhotoScreen } from '../ui/menu/PhotoScreen';
import { promptFamily } from '../ui/menu/prompts';
import {
  MenuStore,
  isChampionship,
  type Championship,
  type MenuActions,
  type ReplayCamera,
  type ReplayCommand,
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
import {
  DrivingSchool,
  nearestLinePoint,
  offTrack,
  racingLineMesh,
  type Glyphs,
} from './DrivingSchool';
import { GhostRecorder, loadGhost, sampleGhost, saveGhost, type GhostLap } from './ghost';
import {
  loadFestivalRecords,
  loadProgress,
  saveProgress,
  loadRecords,
  loadRoamSpot,
  loadSeason,
  saveFestivalRecord,
  saveRecord,
  saveRoamSpot,
  saveSeason,
  type RoamSpot,
} from './records';
import { Festival, festivalTotals } from './Festival';
import { EventHud } from '../ui/EventHud';
import { RaceCard } from '../ui/RaceCard';
import { FestivalScene } from '../render/FestivalScene';
import { Helicopter } from '../render/Helicopter';
import { PedestrianView } from '../render/Pedestrians';
import { festivalEvents, type EventKind } from '../content/city/events';
import type { FestivalInfo } from '../ui/menu/store';
import { ReplayRecorder, type Replay } from './replay';
import {
  DAMAGE_SCALE,
  defaultSettings,
  exportSettings,
  importSettings,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings';
import { SimClient } from './SimClient';
import './cinematics.css';

/** Read-only hooks for automated browser tests (and curious players with devtools open). */
export interface DebugApi {
  ready: boolean;
  backend: string;
  frames: number;
  simSteps: number;
  /** Simulated seconds; compare with wall time to check the physics runs in real time. */
  simTime: number;
  speed: number;
  /** The larger rear tyre slip angle, radians (for the tests). */
  rearSlip: number;
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
  /** Free roam: the wanted level and where the police cars are (distance to the player). */
  police: {
    heat: number;
    state: string;
    helicopter: boolean;
    units: Array<{ x: number; z: number; d: number; siren: boolean }>;
  } | null;
  /**
   * Free roam: the soft body's largest node displacement, m, the panels that are off, and how
   * far the drawn body has moved with it.
   */
  soft: { crush: number; parts: number; moved: number } | null;
  /** Free roam: pedestrians about, and the nearest one relative to the car (for the tests). */
  pedestrians: number;
  pedestrianSample: { dx: number; dz: number; y: number; state: number } | null;
  /** Free roam: the hour on the day's clock while it runs (null when the time stands still). */
  clock: number | null;
  /** Moving weather: from, to and how far along (null when fixed). */
  weather: WeatherMix | null;
  /** Arcade free roam: props flying or knocked over right now, and the nearest one standing. */
  propsKnocked: number;
  nearestProp: (x: number, z: number) => { kind: string; x: number; z: number } | null;
  /** Free roam: puts the car down here (for the checks). */
  place: (x: number, z: number, yaw: number) => void;
  /** Moving weather: starts a change to this weather now (for the checks). */
  weatherTo: (to: string, blend?: number) => void;
  /** Free roam: the festival race with rivals (phase, the player's position, progress in m). */
  roamRace: {
    phase: string;
    placed: boolean;
    position: number;
    count: number;
    progress: number;
    rivals: number[];
  } | null;
  errors: string[];
}

/** The road or ground height at a point of the open world. */
const cityHeightAt = (x: number, z: number): number => {
  const map = cityMap();
  const deck = map.deckAt(x, z, 0.5);
  return deck ? deck.height : map.groundHeight(x, z);
};

/** The festival's marker colours by event kind (the minimap and the map screen agree). */
const EVENT_COLOURS: Record<EventKind, string> = {
  race: '#ff3b2f',
  drift: '#37d4ff',
  camera: '#ffd166',
  jump: '#ff8a5b',
};

/** The free-roam starts, as fast-travel destinations. */
const SPAWN_NAMES: ReadonlyArray<[RoamStart, string]> = [
  ['downtown', 'Downtown'],
  ['highway', 'Orbital highway'],
  ['suburbs', 'Suburbs'],
  ['port', 'Port'],
  ['mountain', 'Ridge Road'],
  ['circuit', 'Circuit'],
];

declare global {
  interface Window {
    __apex?: DebugApi;
  }
}

type Scenery = TestGroundScene | TrackScene | CityScene;

const STATS_INTERVAL = 0.5;
/** The first shift light comes on this far below the shift point. */
const SHIFT_LIGHT_RANGE = 1900;
/** Rival colours: every paint the player can pick, plus a few more. */
const AI_PAINTS = [...PAINTS.map((p) => p.hex), 0x2a9d4a, 0x6d4c41, 0x8e1b1b, 0x4a6fa5];
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

const REPLAY_SPEEDS = [0.25, 0.5, 1, 2, 4];
const REPLAY_CAMERAS: readonly ReplayCamera[] = ['tv', 'chase', 'onboard'];
/** Rough pace order of the classes, so a two-class grid starts with the faster cars in front. */
const CLASS_PACE: Record<string, number> = {
  Formula: 1,
  Prototype: 2,
  GT: 3,
  Touring: 4,
  Street: 5,
  SUV: 6,
};

/** Base car of each class: the menus' backdrop race uses one of them. */
const SHOWCASE_CARS = ['gt', 'formula', 'prototype', 'touring', 'street'];
/** Seconds the backdrop race follows one car before the director picks another. */
const ATTRACT_SHOT = 16;
/** Field of view of the title screen's slow orbit around the hero car. */
const HERO_FOV = 34;
/** Engine sound level while the menus are open over the backdrop race. */
const MENU_AUDIO = 0.35;
/** Free roam: seconds of the sweep over a street race's grid, and of the winner's moment. */
const GRID_INTRO_TIME = 3;
const WINNER_TIME = 5;
/** Other cars are heard within this many metres. */
const OTHER_EARSHOT = 90;
/** Free roam: the first-drive hints and when they come (seconds into the drive). */
const ROAM_HINTS: ReadonlyArray<{ at: number; keys: string; pad: string }> = [
  {
    at: 4,
    keys: 'Welcome to the city. L headlights, , and . indicators, X hazards, N horn.',
    pad: 'Welcome to the city. D-pad: up headlights, down hazards, left and right indicators; R3 horn.',
  },
  {
    at: 16,
    keys: 'Esc → Festival map shows every event; pick one to fast-travel there.',
    pad: 'Options → Festival map shows every event; pick one to fast-travel there.',
  },
  {
    at: 30,
    keys: 'Speed past the police and the heat rises: lose them out of sight, or pull over and pay.',
    pad: 'Speed past the police and the heat rises: lose them out of sight, or pull over and pay.',
  },
  {
    at: 44,
    keys: 'Drive up to a race arch and a field lines up; cross the line to race. R resets and repairs.',
    pad: 'Drive up to a race arch and a field lines up; cross the line to race. △ / Y resets and repairs.',
  },
];
/** Seconds of the circuit flyover before a race, and of the podium after one. */
const FLYOVER_TIME = 7;
const PODIUM_TIME = 5.5;
/** Automated browsers skip the race cinematics unless the URL asks for them (`?cinematics`). */
const CINEMATICS = !navigator.webdriver || new URLSearchParams(location.search).has('cinematics');
const WEATHER_NAMES: Record<Weather, string> = {
  clear: 'Clear',
  cloudy: 'Cloudy',
  overcast: 'Overcast',
  lightRain: 'Light rain',
  heavyRain: 'Heavy rain',
};

/** Random conditions for the backdrop race and championship rounds: mostly dry. */
function randomConditions(): Pick<SessionSetup, 'time' | 'weather'> {
  const times: Array<Conditions['time']> = [
    'track',
    'track',
    'morning',
    'midday',
    'afternoon',
    'golden',
    'dusk',
  ];
  const r = Math.random();
  const weather: Weather =
    r < 0.45
      ? 'clear'
      : r < 0.7
        ? 'cloudy'
        : r < 0.84
          ? 'overcast'
          : r < 0.94
            ? 'lightRain'
            : 'heavyRain';
  return { time: times[Math.floor(Math.random() * times.length)]!, weather };
}

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
  /** Arcade free roam: the street furniture the car sends flying. */
  private props: Props | null = null;
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
  private minimap: Minimap | CityMinimap | null = null;
  private carModel: CarModel = carById('gt');
  /** The model each car view was built for. */
  private readonly carModels: CarModel[] = [];
  private readonly minimapCars: MinimapCar[] = [];
  private readonly audio = new EngineAudio();
  /** The nearest other cars' engines, for their voices (reused every frame). */
  private readonly otherEngines: OtherEngine[] = Array.from({ length: OTHER_VOICES }, () => ({
    rpm: 0,
    throttle: 0,
    distance: 0,
    pan: 0,
  }));
  private readonly otherPicks: Array<{ i: number; d: number }> = [];
  /** Free roam: the first-drive hints, one at a time. */
  private roamHints: { time: number; next: number } | null = null;
  private roamSpotTimer = 0;
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
    damageAero: 0,
    damageEngine: 0,
    damageSteer: 0,
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
  /** Records the session being raced, for the replay. */
  private replayRecorder: ReplayRecorder | null = null;
  private lastReplay: Replay | null = null;
  /** The replay being watched, or null. */
  private replay: Replay | null = null;
  private replayTime = 0;
  private replaySpeed = 1;
  private replayPlaying = true;
  private replayCar = 0;
  private replayCamera: ReplayCamera = 'tv';
  private replayShownAt = -1;
  /** TV cameras for the circuit (replays and the menus' backdrop race). */
  private tv: TvDirector | null = null;
  private readonly tvTarget = new THREE.Vector3();
  private readonly tvVelocity = new THREE.Vector3();
  /** The menus' backdrop: an AI race watched from the TV cameras. */
  private attract = false;
  private attractCar = 0;
  private attractTimer = 0;
  private audioDuck = 1;
  /** Photo mode (from the pause menu or a replay), or null. */
  private photo: {
    camera: PhotoCamera;
    pipeline: PhotoPipeline;
    controls: PhotoControls;
    /** Where to go back to: the pause menu or the replay. */
    from: 'pause' | 'replay';
    target: THREE.Vector3;
    busy: boolean;
    status: string;
  } | null = null;
  private readonly photoSettings = defaultPhotoSettings();
  private readonly photoHost: HTMLElement;
  /** `?autopilot`: the AI drives the player's car too (demos and browser tests). */
  private readonly autopilot = new URLSearchParams(window.location.search).has('autopilot');
  /** `?cam=orbit`: circle the car while driving (a debug view; not in the camera cycle). */
  private readonly orbitView = new URLSearchParams(window.location.search).get('cam') === 'orbit';
  private readonly debug: DebugApi;
  private readonly idleInput = neutralInput();

  /** The running session (null only before the first one starts). */
  private session: SessionConfig | null = null;
  private track: Track | null = null;
  /** Moving weather: the change last announced ("from>to"). */
  private weatherHeading = '';
  /** False while the menus show a car idling in the background. */
  private driving = false;
  private paused = false;
  private race: RaceStatus | null = null;
  private resultsShown = false;
  /** Championship round being raced, or -1. */
  private seasonRound = -1;
  /** Seed for the rivals' liveries (the season's, so they keep their colours all year). */
  private liverySeed = 1;
  /** Title, car select and livery editor: the camera circles car 0 in the player's livery. */
  private showroom = false;
  /** Car 0's view shows this model in the car select screen (null = the session's car). */
  private previewModel: CarModel | null = null;
  /** The backdrop race waits on the grid while the title screen is up. */
  private gridHeld = false;
  private heroTime = 0;
  /** Screen changes nudge the camera (a short zoom), for a sense of motion. */
  private lastTop: string | null = null;
  private cameraKick = 0;
  private readonly menuAudio = new MenuAudio();
  /** The driving school in progress, its racing line on the road, and where the car is on it. */
  private school: DrivingSchool | null = null;
  private schoolLine: { mesh: THREE.Mesh; braking: boolean[]; line: RacingLine } | null = null;
  private schoolHint = -1;
  private schoolTrackHint = -1;
  private schoolDoneAt = -1;
  /** Before a race: a flyover of the circuit with its title card, while the grid waits. */
  private flyover: { time: number; card: HTMLElement } | null = null;
  /** After a race: the top three on a podium beside the start line. */
  private podium: {
    group: THREE.Group;
    views: CarView[];
    geometries: THREE.BufferGeometry[];
    material: THREE.Material;
    time: number;
    centre: THREE.Vector3;
    /** Where the camera's orbit starts, radians. */
    angle: number;
    overlay: HTMLElement;
    resultsShown: boolean;
  } | null = null;
  /** The launch intro is playing: menu input waits for it. */
  introActive = false;
  private finishedAt = -1;
  private bestLapSeen = Infinity;
  private records = loadRecords();
  private lastTime = -1;
  private frames = 0;
  /** Free roam: what the police make of the player, and their spike strips on the road. */
  private policeStatus: PoliceStatus | null = null;
  /** Free roam: the festival race with rivals under way, as the sim last reported it. */
  private roamRace: RoamRaceStatus | null = null;
  /** Free roam: the camera's sweep over a race's grid before the count. */
  private gridIntro: { time: number } | null = null;
  /** The throttle has been released since the car was placed, so a press can skip the sweep. */
  private introSkipArmed = false;
  private readonly tmpForward = vec3();
  /** Free roam: the winner's moment after a race (the camera circles, confetti falls). */
  private winner: { time: number; overlay: HTMLElement } | null = null;
  private readonly strips = new SpikeStrips();
  /** Free roam: the police helicopter, above the car from four stars. */
  private readonly helicopter = new Helicopter();
  /** Arcade: the skill points of the session, and their HUD. */
  private skill: Skill | null = null;
  private readonly skillHud: SkillHud;
  /** Free roam: the festival's events and rules, their HUD, their furniture and their bests. */
  private festival: Festival | null = null;
  private readonly eventHud: EventHud;
  private readonly raceCard: RaceCard;
  /** Black over the screen for a moment (the car being put on a race's grid). */
  private readonly fade: HTMLElement;
  private festivalScene: FestivalScene | null = null;
  /** Free roam: the pedestrians' figures, placed from the snapshot. */
  private pedestrianView: PedestrianView | null = null;
  private festivalRecords = loadFestivalRecords();
  /** The festival's ladder: lifetime skill points and wins, banked as the drive scores them. */
  private progress = loadProgress();
  private bankedSkill = 0;
  private progressDirty = false;
  private festivalMarkers: MinimapMarker[] = [];
  /** Whether the police have been told an event is on (speeding is sanctioned). */
  private sanctioned = false;
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
    host.onResize((w, h2) => {
      this.camera.setAspect(w / h2);
      this.photo?.camera.setAspect(w / h2);
    });
    host.setResolutionScale(settings.resolutionScale);

    this.scenery = this.buildProvingGround();
    this.rumble = new RumbleMixer(settings.rumble);

    const upshift = TEST_MULE.gearbox.upshiftRpm;
    this.hud = new Hud(ui, { upshiftRpm: upshift, shiftLightsFrom: upshift - SHIFT_LIGHT_RANGE });
    this.skillHud = new SkillHud(ui);
    this.eventHud = new EventHud(ui);
    this.raceCard = new RaceCard(ui);
    this.fade = el('div', 'fade');
    ui.appendChild(this.fade);
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
    // Mouse and touch selections click too (keyboard and pad ones sound in handleMenuInput).
    this.menuHost.addEventListener('click', (e) => {
      if (e.detail > 0 && (e.target as HTMLElement).closest?.('[data-nav]')) {
        this.menuAudio.play('select');
      }
    });
    this.photoHost = document.createElement('div');
    this.photoHost.className = 'photo-host';
    ui.appendChild(this.photoHost);
    this.menus = new MenuStore(settings, this.menuActions());
    this.menus.roamSpot.value = loadRoamSpot();
    this.menus.championship.value = loadSeason(isChampionship);
    this.focus = new FocusManager(() => this.focusScope());

    this.debug = {
      ready: false,
      backend: host.backend,
      frames: 0,
      simSteps: 0,
      simTime: 0,
      speed: 0,
      rearSlip: 0,
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
      police: null,
      soft: null,
      roamRace: null,
      pedestrians: 0,
      pedestrianSample: null,
      clock: null,
      weather: null,
      propsKnocked: 0,
      nearestProp: (x, z) => this.props?.nearest(x, z) ?? null,
      place: (x, z, yaw) => this.sim.command({ kind: 'place', car: 0, x, z, yaw }),
      weatherTo: (to, blend) => {
        if (isWeather(to)) this.sim.command({ kind: 'weather', to, blend });
      },
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
    if (direct) await this.startSession(this.freeSetup());
    else await this.startSession(this.showcaseSetup(), true, true);
    this.menus.set(direct ? [] : ['title']);
    render(h(MenuRoot, { store: this.menus }), this.menuHost);
    this.applyHudVisibility();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.pause();
        this.sim.pause();
        this.audio.suspend();
        this.menuAudio.suspend();
        this.rumble.stop(this.input.activePad);
      } else {
        if (!this.paused) this.sim.resume();
        if (!this.paused) this.audio.resume();
        this.menuAudio.resume();
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
    const unlock = () => {
      this.audio.unlock();
      this.menuAudio.unlock();
    };
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

  /**
   * The car for every place on the grid: all the player's car, mixed cars from their class, or
   * two classes with the faster one lined up in front. Seeded by the season in a championship,
   * so each rival keeps the same car all year.
   */
  private pickField(setup: SessionSetup, count: number, seed: number): string[] {
    const cars = [setup.carId];
    if (setup.field === 'same') {
      while (cars.length < count) cars.push(setup.carId);
      return cars;
    }
    const season = this.seasonRound >= 0 ? this.menus.championship.value : null;
    const rand = mulberry32(((season?.liverySeed ?? seed) ^ 0x5bd1e995) >>> 0);
    const pick = (className: string) => {
      const pool = CARS.filter((c) => c.className === className);
      return pool[Math.floor(rand() * pool.length)]?.id ?? setup.carId;
    };
    const own = carById(setup.carId).className;
    const other = setup.field === 'multi' && setup.secondClass !== own ? setup.secondClass : own;
    const rivals: string[] = [];
    for (let i = 1; i < count; i++) rivals.push(pick(i % 2 === 0 || other === own ? own : other));
    // Faster class first on the grid (the AI cars fill the grid in order).
    const pace = (id: string) => CLASS_PACE[carById(id).className] ?? 9;
    rivals.sort((a, b) => pace(a) - pace(b));
    return cars.concat(rivals);
  }

  /** The menus' backdrop: ten AI cars racing on a circuit (the given one, or a random one). */
  private showcaseSetup(trackId?: string): SessionSetup {
    const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
    return {
      ...this.menus.setup.value,
      mode: 'race',
      trackId: trackId || pick(TRACKS).id,
      carId: pick(SHOWCASE_CARS),
      opponents: 9,
      laps: 99,
      difficulty: 'expert',
      gridSlot: 0,
      field: 'class',
      ...randomConditions(),
    };
  }

  private configFor(given: SessionSetup, attract = false): SessionConfig {
    // Free roam, continuing: the car, the day and the weather the drive was left with (the
    // spot in hand, which outlives blocked storage).
    const spot = given.mode === 'roam' && given.resume ? this.menus.roamSpot.value : null;
    const setup: SessionSetup = spot
      ? {
          ...given,
          carId: CARS.some((c) => c.id === spot.carId) ? spot.carId : given.carId,
          time: isTimeOfDay(spot.time) ? spot.time : given.time,
          weather: isWeather(spot.weather) ? spot.weather : given.weather,
          handling: spot.handling === 'arcade' ? 'arcade' : 'sim',
        }
      : given;
    const seed = (Math.random() * 1e9) | 0;
    const count = setup.mode === 'race' ? setup.opponents + 1 : 1;
    const dayMinutes =
      setup.mode === 'roam'
        ? DAY_MINUTES[setup.roamDayLength]
        : setup.mode === 'free'
          ? 0
          : DAY_MINUTES[setup.dayLength];
    // Free roam: traffic slots for this device, each with its own everyday car.
    const detail =
      this.settings.detail === 'auto' ? detectDetail() : DETAIL_LEVELS[this.settings.detail];
    const traffic = setup.mode === 'roam' && !attract ? trafficSlotsFor(detail.chunks) : 0;
    // The police take slots after the traffic: the same body, white paint and a light bar;
    // the festival's street racers the slots after them.
    const police = traffic > 0 ? policeSlotsFor(detail.chunks) : 0;
    const racers = traffic > 0 ? racerSlotsFor(detail.chunks) : 0;
    const pedestrians = traffic > 0 ? pedestrianSlotsFor(detail.chunks) : 0;
    return {
      fieldCars:
        setup.mode === 'race'
          ? this.pickField(setup, count, seed)
          : traffic > 0
            ? [
                setup.carId,
                ...Array.from({ length: traffic }, (_, i) => trafficModel(i).id),
                ...Array.from({ length: police }, () => policeModel().id),
                ...Array.from({ length: racers }, (_, i) => racerModel(i).id),
              ]
            : undefined,
      traffic: traffic || undefined,
      police: police || undefined,
      racers: racers || undefined,
      pedestrians: pedestrians || undefined,
      mode: setup.mode,
      trackId:
        setup.mode === 'free' || setup.mode === 'roam' ? '' : setup.trackId || TRACKS[0]?.id || '',
      carId: setup.carId,
      location: setup.location,
      roamStart: setup.roamStart,
      roamSpawn: spot ? { x: spot.x, z: spot.z, yaw: spot.yaw, y: spot.y + 0.5 } : undefined,
      opponents: setup.opponents,
      laps: setup.laps,
      difficulty: setup.difficulty,
      gridSlot: Math.min(setup.gridSlot, setup.opponents),
      aids: { ...this.settings.aids },
      seed,
      attract: attract || (this.autopilot && setup.mode === 'race'),
      damage: attract ? 0 : DAMAGE_SCALE[this.settings.damage],
      grip: gripFactor(setup.weather),
      conditions: { time: setup.time, weather: setup.weather },
      // The day's clock at the chosen rate (never in attract), from the spot's hour when continuing.
      dayCycle: attract ? undefined : dayMinutes || undefined,
      weatherMoves:
        !attract &&
        setup.mode !== 'free' &&
        (setup.mode === 'roam' ? setup.roamWeatherMotion : setup.weatherMotion) === 'moving',
      clock: setup.mode === 'roam' && dayMinutes > 0 ? spot?.hour : undefined,
      handling: attract ? 'sim' : setup.handling,
    };
  }

  /** Builds the scene and cars for a session and starts it in the worker. */
  private async startSession(setup: SessionSetup, idle = false, attract = false): Promise<void> {
    const config = this.configFor(setup, attract);
    this.endSchool();
    this.endPodium();
    this.endFlyover();
    this.rumble.stop(this.input.activePad);
    const previous = this.session;
    this.session = config;
    // The proving ground is built at start-up; circuits are built when first driven.
    const roam = config.mode === 'roam';
    const changed = previous
      ? previous.trackId !== config.trackId || (previous.mode === 'roam') !== roam
      : config.trackId !== '' || roam;
    this.input.roam = roam;
    if (changed) this.buildScenery(config);
    else if (
      (this.scenery instanceof TrackScene || this.scenery instanceof CityScene) &&
      config.conditions
    ) {
      this.scenery.setConditions(config.conditions);
    }
    this.attract = attract && this.tv !== null;
    const season = this.seasonRound >= 0 ? this.menus.championship.value : null;
    this.liverySeed = season?.liverySeed ?? config.seed;
    const count =
      config.mode === 'race'
        ? config.opponents + 1
        : config.mode === 'roam'
          ? 1 + (config.traffic ?? 0) + (config.police ?? 0) + (config.racers ?? 0)
          : 1;
    // A change of world means a change of paint scheme (liveries or plain traffic): rebuild.
    // So does a change in the traffic and police slots, which decide who wears the light bar.
    const slots =
      previous?.traffic !== config.traffic ||
      previous?.police !== config.police ||
      previous?.racers !== config.racers;
    if (changed || (roam && slots)) this.buildCars([]);
    this.buildCars(
      Array.from({ length: count }, (_, i) => carById(config.fieldCars?.[i] ?? config.carId)),
    );
    this.setupGhost(config);
    this.replay = null;
    this.lastReplay = null;
    this.replayRecorder =
      !idle && config.mode !== 'free' ? new ReplayRecorder(this.cars.length, 30) : null;
    this.menus.replayAvailable.value = false;
    this.attractCar = 0;
    this.attractTimer = 0;
    this.tv?.cut();
    await this.sim.start(config);
    this.race = null;
    this.policeStatus = null;
    this.hud.setHeat(null);
    this.hud.setClock(null);
    this.weatherHeading = '';
    this.strips.clear();
    this.menuAudio.siren(0);
    this.helicopter.reset();
    this.menuAudio.rotor(0);
    this.cars[0]?.repairView();
    this.debug.soft = null;
    // Arcade: skill points, with smashed cones counting too.
    this.skill = config.handling === 'arcade' && !idle && !attract ? new Skill() : null;
    this.bankedSkill = 0;
    this.skillHud.setLadder(ladderStanding(this.progress.skill));
    this.skillHud.reset();
    if (this.cones) this.cones.onKnock = () => this.skill?.award('smash', 25, 'SMASH');
    if (this.props) {
      this.props.onKnock = (kind) => {
        const spec = PROP_SPECS[kind];
        this.skill?.award('smash', spec.points, spec.label);
        this.menuAudio.smash(spec.sound);
      };
    }
    // Free roam: the festival's events, with the bests kept in this browser.
    const events = roam ? festivalEvents(cityMap()) : [];
    this.festival =
      roam && !idle && !attract
        ? new Festival(
            events,
            this.festivalRecords,
            (id, value) => {
              this.festivalRecords = saveFestivalRecord(id, value);
            },
            () => this.sim.command({ kind: 'endRace' }),
          )
        : null;
    this.roamRace = null;
    this.eventHud.reset();
    this.raceCard.hide();
    this.fade.classList.remove('on');
    this.endGridIntro();
    this.endWinner();
    this.touch.setRoam(roam && !idle && !attract);
    // The first drive in the city: a few hints, once.
    this.roamHints =
      roam && !idle && !attract && !this.settings.roamHinted && !navigator.webdriver
        ? { time: 0, next: 0 }
        : null;
    this.sanctioned = false;
    this.festivalMarkers = events.map((e) => ({ x: e.x, z: e.z, color: EVENT_COLOURS[e.kind] }));
    this.menus.festival.value = roam ? this.festivalInfo() : null;
    this.resultsShown = false;
    this.finishedAt = -1;
    this.bestLapSeen = Infinity;
    this.raceHud.reset();
    this.engineer.reset();
    this.radio.stop();
    this.radioBox.hide();
    this.camera.reset();
    this.camera.mode = idle ? 'orbit' : this.drivingCamera;
    this.driving = !idle;
    this.paused = false;
    this.menus.inSession.value = !idle;
    if (!idle && CINEMATICS && config.mode === 'race' && this.track) this.startFlyover(config);
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
    this.helicopter.root.removeFromParent();
    this.strips.root.removeFromParent();
    this.ghostView?.root.removeFromParent();
    this.scenery.dispose();
    this.minimap?.dispose();
    this.minimap = null;
    this.cones = null;
    this.props?.dispose();
    this.props = null;
    this.festivalScene?.dispose();
    this.festivalScene = null;
    this.pedestrianView?.dispose();
    this.pedestrianView = null;
    const def = config.trackId ? trackById(config.trackId) : undefined;
    if (config.mode === 'roam') {
      this.track = null;
      this.tv = null;
      const map = cityMap();
      const detail =
        this.settings.detail === 'auto' ? detectDetail() : DETAIL_LEVELS[this.settings.detail];
      this.scenery = new CityScene(map, config.conditions, detail);
      this.festivalScene = new FestivalScene(festivalEvents(map));
      this.scenery.scene.add(this.festivalScene.root);
      this.pedestrianView = new PedestrianView(config.pedestrians ?? 0);
      this.scenery.scene.add(this.pedestrianView.root);
      if (config.handling === 'arcade') {
        // Street furniture and cones to send flying for points.
        this.props = new Props(cityPropPlacements(map), TEST_MULE.body);
        this.scenery.scene.add(this.props.root);
      }
      this.minimap = new CityMinimap(this.ui, map, {
        minX: MAP_MIN_X,
        maxX: MAP_MAX_X,
        minZ: MAP_MIN_Z,
        maxZ: MAP_MAX_Z,
      });
    } else if (def) {
      this.track = new Track(def);
      const scene = new TrackScene(this.track, config.conditions);
      this.scenery = scene;
      this.minimap = new Minimap(this.ui, this.track);
      this.tv = new TvDirector(this.track, { obstacles: scene.obstacles });
    } else {
      this.track = null;
      this.tv = null;
      this.scenery = this.buildProvingGround();
    }
    this.scenery.buildEnvironment(this.host.renderer);
    for (const car of this.cars) this.scenery.scene.add(car.root);
    void this.host.renderer.compileAsync(this.scenery.scene, this.camera.camera);
  }

  /** One view per car; a view is rebuilt only when its car model changes. */
  private buildCars(models: readonly CarModel[]): void {
    const player = models[0];
    if (player && player.id !== this.carModel.id) {
      this.carModel = player;
      this.rumble.limiterRpm = player.spec.engine.limiterRpm;
      const upshift = player.spec.gearbox.upshiftRpm;
      this.hud.setEngine({ upshiftRpm: upshift, shiftLightsFrom: upshift - SHIFT_LIGHT_RANGE });
    }
    while (this.cars.length > models.length) {
      const car = this.cars.pop()!;
      car.root.removeFromParent();
      car.dispose();
      this.states.pop();
      this.minimapCars.pop();
      this.carModels.pop();
    }
    for (let i = 0; i < models.length; i++) {
      const model = models[i]!;
      if (this.carModels[i]?.id === model.id) continue;
      // Traffic wears plain paint and the police white with a light bar; the street racers
      // and everyone else a livery.
      const roam = this.session?.mode === 'roam' && i > 0;
      const role = roam ? this.roamRole(i) : 'car';
      const view =
        role === 'police'
          ? new CarView(model.spec, POLICE_PAINT, model.style, undefined, false, true)
          : role === 'traffic'
            ? new CarView(model.spec, trafficPaint(i - 1), model.style)
            : new CarView(model.spec, 0xffffff, model.style, this.liveryFor(i), i === 0);
      const old = this.cars[i];
      if (old) {
        old.root.removeFromParent();
        old.dispose();
        this.cars[i] = view;
        this.carModels[i] = model;
      } else {
        this.cars.push(view);
        this.carModels.push(model);
        this.states.push(createCarRenderState());
        this.minimapCars.push({ x: 0, z: 0, color: '#fff', player: i === 0 });
      }
    }
    for (const car of this.cars) {
      if (!car.root.parent) this.scenery.scene.add(car.root);
    }
    this.repaint();
  }

  /** Free roam: what a snapshot slot after the player is (traffic, then police, then racers). */
  private roamRole(car: number): 'traffic' | 'police' | 'racer' {
    const traffic = this.session?.traffic ?? 0;
    const police = this.session?.police ?? 0;
    return car <= traffic ? 'traffic' : car <= traffic + police ? 'police' : 'racer';
  }

  /** The player's livery, or a rival's: random but the same all session (and all season). */
  private liveryFor(car: number): Livery {
    const player = this.settings.livery;
    if (car === 0 && (!this.attract || this.showroom)) return player;
    return randomLivery(mulberry32((this.liverySeed + car * 7919) >>> 0), player);
  }

  /** Applies every car's livery, and colours the minimap dots to match. */
  private repaint(): void {
    const roam = this.session?.mode === 'roam';
    for (let i = 0; i < this.cars.length; i++) {
      const dot = this.minimapCars[i];
      if (roam && i > 0 && this.roamRole(i) !== 'racer') {
        // Traffic keeps its plain paint; it shows as pale dots on the map, the police as blue.
        if (dot) dot.color = this.roamRole(i) === 'police' ? '#4f8dff' : '#d8dce2';
        continue;
      }
      const livery = this.liveryFor(i);
      this.cars[i]!.setLivery(livery);
      if (dot) dot.color = cssColor(livery.primary);
    }
  }

  private pause(): void {
    if (!this.driving || this.paused) return;
    this.paused = true;
    this.sim.pause();
    this.audio.suspend();
    this.radio.stop();
    this.rumble.stop(this.input.activePad);
    if (this.session?.mode === 'roam') {
      this.menus.festival.value = this.festivalInfo();
      this.keepRoamSpot();
    }
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
    if (this.session?.mode === 'roam') this.keepRoamSpot();
    this.menus.set(['main']);
    if (this.paused) {
      this.paused = false;
      this.sim.resume();
      this.audio.resume();
    }
    this.leaveReplay();
    // Behind the menus: an AI race on the circuit just driven (no rebuild), or a random one.
    void this.startSession(this.showcaseSetup(this.session?.trackId), true, true).then(() =>
      this.menus.set(['main']),
    );
  }

  private applyHudVisibility(): void {
    const driving =
      this.driving && !this.menus.open && !this.photo && !this.flyover && !this.podium;
    this.hud.setVisible(driving);
    this.skillHud.setVisible(driving && this.skill !== null);
    this.eventHud.setVisible(driving && this.festival !== null);
    this.raceCard.setVisible(driving && this.festival !== null);
    const mode = this.session?.mode;
    this.raceHud.setVisible(driving && mode !== 'free' && mode !== 'roam' && !this.school);
    this.minimap?.setVisible(driving);
    this.telemetry.setVisible(driving && this.settings.telemetry);
    this.telemetry.root.classList.toggle('below-map', this.minimap !== null);
    if (!driving) this.radioBox.hide();
    if (this.school) this.school.root.hidden = !driving;
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
    if (this.photo) this.handlePhotoInput(dt);
    else if (this.wheelSetup.visible) this.wheelSetup.update(input.wheelPad, dt);
    else if (menusOpen) this.handleMenuInput(dt);
    else if (this.flyover || this.podium) this.handleCinematicInput();
    else if (this.driving) this.handleActions();
    this.menus.prompts.value = promptFamily(
      this.settings.prompts,
      input.lastDevice,
      input.padFamily,
    );
    this.menus.padFamily.value = input.padFamily;

    const controls =
      this.driving &&
      !this.menus.open &&
      !this.wheelSetup.visible &&
      !this.photo &&
      !this.flyover &&
      !this.podium;
    if (controls) this.applyHudVisibility();
    this.sim.tick(now, [controls ? input.driver : this.idleInput]);

    this.menuAudio.setMusic(this.menus.open && !this.replay && this.menus.top !== 'pause');
    const duck = this.menus.open && !this.replay ? MENU_AUDIO : 1;
    if (duck !== this.audioDuck) {
      this.audioDuck = duck;
      this.audio.setVolume(this.settings.audio.volume * duck);
    }
    const snapshot = this.sim.latest;
    const view = this.sim.latestView;
    if (this.replay) {
      this.menuAudio.siren(0);
      this.updateReplay(dt);
    } else if (snapshot && view) {
      const count = Math.min(snapshot.carCount, this.cars.length);
      for (let i = 0; i < count; i++) {
        interpolateCar(view, i, snapshot.alpha, this.states[i]!);
        this.cars[i]!.update(this.states[i]!);
      }
      const player = this.states[0]!;
      if (this.session?.mode === 'roam' && count > 0) {
        this.updateSoftBody(view, snapshot.carCount, player, dt);
        if (this.pedestrianView) {
          const base = snapshot.carCount * CAR_STRIDE + SOFT_FLOATS;
          this.pedestrianView.update(view, base, snapshot.simTime);
          let about = 0;
          let nearest = Infinity;
          for (let i = 0; i < this.pedestrianView.count; i++) {
            const o = base + i * PED_STRIDE;
            if (view[o + 4]! < 0) continue;
            about++;
            const d = Math.hypot(view[o]! - player.pos.x, view[o + 2]! - player.pos.z);
            if (d < nearest) {
              nearest = d;
              this.debug.pedestrianSample = {
                dx: Math.round(view[o]! - player.pos.x),
                dz: Math.round(view[o + 2]! - player.pos.z),
                y: Math.round(view[o + 1]! * 100) / 100,
                state: view[o + 4]!,
              };
            }
          }
          this.debug.pedestrians = about;
        }
      }
      this.cones?.update(dt, player);
      this.props?.update(dt, player);
      this.debug.propsKnocked = this.props?.knocked ?? 0;
      const top = this.menus.top;
      const showroom = top === 'livery' || top === 'carSelect' || top === 'title';
      if (showroom !== this.showroom) {
        this.showroom = showroom;
        this.repaint();
        this.camera.reset();
        this.camera.mode = showroom || !this.driving ? 'orbit' : this.drivingCamera;
        this.tv?.cut();
      }
      this.updateShowroom();
      if (top === 'title' && this.attract) this.updateHeroCamera(dt, player);
      else if (this.attract && !showroom) this.updateAttractCamera(dt, count, snapshot.race);
      else if (this.flyover) this.updateFlyover(dt);
      else if (this.podium) this.updatePodium(dt);
      else if (this.gridIntro) this.updateGridIntro(dt, player);
      else if (this.winner) this.updateWinner(dt, player);
      else this.camera.update(dt, player);
      this.applyCameraKick(dt, top);
      this.race = snapshot.race;
      if (this.session?.mode === 'roam')
        this.updatePolice(snapshot.police ?? null, count, controls, dt);
      if (this.replayRecorder && snapshot.race && !this.paused) {
        this.replayRecorder.record(snapshot.simTime, this.states);
      }
      if (controls) {
        this.hud.update(player, dt);
        const roam = this.session?.mode === 'roam';
        this.hud.setSpeedLimit(
          roam ? cityMap().speedLimitAt(player.pos.x, player.pos.z, player.pos.y) : 0,
        );
        const clock = this.dayClock();
        this.hud.setClock(clock);
        this.debug.clock = clock;
        this.menuAudio.horn(roam && (player.flags & FLAG_HORN) !== 0);
        if (roam) {
          this.updateRoamHints(dt);
          // Every so often, so closing the tab keeps the spot too.
          this.roamSpotTimer += dt;
          if (this.roamSpotTimer > 15) {
            this.roamSpotTimer = 0;
            this.keepRoamSpot();
          }
        }
        if (this.skill) {
          this.skill.update(dt, player, this.states, count);
          this.skillHud.update(this.skill);
          this.bankSkill();
        }
        if (this.festival) {
          this.updateRoamRace(snapshot.roamRace ?? null);
          this.festival.update(dt, player, snapshot.roamRace ?? null);
          this.eventHud.update(this.festival.view);
          for (const n of this.festival.notices.splice(0)) {
            if (n.results) {
              this.raceCard.show(n.event.name, n.text.replace(`${n.event.name}: `, ''), n.results);
            } else {
              this.toasts.show(n.text, { timeout: 6 });
            }
            if (n.position === 1) this.startWinner(n.event.name);
            if (n.position === 1 && this.skill) this.skill.award('race', 1000, 'WIN');
            if (n.position === 1) {
              this.progress.wins++;
              this.progressDirty = true;
            } else if (n.medal && this.skill) this.skill.award('race', 500, 'RACE');
          }
          this.festivalScene?.setNextCheckpoint(this.festival.nextCheckpoint(), dt);
          // An event on, or close ahead, is sanctioned: the police let the speed go.
          const view = this.festival.view;
          const sanctioned =
            view.active !== null || (view.hint !== null && view.hint.distance < 150);
          if (sanctioned !== this.sanctioned) {
            this.sanctioned = sanctioned;
            this.sim.command({ kind: 'sanction', on: sanctioned });
          }
        }
        this.telemetry.update(dt, player, {
          steer: input.raw.steer,
          throttle: input.raw.throttle,
          brake: input.raw.brake,
          device: this.deviceName(),
        });
      }
      this.updateRace(dt, player, count);
      if (this.school && controls) this.updateSchool(dt, player);
      const focus = this.attract ? (this.states[this.attractCar] ?? player) : player;
      this.updateAudio(dt, focus);
      if (controls) this.rumble.update(dt, player, input.activePad);
      else if (this.wasControlling) this.rumble.stop(input.activePad);
      this.wasControlling = controls;
      if (this.session?.mode === 'free' && controls) {
        for (const result of this.dragTimer.update(dt, player.pos.x, player.pos.z, player.speed)) {
          this.toasts.show(formatDragResult(result, this.settings.units), { timeout: 8 });
        }
      }
      this.carPosition.set(focus.pos.x, focus.pos.y, focus.pos.z);
      this.scenery.follow(this.carPosition);
      this.statSteps += snapshot.steps;
      this.statStepCount++;
    }
    this.updateWeather(dt);
    this.quickMenu.update(dt);
    if (this.menus.top === 'tester') this.updateTester();

    if (this.photo) this.photo.pipeline.render();
    else this.host.renderer.render(this.scenery.scene, this.camera.camera);

    this.frames++;
    if (this.frames === 2) document.body.classList.add('running');
    this.updateStats(realDt);
    this.updateDebug(snapshot !== null);
  }

  /**
   * Free roam: a festival race's grid and countdown: a notice when the rivals line up, the
   * camera behind the car once it is put on the grid, and the beeps of the countdown.
   */
  private updateRoamRace(status: RoamRaceStatus | null): void {
    const previous = this.roamRace;
    this.roamRace = status;
    const phase = status?.phase ?? null;
    const before = previous?.phase ?? null;
    if (phase === 'grid' && before !== 'grid') {
      const name = festivalEvents(cityMap()).find((e) => e.id === status!.id)?.name ?? 'the race';
      const rivals = status!.count - 1;
      this.toasts.show(
        `${rivals} rival${rivals === 1 ? '' : 's'} lined up for ${name}. Cross the line to race.`,
        { timeout: 5 },
      );
    } else if (phase === 'countdown' && before !== 'countdown') {
      // Black while the sim puts the car on the grid; back once it is there.
      this.fade.classList.add('on');
      this.raceCard.hide();
      this.menuAudio.play('move');
    } else if (phase === 'countdown' && status && previous) {
      // A fresh press during the sweep skips it (a pedal still held from the line doesn't).
      const throttle = this.input.driver.throttle;
      if (throttle < 0.2) this.introSkipArmed = true;
      if (
        status.intro &&
        status.placed &&
        ((this.introSkipArmed && throttle > 0.5) ||
          this.input.ui.some(({ event }) => event === 'confirm' || event === 'back'))
      ) {
        this.sim.command({ kind: 'skipIntro' });
      }
      if (status.placed && !previous.placed) {
        this.camera.reset();
        this.fade.classList.remove('on');
        this.introSkipArmed = throttle < 0.5;
        // The sweep over the grid, until the sim starts the count.
        if (status.intro) this.gridIntro = { time: 0 };
      }
      if (
        !status.intro &&
        Math.ceil(status.countdown) !== Math.ceil(previous.countdown) &&
        status.countdown > 0
      )
        this.menuAudio.play('move');
    } else if (phase === 'racing' && before === 'countdown') {
      this.menuAudio.play('start');
    }
    if (phase !== 'countdown') this.fade.classList.remove('on');
    if (this.gridIntro && !(phase === 'countdown' && status?.intro)) this.endGridIntro();
    this.debug.roamRace = status
      ? {
          phase: status.phase,
          placed: status.placed,
          position: status.position,
          count: status.count,
          progress: Math.round(status.progress),
          rivals: status.rivals.map((r) => Math.round(r.progress)),
        }
      : null;
  }

  /**
   * Free roam: the sweep over a race's grid: from ahead of the field on its right, looking back
   * along it, down to behind the car, easing in as the count is about to start.
   */
  private updateGridIntro(dt: number, player: CarRenderState): void {
    const intro = this.gridIntro!;
    intro.time += dt;
    const t = Math.min(intro.time / GRID_INTRO_TIME, 1);
    const u = 1 - (1 - t) * (1 - t);
    const fwd = forwardOf(this.tmpForward, player.rot);
    const len = Math.hypot(fwd.x, fwd.z) || 1;
    const fx = fwd.x / len;
    const fz = fwd.z / len;
    const rx = -fz;
    const rz = fx;
    const p = player.pos;
    const sx = p.x + fx * 26 + rx * 7;
    const sz = p.z + fz * 26 + rz * 7;
    const ex = p.x - fx * 7.5;
    const ez = p.z - fz * 7.5;
    const cam = this.camera.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(sx + (ex - sx) * u, p.y + 5 - 2.6 * u, sz + (ez - sz) * u);
    const look = 12 - 10 * u;
    cam.lookAt(p.x + fx * look, p.y + 0.8, p.z + fz * look);
    if (cam.fov !== 50) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
    if (t >= 1) this.endGridIntro();
  }

  private endGridIntro(): void {
    if (!this.gridIntro) return;
    this.gridIntro = null;
    this.camera.reset();
  }

  /** Free roam: a race won: confetti and a banner, and the camera circling the car a while. */
  private startWinner(name: string): void {
    this.endWinner();
    const overlay = el('div', 'podium-overlay');
    const confetti = el('div', 'podium-confetti');
    const colours = ['#ff3b2f', '#ffd166', '#39d98a', '#ffffff', '#4cc9f0'];
    for (let i = 0; i < 60; i++) {
      const piece = el('span');
      piece.style.setProperty('--x', `${(Math.random() * 100).toFixed(1)}%`);
      piece.style.setProperty('--d', `${(Math.random() * 2).toFixed(2)}s`);
      piece.style.setProperty('--t', `${(3 + Math.random() * 2).toFixed(2)}s`);
      piece.style.setProperty('--c', colours[i % colours.length]!);
      confetti.appendChild(piece);
    }
    const banner = el('div', 'podium-banner');
    const label = el('span', 'podium-label');
    setText(label, 'You win');
    const title = el('span', 'podium-name');
    setText(title, name);
    banner.append(label, title);
    banner.addEventListener('pointerdown', () => this.endWinner());
    overlay.append(confetti, banner);
    this.ui.appendChild(overlay);
    this.winner = { time: 0, overlay };
    this.camera.mode = 'orbit';
    this.camera.reset();
    this.menuAudio.play('start');
  }

  private updateWinner(dt: number, player: CarRenderState): void {
    const winner = this.winner!;
    winner.time += dt;
    this.camera.update(dt, player);
    const skip = winner.time > 1 && this.input.ui.length > 0;
    if (winner.time >= WINNER_TIME || skip) this.endWinner();
  }

  private endWinner(): void {
    const winner = this.winner;
    if (!winner) return;
    this.winner = null;
    const overlay = winner.overlay;
    overlay.classList.add('podium-done');
    setTimeout(() => overlay.remove(), 700);
    this.camera.mode = this.drivingCamera;
    this.camera.reset();
  }

  /**
   * Free roam: the wanted level on the HUD (with a notice when it changes), the sirens' volume
   * from the nearest police car with its lights on, and the spike strips laid on the road.
   */
  private updatePolice(
    status: PoliceStatus | null,
    count: number,
    controls: boolean,
    dt: number,
  ): void {
    const previous = this.policeStatus;
    this.policeStatus = status;
    this.hud.setHeat(status);
    if (status && previous && controls) {
      if (status.helicopter && !previous.helicopter && status.state === 'pursuit') {
        this.toasts.show('A helicopter has you from above. Get under the orbital to shake it.', {
          timeout: 6,
        });
      }
      if (status.heat > previous.heat) {
        this.toasts.show(
          previous.heat === 0
            ? 'The police are after you. Lose them, or pull over and pay the fine.'
            : `Wanted level ${status.heat}: ${status.heat >= 4 ? 'roadblocks and spike strips ahead.' : status.heat >= 3 ? 'expect roadblocks.' : 'more units on the way.'}`,
          { timeout: 5 },
        );
      } else if (status.state !== previous.state) {
        if (status.state === 'busted') {
          this.toasts.show(
            `Busted. Fine paid: $${Math.round(previous.fine).toLocaleString('en-US')}.`,
            {
              timeout: 6,
            },
          );
        } else if (status.state === 'escaped') {
          this.toasts.show('You got away. Heat cleared.', { timeout: 5 });
        }
      }
    }
    const scene = this.scenery.scene;
    if (this.strips.root.parent !== scene) scene.add(this.strips.root);
    this.strips.update(status?.strips ?? [], cityHeightAt);
    // The helicopter: over the car from four stars, its searchlight on after dark.
    if (this.helicopter.root.parent !== scene) scene.add(this.helicopter.root);
    const me = this.states[0]!;
    const night = this.nightNow();
    const overhead = status?.helicopter === true && status.state === 'pursuit';
    this.helicopter.update(dt, me.pos.x, me.pos.y, me.pos.z, overhead, night);
    this.menuAudio.rotor(controls && overhead ? 0.7 : 0);
    // The sirens: loudest right beside a police car with its lights on, fading with distance.
    let level = 0;
    if (controls && status && status.state === 'pursuit') {
      const player = this.states[0]!;
      for (let i = 1; i < count; i++) {
        const car = this.states[i]!;
        if ((car.flags & FLAG_SIREN) === 0) continue;
        const d = Math.hypot(car.pos.x - player.pos.x, car.pos.z - player.pos.z);
        level = Math.max(level, 1 / (1 + d / 45));
      }
    }
    this.menuAudio.siren(level);
    // For the tests: where the units are.
    const first = 1 + (this.session?.traffic ?? 0);
    const player = this.states[0]!;
    this.debug.police = status
      ? {
          heat: status.heat,
          state: status.state,
          helicopter: status.helicopter,
          units: this.states.slice(first, count).map((car) => ({
            x: Math.round(car.pos.x),
            z: Math.round(car.pos.z),
            d: Math.round(Math.hypot(car.pos.x - player.pos.x, car.pos.z - player.pos.z)),
            siren: (car.flags & FLAG_SIREN) !== 0,
          })),
        }
      : null;
  }

  /**
   * Free roam: bends the player's body to the soft body's lattice (after the cars in the
   * snapshot), drops the panels the sim says have come off, and flies the debris.
   */
  private updateSoftBody(
    view: Float32Array,
    carCount: number,
    player: CarRenderState,
    dt: number,
  ): void {
    const car = this.cars[0];
    if (!car) return;
    const base = carCount * CAR_STRIDE;
    const flags = car.deform(view, base);
    car.detach(flags, this.scenery.scene, player.vel, cityHeightAt);
    car.updateDebris(dt, cityHeightAt);
    let crush = 0;
    for (let i = 0; i < SOFT_NODES * 3; i++) crush = Math.max(crush, Math.abs(view[base + i]!));
    this.debug.soft = { crush, parts: flags, moved: car.bodyMoved };
  }

  /** Rain around the camera and spray behind the cars (does nothing in the dry). */
  private updateWeather(dt: number): void {
    const scene = this.scenery;
    if (scene instanceof CityScene) {
      scene.setTime(this.sim.latest?.simTime ?? 0);
      scene.setClock(this.dayClock());
      scene.setWeather(this.updateMovingWeather());
      scene.update(dt, this.camera.camera);
      return;
    }
    if (!(scene instanceof TrackScene)) return;
    scene.setClock(this.dayClock());
    scene.setWeather(this.updateMovingWeather());
    scene.update(dt, this.camera.camera);
    for (let i = 0; i < this.cars.length; i++) {
      const s = this.states[i]!;
      scene.spray(s.pos.x, s.pos.y, s.pos.z, s.vel.x, s.vel.z);
    }
  }

  /** Title screen: the backdrop race waits on the grid while the camera slowly circles car 0. */
  private updateHeroCamera(dt: number, car: CarRenderState): void {
    this.heroTime += dt;
    const t = this.heroTime;
    const angle = 0.6 + t * 0.12;
    const radius = 5.6 + Math.sin(t * 0.21) * 0.9;
    const height = 0.9 + Math.sin(t * 0.13) * 0.35;
    const cam = this.camera.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(
      car.pos.x + Math.cos(angle) * radius,
      car.pos.y + height,
      car.pos.z + Math.sin(angle) * radius,
    );
    cam.lookAt(car.pos.x, car.pos.y + 0.45, car.pos.z);
    if (cam.fov !== HERO_FOV) {
      cam.fov = HERO_FOV;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Holds the backdrop race on the grid while the title is up, and in car select swaps car 0's
   * body for the car in focus, so the backdrop previews it.
   */
  private updateShowroom(): void {
    // First visit: offer the driving school once, on arriving at the main menu.
    const s = this.settings;
    if (
      this.menus.top === 'main' &&
      !s.schoolOffered &&
      !s.schoolDone &&
      !this.introActive &&
      !navigator.webdriver
    ) {
      s.schoolOffered = true;
      this.save();
      this.menus.push('schoolOffer');
    }
    const hold = (this.attract && this.menus.top === 'title') || this.flyover !== null;
    if (hold !== this.gridHeld) {
      this.gridHeld = hold;
      this.sim.command({ kind: 'holdStart', hold });
    }
    const session = this.session;
    if (!session) return;
    const preview =
      this.menus.top === 'carSelect'
        ? carById(this.menus.previewCar.value || this.menus.setup.value.carId)
        : null;
    if ((preview?.id ?? null) === (this.previewModel?.id ?? null)) return;
    this.previewModel = preview;
    const own = carById(session.fieldCars?.[0] ?? session.carId);
    this.buildCars(this.carModels.map((m, i) => (i === 0 ? (preview ?? own) : m)));
  }

  /** A short zoom when the menu screen changes: the backdrop moves with the menus. */
  private applyCameraKick(dt: number, top: string | null): void {
    if (top !== this.lastTop) {
      if (this.lastTop !== null && top !== null) this.cameraKick = 1;
      this.lastTop = top;
    }
    if (this.cameraKick <= 0) return;
    const cam = this.camera.camera;
    const k = this.cameraKick;
    cam.fov *= 1 - 0.05 * k * k;
    cam.updateProjectionMatrix();
    this.cameraKick = Math.max(k - dt * 2.5, 0);
  }

  /** Sound (and a light rumble on select) for a menu event the focus engine handled. */
  private menuFeedback(event: UiEvent): void {
    if (event === 'confirm') {
      this.menuAudio.play('select');
      this.menuPulse();
    } else if (event === 'tabPrev' || event === 'tabNext') this.menuAudio.play('tab');
    else if (event !== 'pause' && event !== 'back') this.menuAudio.play('move');
  }

  /** A short, light rumble for menu selections (when rumble is on). */
  private menuPulse(): void {
    const pad = this.input.activePad as (Gamepad & { vibrationActuator?: unknown }) | null;
    const rumble = this.settings.rumble;
    const actuator = pad?.vibrationActuator as
      | { playEffect?: (type: string, params: Record<string, number>) => Promise<unknown> }
      | undefined;
    if (!rumble.enabled || !actuator?.playEffect) return;
    const s = rumble.strength;
    void actuator
      .playEffect('dual-rumble', { duration: 45, strongMagnitude: 0.1 * s, weakMagnitude: 0.5 * s })
      .catch(() => undefined);
  }

  /** Backdrop race: the TV cameras follow one car, then another. */
  private updateAttractCamera(dt: number, count: number, race: RaceStatus | null): void {
    this.attractTimer += dt;
    if (this.attractTimer > ATTRACT_SHOT && count > 1) {
      this.attractTimer = 0;
      // Mostly the leader or a car in a close fight; sometimes anyone.
      const order = race?.order ?? [];
      const r = Math.random();
      const pick =
        r < 0.35 ? order[0] : r < 0.8 ? order[1 + Math.floor(Math.random() * 3)] : undefined;
      this.attractCar = pick ?? Math.floor(Math.random() * count);
      this.tv?.cut();
    }
    this.followWithTv(dt, this.states[this.attractCar] ?? this.states[0]!);
  }

  private followWithTv(dt: number, state: CarRenderState): void {
    if (!this.tv) {
      this.camera.update(dt, state);
      return;
    }
    this.tvTarget.set(state.pos.x, state.pos.y, state.pos.z);
    this.tvVelocity.set(state.vel.x, state.vel.y, state.vel.z);
    this.tv.update(dt, this.tvTarget, this.tvVelocity, this.camera.camera);
  }

  // ---------------------------------------------------------------- race cinematics

  /** Before a race: the camera sweeps over the end of the lap to the grid, under a title card. */
  private startFlyover(config: SessionConfig): void {
    const def = trackById(config.trackId);
    if (!def || !this.track) return;
    const card = el('div', 'flyover-card');
    const name = el('div', 'flyover-name');
    setText(name, def.name);
    const sub = el('div', 'flyover-sub');
    const weather = WEATHER_NAMES[config.conditions?.weather ?? 'clear'];
    const laps = `${config.laps} ${config.laps === 1 ? 'lap' : 'laps'}`;
    setText(sub, `${def.location} · ${laps} · ${weather}`);
    const skip = el('div', 'flyover-skip');
    setText(skip, 'Skip');
    card.append(name, sub, skip);
    card.addEventListener('pointerdown', () => this.endFlyover());
    this.ui.appendChild(card);
    this.flyover = { time: 0, card };
    // The grid waits for the flyover; updateShowroom releases it when the flyover ends.
    this.gridHeld = true;
    this.sim.command({ kind: 'holdStart', hold: true });
    this.applyHudVisibility();
  }

  private endFlyover(): void {
    if (!this.flyover) return;
    this.flyover.card.remove();
    this.flyover = null;
    this.camera.reset();
  }

  private updateFlyover(dt: number): void {
    const fly = this.flyover!;
    const track = this.track;
    if (!track) {
      this.endFlyover();
      return;
    }
    fly.time += dt;
    const t = Math.min(fly.time / FLYOVER_TIME, 1);
    // Eases out: quick over the back of the lap, settling as it reaches the grid.
    const u = 1 - (1 - t) * (1 - t);
    const s = track.length * 0.62 + (track.length * 0.38 - 40) * u;
    const p = track.at(s);
    const ahead = track.at(s + 90);
    const height = 60 - 42 * u;
    const side = 28 - 16 * u;
    const cam = this.camera.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(p.x - p.tz * side, height, p.z + p.tx * side);
    cam.lookAt(ahead.x, 0.5, ahead.z);
    if (cam.fov !== 50) {
      cam.fov = 50;
      cam.updateProjectionMatrix();
    }
    fly.card.classList.toggle('leaving', t > 0.85);
    if (t >= 1) this.endFlyover();
  }

  /**
   * During a flyover or the podium any button skips ahead (after a moment, so a button held from
   * the menus doesn't); pausing skips the flyover and opens the pause menu.
   */
  private handleCinematicInput(): void {
    const time = this.flyover?.time ?? this.podium?.time ?? 0;
    if (time < 0.6 || this.input.ui.length === 0) return;
    const pause = this.input.ui.some(({ event }) => event === 'pause');
    if (this.flyover) this.endFlyover();
    else this.podiumResults();
    if (pause && this.driving && !this.podium) this.pause();
  }

  /**
   * After a race: the top three on a podium beside the start line, under confetti, with the
   * camera circling them. Returns false when there is nothing to show.
   */
  private startPodium(race: RaceStatus): boolean {
    const track = this.track;
    if (!track || this.podium || !CINEMATICS) return false;
    const top = race.order.slice(0, 3).filter((car) => race.cars[car]?.finished);
    if (top.length === 0) return false;
    // Beside the start straight beyond the barrier, on whichever side and at whichever spot
    // nearest the line is clear of the grandstands (the camera circles it at 11 m).
    const scene = this.scenery;
    const stands: ReadonlyArray<Footprint> = 'obstacles' in scene ? scene.obstacles : [];
    const dist = track.wallOffset + 12;
    const spots = [0, -45, 45, -90, 90, -135, 135, -180, 180].flatMap((offset) =>
      [1, -1].map((side) => {
        const p = track.at(track.length + offset);
        const dx = -p.tz * side;
        const dz = p.tx * side;
        return { x: p.x + dx * dist, z: p.z + dz * dist, dx, dz };
      }),
    );
    const spot =
      spots.find((s) => stands.every((f) => Math.hypot(f.x - s.x, f.z - s.z) > f.r + 14)) ??
      spots[0]!;
    const group = new THREE.Group();
    group.position.set(spot.x, track.heightAt(), spot.z);
    group.rotation.y = Math.atan2(spot.dx, spot.dz); // faces the track
    const material = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, roughness: 0.6 });
    const geometries: THREE.BufferGeometry[] = [];
    const base = new THREE.BoxGeometry(13.5, 0.16, 7.6);
    geometries.push(base);
    const slab = new THREE.Mesh(base, material);
    slab.position.y = 0.08;
    slab.receiveShadow = true;
    group.add(slab);
    const views: CarView[] = [];
    const steps: Array<[number, number]> = [
      [0, 1.1],
      [-4.2, 0.7],
      [4.2, 0.4],
    ];
    steps.forEach(([x, h], i) => {
      const geo = new THREE.BoxGeometry(3.6, h, 6.6);
      geometries.push(geo);
      const block = new THREE.Mesh(geo, material);
      block.position.set(x, h / 2, 0);
      block.castShadow = true;
      block.receiveShadow = true;
      group.add(block);
      const car = top[i];
      if (car === undefined) return;
      const model = this.carModels[car] ?? carById(this.session?.carId ?? CARS[0]!.id);
      const view = new CarView(model.spec, 0xffffff, model.style, this.liveryFor(car));
      const state = createCarRenderState();
      state.pos.x = x;
      state.pos.y = h + model.spec.cogHeight;
      state.wheels.forEach((w, k) => {
        w.length = k < 2 ? model.spec.front.staticLength : model.spec.rear.staticLength;
      });
      view.update(state);
      group.add(view.root);
      views.push(view);
    });
    this.scenery.scene.add(group);

    const overlay = el('div', 'podium-overlay');
    const confetti = el('div', 'podium-confetti');
    const colours = ['#ff3b2f', '#ffd166', '#39d98a', '#ffffff', '#4cc9f0'];
    for (let i = 0; i < 70; i++) {
      const piece = el('span');
      piece.style.setProperty('--x', `${(Math.random() * 100).toFixed(1)}%`);
      piece.style.setProperty('--d', `${(Math.random() * 3).toFixed(2)}s`);
      piece.style.setProperty('--t', `${(3 + Math.random() * 2.5).toFixed(2)}s`);
      piece.style.setProperty('--c', colours[i % colours.length]!);
      confetti.appendChild(piece);
    }
    const banner = el('div', 'podium-banner');
    const label = el('span', 'podium-label');
    setText(label, top[0] === 0 ? 'You win' : 'Winner');
    const name = el('span', 'podium-name');
    setText(name, this.driverName(top[0]!));
    banner.append(label, name);
    banner.addEventListener('pointerdown', () => this.podiumResults());
    overlay.append(confetti, banner);
    this.ui.appendChild(overlay);

    this.podium = {
      group,
      views,
      geometries,
      material,
      time: 0,
      centre: group.position.clone().add(new THREE.Vector3(0, 1.2, 0)),
      angle: Math.atan2(-spot.dz, -spot.dx) - 0.6,
      overlay,
      resultsShown: false,
    };
    this.menuAudio.play('start');
    return true;
  }

  private updatePodium(dt: number): void {
    const podium = this.podium!;
    podium.time += dt;
    const t = podium.time;
    const a = podium.angle + t * 0.2;
    const radius = 11 - Math.min(t, PODIUM_TIME) * 0.3;
    const cam = this.camera.camera;
    cam.up.set(0, 1, 0);
    cam.position.set(
      podium.centre.x + Math.cos(a) * radius,
      podium.centre.y + 3,
      podium.centre.z + Math.sin(a) * radius,
    );
    cam.lookAt(podium.centre);
    if (cam.fov !== 45) {
      cam.fov = 45;
      cam.updateProjectionMatrix();
    }
    if (!podium.resultsShown && t >= PODIUM_TIME) this.podiumResults();
  }

  /** The results come up over the podium, which stays as their backdrop. */
  private podiumResults(): void {
    const podium = this.podium;
    if (!podium || podium.resultsShown) return;
    podium.resultsShown = true;
    podium.overlay.classList.add('podium-done');
    this.menus.set(['results']);
    this.applyHudVisibility();
  }

  private endPodium(): void {
    const podium = this.podium;
    if (!podium) return;
    podium.group.removeFromParent();
    for (const view of podium.views) view.dispose();
    for (const g of podium.geometries) g.dispose();
    podium.material.dispose();
    podium.overlay.remove();
    this.podium = null;
    this.camera.reset();
  }

  // ---------------------------------------------------------------- driving school

  private startSchool(): void {
    this.seasonRound = -1;
    const setup: SessionSetup = {
      ...this.menus.setup.value,
      mode: 'timeTrial',
      trackId: 'merriford-park',
      carId: 'formula-junior',
      time: 'midday',
      weather: 'clear',
    };
    this.menus.update(setup);
    this.menus.set([]);
    void this.startSession(setup).then(() => {
      this.beginSchool();
      this.resume();
    });
  }

  private beginSchool(): void {
    const track = this.track;
    if (!track) return;
    const model = carById('formula-junior');
    const line = computeRacingLine(track, lineOptionsFor(model.spec, model.aiGrip));
    const { mesh, braking } = racingLineMesh(line);
    this.scenery.scene.add(mesh);
    this.schoolLine = { mesh, braking, line };
    this.school = new DrivingSchool(this.ui);
    this.school.onPass = () => {
      this.menuAudio.play('select');
      this.menuPulse();
    };
    this.schoolHint = -1;
    this.schoolTrackHint = -1;
    this.schoolDoneAt = -1;
    // No ghost in the school.
    this.ghost = null;
    if (this.ghostView) this.ghostView.root.visible = false;
  }

  private endSchool(): void {
    this.school?.dispose();
    this.school = null;
    const line = this.schoolLine;
    if (line) {
      line.mesh.removeFromParent();
      line.mesh.geometry.dispose();
      (line.mesh.material as THREE.Material).dispose();
    }
    this.schoolLine = null;
  }

  /** Feeds the lesson in progress, and ends the school a few seconds after graduating. */
  private updateSchool(dt: number, s: CarRenderState): void {
    const school = this.school!;
    const track = this.track;
    const sl = this.schoolLine;
    if (!track || !sl) return;
    const pr = track.project(s.pos.x, s.pos.z, this.schoolTrackHint);
    this.schoolTrackHint = pr.index;
    const i = nearestLinePoint(sl.line, s.pos.x, s.pos.z, this.schoolHint);
    this.schoolHint = i;
    const device = this.input.lastDevice;
    const glyphs: Glyphs =
      device === 'touch'
        ? 'touch'
        : device === 'gamepad'
          ? this.input.padFamily === 'playstation'
            ? 'playstation'
            : 'xbox'
          : 'keyboard';
    school.setGlyphs(glyphs);
    school.update({
      speed: Math.abs(s.speed) * 3.6,
      brake: s.brake,
      distance: Math.abs(s.speed) * dt,
      onTrack: !offTrack(track, pr.lateral),
      offLine: Math.hypot(sl.line.x[i]! - s.pos.x, sl.line.z[i]! - s.pos.z),
      inBrakingZone: sl.braking[i] ?? false,
      drs: s.drs,
      ersBoost: s.ersBoost,
      dt,
    });
    if (school.finished && this.schoolDoneAt < 0) {
      this.schoolDoneAt = this.lastTime;
      this.settings.schoolDone = true;
      this.save();
      this.menuAudio.play('start');
    }
    if (this.schoolDoneAt > 0 && this.lastTime - this.schoolDoneAt > 4) this.quitToMenu();
  }

  // ---------------------------------------------------------------- photo mode

  /** Photo mode from the pause menu or a paused replay: a free camera, lens and filters. */
  private enterPhoto(): void {
    if (this.photo) return;
    const from = this.replay ? 'replay' : 'pause';
    if (this.replay) this.replayPlaying = false;
    const focus = this.replay ? this.states[this.replayCar] : this.states[0];
    const target = new THREE.Vector3(
      focus?.pos.x ?? 0,
      (focus?.pos.y ?? 0) + 0.5,
      focus?.pos.z ?? 0,
    );
    const camera = new PhotoCamera(this.photoSettings);
    const { width, height } = this.host.renderer.domElement.getBoundingClientRect();
    camera.setAspect(width / Math.max(height, 1));
    camera.reset(this.camera.camera, target);
    const pipeline = new PhotoPipeline(
      this.host.renderer,
      this.scenery.scene,
      camera.camera,
      this.photoSettings,
    );
    pipeline.setFocusTarget(target);
    const controls = new PhotoControls(this.host.renderer.domElement, camera);
    this.photo = { camera, pipeline, controls, from, target, busy: false, status: '' };
    this.menus.set([]);
    this.ui.classList.add('photo-mode');
    this.renderPhotoPanel();
    this.applyHudVisibility();
  }

  private leavePhoto(): void {
    const photo = this.photo;
    if (!photo) return;
    photo.controls.dispose();
    photo.pipeline.dispose();
    this.photo = null;
    render(null, this.photoHost);
    this.ui.classList.remove('photo-mode');
    this.menus.set([photo.from === 'replay' ? 'replay' : 'pause']);
    this.applyHudVisibility();
  }

  private renderPhotoPanel(): void {
    const photo = this.photo;
    if (!photo) return;
    render(
      h(PhotoScreen, {
        store: this.menus,
        settings: this.photoSettings,
        onChange: () => this.renderPhotoPanel(),
        onCapture: () => void this.capturePhoto(),
        onExit: () => this.leavePhoto(),
        dofUnavailable: photo.pipeline.dofNote || undefined,
        status: photo.status,
      }),
      this.photoHost,
    );
  }

  private async capturePhoto(): Promise<void> {
    const photo = this.photo;
    if (!photo || photo.busy) return;
    photo.busy = true;
    try {
      const blob = await capturePng(this.host.renderer, () => photo.pipeline.render(), {
        watermark: this.photoSettings.watermark,
      });
      const name = photoFileName();
      downloadPhoto(blob, name);
      photo.status = `Saved ${name}`;
    } catch (error) {
      photo.status = 'The photo could not be saved.';
      console.warn('Photo capture failed', error);
    } finally {
      photo.busy = false;
      this.renderPhotoPanel();
    }
  }

  /** Photo mode input: the panel through the focus engine, the camera from sticks and keys. */
  private handlePhotoInput(dt: number): void {
    const photo = this.photo!;
    const settings = this.photoSettings;
    for (const { event } of this.input.ui) {
      if (settings.showPanel && this.focus.handle(event)) continue;
      if (event === 'back' || event === 'pause') {
        if (settings.showPanel) {
          this.leavePhoto();
          return;
        }
        settings.showPanel = true;
        this.renderPhotoPanel();
      } else if (event === 'confirm' && !settings.showPanel) {
        void this.capturePhoto();
      }
    }
    if (settings.showPanel) this.focus.sync();
    const frame = photo.controls.read(this.input.activePad, settings.showPanel);
    if (frame.togglePanel) {
      settings.showPanel = !settings.showPanel;
      this.renderPhotoPanel();
    }
    if (frame.capture) void this.capturePhoto();
    if (photo.camera.update(dt, frame.camera, photo.target)) this.renderPhotoPanel();
  }

  // ---------------------------------------------------------------- replays

  private watchReplay(): void {
    const replay = this.lastReplay ?? this.replayRecorder?.finish() ?? null;
    if (!replay || replay.duration <= 0) return;
    this.lastReplay = replay;
    this.replayRecorder = null;
    this.replay = replay;
    this.replayTime = 0;
    this.replaySpeed = 1;
    this.replayPlaying = true;
    this.replayCar = 0;
    this.replayCamera = 'tv';
    this.replayShownAt = -1;
    this.tv?.cut();
    this.sim.pause();
    this.rumble.stop(this.input.activePad);
    this.radio.stop();
    this.radioBox.hide();
    this.menus.set(['replay']);
  }

  private leaveReplay(): void {
    if (!this.replay) return;
    this.replay = null;
    this.menus.replay.value = null;
    this.camera.mode = this.driving ? this.drivingCamera : 'orbit';
    this.camera.reset();
    if (!this.paused) this.sim.resume();
  }

  private replayCommand(command: ReplayCommand): void {
    const replay = this.replay;
    if (!replay) return;
    const count = Math.min(replay.carCount, this.cars.length);
    const speedIndex = REPLAY_SPEEDS.indexOf(this.replaySpeed);
    switch (command) {
      case 'playPause':
        if (!this.replayPlaying && this.replayTime >= replay.duration) this.replayTime = 0;
        this.replayPlaying = !this.replayPlaying;
        break;
      case 'back5':
      case 'forward5':
        this.replayTime = Math.min(
          Math.max(this.replayTime + (command === 'back5' ? -5 : 5), 0),
          replay.duration,
        );
        this.tv?.cut();
        this.camera.reset();
        break;
      case 'slower':
      case 'faster': {
        const next = speedIndex + (command === 'faster' ? 1 : -1);
        this.replaySpeed = REPLAY_SPEEDS[Math.min(Math.max(next, 0), REPLAY_SPEEDS.length - 1)]!;
        break;
      }
      case 'prevCar':
      case 'nextCar':
        this.replayCar = (this.replayCar + (command === 'nextCar' ? 1 : -1) + count) % count;
        this.tv?.cut();
        this.camera.reset();
        break;
      case 'camera': {
        const i = REPLAY_CAMERAS.indexOf(this.replayCamera);
        this.replayCamera = REPLAY_CAMERAS[(i + 1) % REPLAY_CAMERAS.length]!;
        this.tv?.cut();
        this.camera.reset();
        break;
      }
      case 'exit':
        this.leaveReplay();
        this.menus.set(['results']);
        return;
    }
    this.replayShownAt = -1;
  }

  /** Plays the replay: every car from the recording, the camera on the watched car. */
  private updateReplay(dt: number): void {
    const replay = this.replay!;
    if (this.replayPlaying) {
      this.replayTime = Math.min(this.replayTime + dt * this.replaySpeed, replay.duration);
      if (this.replayTime >= replay.duration) this.replayPlaying = false;
    }
    const time = replay.startTime + this.replayTime;
    const count = Math.min(replay.carCount, this.cars.length);
    for (let i = 0; i < count; i++) {
      replay.sample(time, i, this.states[i]!);
      this.cars[i]!.update(this.states[i]!);
    }
    const focus = this.states[Math.min(this.replayCar, count - 1)]!;
    if (this.replayCamera === 'tv') this.followWithTv(dt, focus);
    else {
      this.camera.mode = this.replayCamera === 'onboard' ? 'bonnet' : 'chase';
      this.camera.update(dt, focus);
    }
    if (this.scenery instanceof TrackScene) this.scenery.setStartLights(0, false);
    this.updateAudio(dt * this.replaySpeed, focus);
    this.carPosition.set(focus.pos.x, focus.pos.y, focus.pos.z);
    this.scenery.follow(this.carPosition);
    // The controls re-render a few times a second, not every frame.
    if (Math.abs(this.replayTime - this.replayShownAt) > 0.2 || this.replayShownAt < 0) {
      this.replayShownAt = this.replayTime;
      const final = this.race?.cars[this.replayCar];
      this.menus.replay.value = {
        time: this.replayTime,
        duration: replay.duration,
        speed: this.replaySpeed,
        playing: this.replayPlaying,
        camera: this.replayCamera,
        car: `${final ? `P${final.position} · ` : ''}${this.driverName(this.replayCar)}`,
      };
    }
  }

  private updateRace(dt: number, player: CarRenderState, count: number): void {
    const race = this.race;
    const track = this.track;
    if (this.scenery instanceof TrackScene) {
      const lights = race ? race.lights : 0;
      const green = race !== null && race.phase === 'racing' && race.time < 1.5;
      this.scenery.setStartLights(lights, green);
    }
    if (this.minimap && (track || this.session?.mode === 'roam')) {
      for (let i = 0; i < count; i++) {
        const dot = this.minimapCars[i]!;
        dot.x = this.states[i]!.pos.x;
        dot.z = this.states[i]!.pos.z;
      }
      this.minimap.update(this.minimapCars.slice(0, count), this.festivalMarkers);
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
    if (!me || race.mode === 'free' || this.school) return;
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
    const player = this.states[0];
    r.damageAero = player?.damageAero ?? 0;
    r.damageEngine = player?.damageEngine ?? 0;
    r.damageSteer = player?.damageSteer ?? 0;
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
          car: this.carModels[car]?.name ?? '',
          player: car === 0,
          bestLap: c.bestLap,
          time: c.finished ? c.finishTime : NaN,
          gap: c.finished ? c.finishTime - leaderTime : NaN,
        };
      }),
    };
    if (inSeason) this.scoreRound(season, race);
    this.menus.replayAvailable.value =
      this.lastReplay !== null || (this.replayRecorder?.duration ?? 0) > 5;
    if (!this.startPodium(race)) this.menus.set(['results']);
    this.applyHudVisibility();
  }

  private driverName(car: number): string {
    const season = this.seasonRound >= 0 ? this.menus.championship.value : null;
    const name = season?.names[car];
    if (name) return name;
    return rivalName(car);
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
      names.push(rivalName(car));
      paints.push(rivals[(car - 1) % rivals.length] ?? 0x9e9e9e);
    }
    const season: Championship = {
      tracks,
      liverySeed: (Math.random() * 1e9) | 0,
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
      ...randomConditions(),
    };
    this.menus.update(setup);
    this.seasonRound = season.round;
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
    if (top === 'replay') {
      for (const { event } of this.input.ui) {
        const command: ReplayCommand | null =
          event === 'confirm'
            ? 'playPause'
            : event === 'left'
              ? 'back5'
              : event === 'right'
                ? 'forward5'
                : event === 'up'
                  ? 'faster'
                  : event === 'down'
                    ? 'slower'
                    : event === 'tabPrev'
                      ? 'prevCar'
                      : event === 'tabNext'
                        ? 'nextCar'
                        : event === 'fastUp' || event === 'fastDown'
                          ? 'camera'
                          : event === 'back' || event === 'pause'
                            ? 'exit'
                            : null;
        if (command) this.replayCommand(command);
      }
      return;
    }
    if (this.introActive) return;
    for (const { event, source } of this.input.ui) {
      if (top === 'title') {
        this.menus.set(['main']);
        this.menuAudio.play('start');
        this.menuPulse();
        break;
      }
      if (top === 'tester' && source === 'pad' && event !== 'up' && event !== 'down') continue;
      if (this.focus.handle(event)) {
        this.menuFeedback(event);
        continue;
      }
      if (event === 'back' || event === 'pause') {
        if (top === 'pause') this.resume();
        else if (top !== 'results' && top !== 'main') {
          this.menus.pop();
          this.menuAudio.play('back');
        }
      }
    }
    this.focus.sync();
    this.applyHudVisibility();
  }

  private focusScope(): HTMLElement | null {
    if (this.photo) {
      return this.photoSettings.showPanel
        ? this.photoHost.querySelector<HTMLElement>('.photo-panel')
        : null;
    }
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
        case 'festivalMap':
          if (this.session?.mode === 'roam' && this.driving && !this.menus.open) {
            this.pause();
            this.menus.push('map');
          }
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
        this.menus.set([]);
        void this.startSession(setup).then(() => this.resume());
      },
      restartSession: () => {
        this.menus.set([]);
        const mode = this.session?.mode;
        if (mode === 'race' || mode === 'timeTrial') {
          void this.startSession({ ...this.menus.setup.value, mode }).then(() => {
            this.endFlyover();
            this.resume();
          });
        } else {
          this.resume();
          this.resetCar();
        }
      },
      resume: () => this.resume(),
      fastTravel: (id) => this.fastTravel(id),
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
      watchReplay: () => this.watchReplay(),
      photoMode: () => this.enterPhoto(),
      startSchool: () => this.startSchool(),
      replay: (command) => this.replayCommand(command),
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
    this.audio.setVolume(s.audio.volume * this.audioDuck);
    this.menuAudio.setLevels(s.audio.music, s.audio.sfx, s.audio.muted);
    this.audio.setMuted(s.audio.muted);
    this.rumble.settings = s.rumble;
    s.paint = s.livery.primary;
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
    if (this.camera.mode !== 'orbit') this.camera.mode = this.drivingCamera;
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
    this.audio.updateOthers(dt, this.nearestEngines(state));
  }

  /** The nearest other cars within earshot, nearest first, as engines for their voices. */
  private nearestEngines(focus: CarRenderState): readonly OtherEngine[] {
    const picks = this.otherPicks;
    picks.length = 0;
    const count = Math.min(this.sim.latest?.carCount ?? 0, this.states.length);
    for (let i = 0; i < count; i++) {
      const s = this.states[i]!;
      if (s === focus) continue;
      const d = Math.hypot(s.pos.x - focus.pos.x, s.pos.y - focus.pos.y, s.pos.z - focus.pos.z);
      if (d > OTHER_EARSHOT) continue;
      // Keep the nearest few, in order.
      let at = picks.length;
      while (at > 0 && picks[at - 1]!.d > d) at--;
      if (at >= OTHER_VOICES) continue;
      picks.splice(at, 0, { i, d });
      if (picks.length > OTHER_VOICES) picks.length = OTHER_VOICES;
    }
    // Which side each one is on, in the listener's frame (the focused car's heading).
    const fwd = forwardOf(this.tmpForward, focus.rot);
    const fx = fwd.x;
    const fz = fwd.z;
    for (let k = 0; k < picks.length; k++) {
      const pick = picks[k]!;
      const s = this.states[pick.i]!;
      const o = this.otherEngines[k]!;
      o.rpm = s.rpm;
      o.throttle = s.throttle;
      o.distance = pick.d;
      o.pan = bearingPan(s.pos.x - focus.pos.x, s.pos.z - focus.pos.z, fx, fz);
    }
    return picks.length === this.otherEngines.length
      ? this.otherEngines
      : this.otherEngines.slice(0, picks.length);
  }

  /** Free roam: remembers where the car is (with the car, the day and the weather) for Continue. */
  private keepRoamSpot(): void {
    const session = this.session;
    const state = this.states[0];
    if (!session || session.mode !== 'roam' || !state || !this.driving) return;
    const spot: RoamSpot = {
      x: Math.round(state.pos.x * 100) / 100,
      z: Math.round(state.pos.z * 100) / 100,
      y: Math.round(state.pos.y * 100) / 100,
      yaw: yawOf(state.rot),
      carId: session.carId,
      time: session.conditions?.time ?? 'midday',
      weather: this.sim.latest?.weather?.from ?? session.conditions?.weather ?? 'clear',
      handling: session.handling ?? 'sim',
    };
    const clock = this.dayClock();
    if (clock !== null) spot.hour = Math.round(clock * 1000) / 1000;
    saveRoamSpot(spot);
    this.keepProgress();
    this.menus.roamSpot.value = spot;
  }

  /**
   * With the day's clock running: the hour, from the sim's latest snapshot (the session's start
   * hour before the first arrives); null when the time of day stands still.
   */
  private dayClock(): number | null {
    const session = this.session;
    if (!session || !(session.dayCycle ?? 0)) return null;
    const hour = this.sim.latest?.clock;
    if (typeof hour === 'number') return hour;
    if (session.clock !== undefined) return session.clock;
    const time = session.conditions?.time ?? 'track';
    if (session.mode === 'roam') return cityHourOf(time);
    return hourOf(time, this.track?.def.theme.sunElevation ?? CITY_SUN_ELEVATION);
  }

  /**
   * Moving weather from the sim's latest snapshot (null when fixed), with a word as rain comes
   * in or eases off.
   */
  private updateMovingWeather(): WeatherMix | null {
    const mix = this.sim.latest?.weather ?? null;
    this.debug.weather = mix;
    const heading = mix ? `${mix.from}>${mix.to}` : '';
    if (heading === this.weatherHeading) return mix;
    this.weatherHeading = heading;
    if (mix && mix.from !== mix.to && this.driving) {
      if (isRaining(mix.to) && !isRaining(mix.from))
        this.toasts.show('Rain coming in', { timeout: 6 });
      else if (!isRaining(mix.to) && isRaining(mix.from))
        this.toasts.show('The rain is easing off', { timeout: 6 });
    }
    return mix;
  }

  /** How dark it is now, 0 … 1: by the day's clock in free roam, else by the time of day. */
  private nightNow(): number {
    const clock = this.dayClock();
    if (clock !== null) return darknessAt(sunElevationAt(clock));
    return darkness(this.session?.conditions?.time ?? 'track');
  }

  /**
   * Banks the drive's skill points on the festival's ladder as they are scored; a level
   * climbed brings a word, a jingle and the HUD's new line, and is kept at once.
   */
  private bankSkill(): void {
    const skill = this.skill;
    if (!skill) return;
    const gained = skill.score - this.bankedSkill;
    if (gained <= 0) return;
    this.bankedSkill = skill.score;
    const before = ladderStanding(this.progress.skill);
    this.progress.skill += gained;
    this.progressDirty = true;
    const after = ladderStanding(this.progress.skill);
    this.skillHud.setLadder(after);
    if (after.level > before.level) {
      this.toasts.show(`Festival level ${after.level}: ${after.title}`, { timeout: 8 });
      this.menuAudio.play('start');
      this.keepProgress();
    }
  }

  /** Writes the festival's tallies when they have changed (with the spot, and on a level). */
  private keepProgress(): void {
    if (!this.progressDirty) return;
    this.progressDirty = false;
    saveProgress(this.progress);
  }

  /** Free roam: the first-drive hints, spaced out over the first minute, once per browser. */
  private updateRoamHints(dt: number): void {
    const hints = this.roamHints;
    if (!hints) return;
    hints.time += dt;
    const hint = ROAM_HINTS[hints.next];
    if (!hint || hints.time < hint.at) return;
    const pad = this.input.lastDevice === 'gamepad' || this.input.lastDevice === 'wheel';
    this.toasts.show(pad ? hint.pad : hint.keys, { timeout: 8 });
    hints.next++;
    if (hints.next >= ROAM_HINTS.length) {
      this.roamHints = null;
      this.settings.roamHinted = true;
      this.save();
    }
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

  /** Free roam: the festival map's contents for the pause menu. */
  private festivalInfo(): FestivalInfo {
    const map = cityMap();
    const player = this.states[0];
    const destinations: FestivalInfo['destinations'] = [];
    for (const [id, name] of SPAWN_NAMES) {
      const s = map.spawns[id];
      destinations.push({ id: `spawn-${id}`, kind: 'spawn', name, best: null, x: s.x, z: s.z });
    }
    for (const e of festivalEvents(map)) {
      const best = this.festivalRecords[e.id];
      destinations.push({
        id: e.id,
        kind: e.kind,
        name: e.name,
        best: best === undefined ? null : Festival.format(e.kind, best),
        x: e.x,
        z: e.z,
      });
    }
    return {
      destinations,
      totals: festivalTotals(festivalEvents(map), this.festivalRecords),
      ladder: ladderStanding(this.progress.skill),
      wins: this.progress.wins,
      roads: map.roads.map((r) => ({
        points: r.points,
        loop: r.loop,
        elevated: r.elevated,
        kind: r.kind,
      })),
      bounds: { minX: MAP_MIN_X, maxX: MAP_MAX_X, minZ: MAP_MIN_Z, maxZ: MAP_MAX_Z },
      player: { x: player?.pos.x ?? 0, z: player?.pos.z ?? 0 },
    };
  }

  /** Free roam: puts the car down at a spawn, or just before an event facing it, as new. */
  private fastTravel(id: string): void {
    const map = cityMap();
    let spot: { x: number; z: number; yaw: number; y?: number; name: string } | null = null;
    const spawn = SPAWN_NAMES.find(([key]) => `spawn-${key}` === id);
    if (spawn) {
      const s = map.spawns[spawn[0]];
      spot = { x: s.x, z: s.z, yaw: s.yaw, y: s.y, name: spawn[1] };
    } else {
      const e = festivalEvents(map).find((ev) => ev.id === id);
      if (e)
        spot = { x: e.x - e.tx * 45, z: e.z - e.tz * 45, yaw: e.yaw, y: e.y + 0.5, name: e.name };
    }
    if (!spot) return;
    this.festival?.abandon();
    this.raceCard.hide();
    this.sim.command({ kind: 'place', car: 0, x: spot.x, z: spot.z, yaw: spot.yaw, y: spot.y });
    this.sim.command({ kind: 'repair', car: 0 });
    this.cars[0]?.repairView();
    this.camera.reset();
    this.toasts.show(`Fast travel: ${spot.name}`, { timeout: 3 });
    this.resume();
  }

  /** The camera while driving: the setting, unless the orbit debug view was asked for. */
  private get drivingCamera(): CameraMode {
    return this.orbitView ? 'orbit' : this.settings.camera;
  }

  private resetCar(): void {
    this.rumble.stop(this.input.activePad);
    this.sim.command({ kind: 'resetCar', car: 0 });
    // Free roam: the quick repair comes with the reset (and a race under way is off).
    if (this.session?.mode === 'roam') {
      this.festival?.abandon();
      this.raceCard.hide();
      this.sim.command({ kind: 'repair', car: 0 });
      this.cars[0]?.repairView();
      this.toasts.show('Repaired and reset.', { timeout: 2 });
    }
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
      debug.rearSlip = Math.max(
        Math.abs(state.wheels[2]?.slipAngle ?? 0),
        Math.abs(state.wheels[3]?.slipAngle ?? 0),
      );
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
