import { signal } from '@preact/signals';
import type { Settings } from '../../app/settings';
import type { Conditions, Weather } from '../../content/conditions';
import type { Difficulty, GameMode, SpawnPoint } from '../../shared/protocol';
import type { PromptFamily } from './prompts';

/**
 * Menu state shared by the screens: the screen stack, the session being set up, and what the
 * menus show about the rest of the game. Screens change settings in place and call `changed()`;
 * the game applies and saves them.
 */

export type ScreenId =
  | 'title'
  | 'main'
  | 'trackSelect'
  | 'carSelect'
  | 'livery'
  | 'championship'
  | 'standings'
  | 'raceSetup'
  | 'freeSetup'
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
  opponents: number;
  laps: number;
  difficulty: Difficulty;
  /** 0 = pole … opponents = last. */
  gridSlot: number;
  time: Conditions['time'];
  weather: Weather;
}

export interface ResultRow {
  position: number;
  name: string;
  player: boolean;
  bestLap: number;
  /** Race time, or NaN if the car didn't finish. */
  time: number;
  gap: number;
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
}

/** What the menus can ask the game to do. */
export interface MenuActions {
  startSession(setup: SessionSetup): void;
  restartSession(): void;
  resume(): void;
  resetCar(): void;
  /** Leave driving for the main menu. */
  quitToMenu(): void;
  /** A setting changed: apply it and save. */
  settingsChanged(): void;
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
  /** Watches the race just finished (from the results). */
  watchReplay(): void;
  /** Opens photo mode (from the pause menu or a replay). */
  photoMode(): void;
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
    opponents: 7,
    laps: 3,
    difficulty: 'medium',
    gridSlot: 4,
    time: 'track',
    weather: 'clear',
  });
  /** True while a session is running (the pause menu is over the game). */
  readonly inSession = signal(false);
  readonly results = signal<SessionResults | null>(null);
  readonly championship = signal<Championship | null>(null);
  /** A replay of the session just finished can be watched. */
  readonly replayAvailable = signal(false);
  readonly replay = signal<ReplayInfo | null>(null);
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
