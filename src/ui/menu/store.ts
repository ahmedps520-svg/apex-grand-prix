import { signal } from '@preact/signals';
import type { DriftMedal, DriftTargets } from '../../content/driftTrial';
import type { RoamSpot } from '../../app/records';
import type { GraphicsPreset, Settings } from '../../app/settings';
import type { Conditions, DayLength, Weather, WeatherMotion } from '../../content/conditions';
import type { LadderStanding } from '../../content/ladder';
import type {
  Difficulty,
  GameMode,
  HandlingMode,
  RoamStart,
  SpawnPoint,
} from '../../shared/protocol';
import type { PromptFamily } from './prompts';

/**
 * Menu state shared by the screens: the screen stack, the session being set up, and what the
 * menus show about the rest of the game. Screens change settings in place and call `changed()`;
 * the game applies and saves them.
 */

export type ScreenId =
  | 'title'
  | 'career'
  | 'main'
  | 'trackSelect'
  | 'carSelect'
  | 'livery'
  | 'schoolOffer'
  | 'championship'
  | 'standings'
  | 'raceSetup'
  | 'freeSetup'
  | 'roamSetup'
  | 'map'
  | 'board'
  | 'pause'
  | 'results'
  | 'replay'
  | 'settings'
  | 'bindPad'
  | 'bindKeys'
  | 'tester'
  | 'controls'
  | 'about';

export type { Difficulty, GameMode };

/** What to drive: set up in the menus, started by the game. */
export interface SessionSetup {
  mode: GameMode;
  /** Race and time trial. */
  trackId: string;
  carId: string;
  /** Free drive on the proving ground. */
  location: SpawnPoint;
  /** Free roam: where in the open world to start. */
  roamStart: RoamStart;
  opponents: number;
  laps: number;
  difficulty: Difficulty;
  /** 0 = pole … opponents = last. */
  gridSlot: number;
  time: Conditions['time'];
  weather: Weather;
  /** Whether, and how fast, the day's clock runs: on the circuits, and in free roam. */
  dayLength: DayLength;
  roamDayLength: DayLength;
  /** Whether the weather moves over the drive: on the circuits, and in free roam. */
  weatherMotion: WeatherMotion;
  roamWeatherMotion: WeatherMotion;
  /** Who races: everyone in the player's car, mixed cars from their class, or two classes. */
  field: FieldMode;
  /** The other class in a two-class race. */
  secondClass: string;
  /** Sim or arcade handling, for any mode. */
  handling: HandlingMode;
  /** Quick races: a standard race, or an elimination (the last car out every so often). */
  raceType: RaceType;
  /** Races and championships: whether the tyres wear, and how fast. */
  tyreWear: TyreWear;
  /** Races and championships: track limits and flags enforced. */
  rules: boolean;
  /** Races and championship rounds: laps of qualifying before the race (0: the grid is chosen). */
  qualifying: number;
  /** Time trials: against the clock, or a drift trial (arcade handling, the drifts score). */
  trial: TrialKind;
  /** Drift trial: laps. */
  driftLaps: number;
  /** The daily challenge: the day's key while the session is it ('' otherwise). */
  daily?: string;
  /** Free roam: continue from the spot the last drive was left at. */
  resume?: boolean;
}

export type FieldMode = 'same' | 'class' | 'multi';
export type RaceType = 'standard' | 'elimination';
export type TrialKind = 'time' | 'drift';
export type TyreWear = 'off' | 'normal' | 'fast';

export interface ResultRow {
  position: number;
  name: string;
  /** Car model. */
  car: string;
  player: boolean;
  bestLap: number;
  /** Race time, or NaN if the car didn't finish. */
  time: number;
  gap: number;
  /** Elimination race: put out before the end. */
  out?: boolean;
  /** Race rules: seconds of penalty added to the time. */
  penalty?: number;
}

/** A championship in progress: a fixed series of circuits with points after each race. */
export interface Championship {
  tracks: string[];
  /** Index of the next race to run (tracks.length when finished). */
  round: number;
  /** Points per car index (0 = player). */
  points: number[];
  /** Points each car scored in the latest round. */
  last: number[];
  names: string[];
  /** Car index → paint (older saves; liveries now come from `liverySeed`). */
  paints: number[];
  /** Seed for the rivals' liveries, so each keeps its look all season. */
  liverySeed?: number;
  /** Car, field size, laps and difficulty for every round. */
  setup: SessionSetup;
  /** A career season: the tier it is for. */
  career?: number;
}

/** The career as its screen shows it. */
export interface CareerInfo {
  /** The tier being raced; every tier done once it equals the count. */
  tier: number;
  complete: boolean;
  tiers: Array<{
    name: string;
    className: string;
    races: number;
    laps: number;
    opponents: number;
    difficulty: Difficulty;
    promote: number;
    status: 'done' | 'current' | 'locked';
    /** The finish of the latest season at that tier, or null. */
    position: number | null;
  }>;
  /** The tier's season under way, or null. */
  season: { round: number; races: number; position: number; next: string } | null;
}

/** Checks a stored championship before it is loaded. */
export function isChampionship(value: unknown): value is Championship {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<Championship>;
  const numbers = (a: unknown): a is number[] =>
    Array.isArray(a) && a.every((n) => typeof n === 'number' && Number.isFinite(n));
  return (
    Array.isArray(c.tracks) &&
    c.tracks.every((t) => typeof t === 'string') &&
    typeof c.round === 'number' &&
    numbers(c.points) &&
    numbers(c.last) &&
    numbers(c.paints) &&
    Array.isArray(c.names) &&
    c.names.length === c.points.length &&
    typeof c.setup === 'object' &&
    c.setup !== null
  );
}

export type ReplayCamera = 'tv' | 'chase' | 'onboard';

/** What the replay screen shows, updated by the game every frame while watching. */
export interface ReplayInfo {
  time: number;
  duration: number;
  speed: number;
  playing: boolean;
  camera: ReplayCamera;
  /** Watched car: name and position at the end of the race. */
  car: string;
}

export type ReplayCommand =
  | 'playPause'
  | 'back5'
  | 'forward5'
  | 'slower'
  | 'faster'
  | 'prevCar'
  | 'nextCar'
  | 'camera'
  | 'exit';

export interface SessionResults {
  mode: GameMode;
  trackName: string;
  rows: ResultRow[];
  /** Time trial: best lap this session and the stored record. */
  bestLap?: number;
  record?: number;
  newRecord?: boolean;
  /** A championship round: results lead on to the standings. */
  championship?: boolean;
  /** A qualifying: the rows are the grid, the times best laps, and the race follows. */
  qualifying?: boolean;
  /** A drift trial: the score, the best for the circuit and laps, and the medal. */
  drift?: DriftResult;
}

/** Today's challenge as the main menu shows it. */
export interface DailyInfo {
  key: string;
  trackName: string;
  carName: string;
  conditions: string;
  /** Today's best lap, seconds, or null. */
  best: number | null;
}

export interface DriftResult {
  score: number;
  best: number;
  newBest: boolean;
  medal: DriftMedal | null;
  targets: DriftTargets;
}

/** A place to fast-travel to: a spawn, or a festival event with its best result. */
export interface FestivalDestination {
  id: string;
  kind: 'spawn' | 'race' | 'drift' | 'camera' | 'jump' | 'getaway';
  name: string;
  best: string | null;
  /** Races and getaways: the best's medal. */
  medal: 'gold' | 'silver' | 'bronze' | null;
  x: number;
  z: number;
}

export interface FestivalInfo {
  destinations: FestivalDestination[];
  /** Events with a result, and the races' medals. */
  totals: { events: number; done: number; gold: number; silver: number; bronze: number };
  /** The festival's ladder: lifetime skill points, the level and its title, and races won. */
  ladder: LadderStanding;
  wins: number;
  roads: ReadonlyArray<{ points: number[]; loop: boolean; elevated: boolean; kind: string }>;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  player: { x: number; z: number };
}

/** What the menus can ask the game to do. */
export interface MenuActions {
  startSession(setup: SessionSetup): void;
  restartSession(): void;
  /** After a qualifying: the race, on the grid it set. */
  startRace(): void;
  /** The daily challenge: a time trial on the day's circuit, car and conditions. */
  startDaily(): void;
  resume(): void;
  /** A tap on a menu prompt (touch): the same as the key or button for it. */
  tap(event: 'back' | 'pause' | 'confirm' | 'tabNext'): void;
  resetCar(): void;
  /** Leave driving for the main menu. */
  quitToMenu(): void;
  /** A setting changed: apply it and save. */
  settingsChanged(): void;
  /** Graphics: picks a preset (its values fill the individual choices), applies and saves. */
  graphicsPreset(preset: GraphicsPreset): void;
  /** Opens the steering wheel setup (wizard or settings) for the connected wheel. */
  openWheelSetup(): void;
  testRumble(): void;
  exportSettings(): void;
  /** Returns an error message, or null when the file was loaded. */
  importSettings(file: File): Promise<string | null>;
  resetSettings(): void;
  /** Waits for a controller button or key for rebinding; null = cancelled. */
  capture(kind: 'pad' | 'key', done: (value: number | string | null) => void): void;
  cancelCapture(): void;
  /** Best lap stored for a track (time trial), or null. */
  record(trackId: string): number | null;
  /** Starts a new championship over `races` circuits with the current setup. */
  startChampionship(races: number): void;
  /** Runs the next championship race. */
  nextRound(): void;
  /** Career: a season in the current tier's series, in a car of its class. */
  startCareerSeason(carId: string): void;
  /** Career: the next round of the tier's season. */
  continueCareer(): void;
  /** Career: back to the first tier, every result forgotten. */
  resetCareer(): void;
  /** Watches the race just finished (from the results). */
  watchReplay(): void;
  /** Opens photo mode (from the pause menu or a replay). */
  photoMode(): void;
  /** Free roam: puts the car down at a spawn or an event (from the festival map). */
  fastTravel(id: string): void;
  /** Starts the driving school. */
  startSchool(): void;
  replay(command: ReplayCommand): void;
}

export interface PadSnapshot {
  index: number;
  id: string;
  mapping: string;
  axes: number[];
  buttons: Array<{ pressed: boolean; value: number }>;
  rumble: boolean;
}

export class MenuStore {
  readonly stack = signal<ScreenId[]>(['title']);
  /** Bumped whenever settings change, so screens re-render. */
  readonly revision = signal(0);
  readonly prompts = signal<PromptFamily>('keyboard');
  readonly padFamily = signal<'playstation' | 'xbox' | 'generic'>('generic');
  readonly wheelName = signal<string | null>(null);
  readonly rumbleSupported = signal(false);
  readonly setup = signal<SessionSetup>({
    mode: 'race',
    trackId: '',
    carId: 'gt',
    location: 'loop',
    roamStart: 'downtown',
    opponents: 7,
    laps: 3,
    difficulty: 'medium',
    gridSlot: 4,
    time: 'track',
    weather: 'clear',
    dayLength: 'still',
    roamDayLength: 'short',
    weatherMotion: 'fixed',
    roamWeatherMotion: 'moving',
    field: 'same',
    secondClass: 'Touring',
    handling: 'sim',
    raceType: 'standard',
    tyreWear: 'off',
    rules: true,
    qualifying: 0,
    trial: 'time',
    driftLaps: 2,
  });
  /** True while a session is running (the pause menu is over the game). */
  readonly inSession = signal(false);
  /** Free roam: the festival map's roads, destinations and the car's spot (null elsewhere). */
  readonly festival = signal<FestivalInfo | null>(null);
  /** Today's challenge, for the main menu's tile. */
  readonly daily = signal<DailyInfo | null>(null);
  /** The career's ladder and the season under way. */
  readonly career = signal<CareerInfo | null>(null);
  /** Free roam: where the last drive was left, for the Continue button (null when none). */
  readonly roamSpot = signal<RoamSpot | null>(null);
  readonly results = signal<SessionResults | null>(null);
  readonly championship = signal<Championship | null>(null);
  /** A replay of the session just finished can be watched. */
  readonly replayAvailable = signal(false);
  readonly replay = signal<ReplayInfo | null>(null);
  /** The car in focus in car select, shown in 3D behind the menu. */
  readonly previewCar = signal('');
  /** Live controller state for the tester (updated every frame while it's open). */
  readonly pads = signal<PadSnapshot[]>([]);
  /** Short status line for the current screen (e.g. an import error). */
  readonly message = signal('');

  constructor(
    readonly settings: Settings,
    readonly actions: MenuActions,
  ) {}

  get top(): ScreenId | null {
    const s = this.stack.value;
    return s[s.length - 1] ?? null;
  }

  get open(): boolean {
    return this.stack.value.length > 0;
  }

  push(id: ScreenId): void {
    this.message.value = '';
    this.stack.value = [...this.stack.value, id];
  }

  /** Goes back one screen; returns false if there was nowhere to go back to. */
  pop(): boolean {
    const s = this.stack.value;
    if (s.length <= 1) return false;
    this.message.value = '';
    this.stack.value = s.slice(0, -1);
    return true;
  }

  /** Replaces the whole stack (e.g. [] to close the menus, ['main'] after quitting). */
  set(ids: ScreenId[]): void {
    this.message.value = '';
    this.stack.value = ids;
  }

  update(patch: Partial<SessionSetup>): void {
    this.setup.value = { ...this.setup.value, ...patch };
  }

  changed(): void {
    this.revision.value++;
    this.actions.settingsChanged();
  }
}
