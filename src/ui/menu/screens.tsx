import { useEffect, useRef, useState } from 'preact/hooks';
import { VERSION_TEXT } from '../../app/version';
import {
  DAY_LENGTHS,
  TIMES_OF_DAY,
  WEATHERS,
  WEATHER_MOTIONS,
  clockText,
} from '../../content/conditions';
import { LIVERY_PATTERNS, colourName } from '../../content/livery';
import { TRACKS } from '../../content/tracks';
import {
  KEY_ACTIONS,
  PAD_ACTIONS,
  defaultBindings,
  keyName,
  padButtonName,
  rebindKey,
  rebindPad,
  type KeyAction,
  type PadAction,
} from '../../input/bindings';
import { RUMBLE_CHANNELS } from '../../input/rumble';
import type { Detail, EffectsSetting, Palette } from '../../app/settings';
import type { AidLevel, HandlingMode, RoamStart, SpawnPoint } from '../../shared/protocol';
import { Track } from '../../sim/track/Track';
import { CARS, CAR_CLASSES, carById, peakPower, topSpeed } from '../../sim/vehicle/cars';
import { NAV_TAB } from './focus';
import { PROMPT_LABELS, type PromptSetting } from './prompts';
import { CAREER_TIERS } from '../../content/career';
import type {
  CareerInfo,
  DailyInfo,
  Difficulty,
  DriftResult,
  FestivalDestination,
  MenuStore,
  RaceType,
  ReplayCommand,
  TrialKind,
  Championship,
  TyreWear,
} from './store';
import {
  Button,
  Choice,
  Note,
  Section,
  Slider,
  StatBar,
  Tabs,
  Tile,
  Toggle,
  percent,
} from './widgets';

interface ScreenProps {
  store: MenuStore;
}

const AIDS: ReadonlyArray<{ value: AidLevel; text: string }> = [
  { value: 'off', text: 'Off' },
  { value: 'low', text: 'Low' },
  { value: 'high', text: 'High' },
];
const GEARBOX = [
  { value: 'auto', text: 'Automatic' },
  { value: 'manual', text: 'Manual (paddles)' },
] as const;
const CURVES = [
  { value: 'linear', text: 'Linear' },
  { value: 'progressive', text: 'Progressive' },
  { value: 'aggressive', text: 'Aggressive' },
] as const;
const DIFFICULTY: ReadonlyArray<{ value: Difficulty; text: string }> = [
  { value: 'easy', text: 'Easy' },
  { value: 'medium', text: 'Medium' },
  { value: 'hard', text: 'Hard' },
  { value: 'expert', text: 'Expert' },
];
const UNITS = [
  { value: 'metric', text: 'km/h' },
  { value: 'imperial', text: 'mph' },
] as const;
const CAMERAS = [
  { value: 'chase', text: 'Chase' },
  { value: 'chase-far', text: 'Chase far' },
  { value: 'bonnet', text: 'Bonnet' },
] as const;
const SMOOTHING = [
  { value: 'low', text: 'Low' },
  { value: 'medium', text: 'Medium' },
  { value: 'high', text: 'High' },
] as const;
const DAMAGE = [
  { value: 'off', text: 'Off' },
  { value: 'light', text: 'Light' },
  { value: 'full', text: 'Full' },
] as const;
const TOUCH_STEERING = [
  { value: 'drag', text: 'Drag' },
  { value: 'tilt', text: 'Tilt the device' },
] as const;
const LOCATIONS: ReadonlyArray<{ value: SpawnPoint; text: string }> = [
  { value: 'loop', text: 'Handling loop' },
  { value: 'drag', text: 'Drag strip' },
  { value: 'skidpad', text: 'Skidpad' },
];

/** Track lengths and corner counts for the track cards (computed once). */
const TRACK_INFO = new Map<string, { km: number; corners: number }>();
function trackInfo(id: string): { km: number; corners: number } {
  let info = TRACK_INFO.get(id);
  if (!info) {
    const def = TRACKS.find((t) => t.id === id);
    if (!def) return { km: 0, corners: 0 };
    const track = new Track(def);
    let corners = 0;
    let inCorner = false;
    for (const s of track.samples) {
      const tight = Math.abs(s.curvature) > 1 / 150;
      if (tight && !inCorner) corners++;
      inCorner = tight;
    }
    info = { km: track.length / 1000, corners };
    TRACK_INFO.set(id, info);
  }
  return info;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function Header(props: { title: string; subtitle?: string }) {
  return (
    <header class="mn-header">
      <h1 class="mn-title">{props.title}</h1>
      {props.subtitle && <p class="mn-subtitle">{props.subtitle}</p>}
    </header>
  );
}

// ------------------------------------------------------------------ title & main

/** Drifting points of light over the title screen (pure CSS animation). */
function Particles({ count = 26 }: { count?: number }) {
  return (
    <div class="mn-particles" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => {
        const r = (n: number) => (Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1;
        const a = Math.abs(r(1));
        const b = Math.abs(r(2));
        const c = Math.abs(r(3));
        return (
          <span
            style={{
              left: `${a * 100}%`,
              animationDelay: `${-b * 14}s`,
              animationDuration: `${9 + c * 9}s`,
              width: `${2 + c * 3}px`,
              height: `${2 + c * 3}px`,
            }}
          />
        );
      })}
    </div>
  );
}

export function TitleScreen({ store }: ScreenProps) {
  return (
    <div class="mn-title-screen" onClick={() => store.set(['main'])}>
      <Particles />
      <div class="logo big">
        APEX <span>GRAND PRIX</span>
      </div>
      <p class="mn-press">Press any button</p>
      <div class="mn-title-start">
        <Button label="Start" onPress={() => store.set(['main'])} autofocus primary />
      </div>
    </div>
  );
}

export function MainScreen({ store }: ScreenProps) {
  const go = (mode: 'race' | 'timeTrial', trial: TrialKind = 'time') => {
    store.update({
      mode,
      trial,
      daily: '',
      trackId: store.setup.value.trackId || TRACKS[0]?.id || '',
    });
    store.push('trackSelect');
  };
  const season = store.championship.value;
  const daily = store.daily.value;
  const inSeason = season !== null && season.round < season.tracks.length;
  return (
    <div class="mn-panel mn-main">
      <div class="logo">
        APEX <span>GRAND PRIX</span>
      </div>
      <nav class="mn-tiles">
        <Tile
          icon="race"
          label="Race"
          hint="Quick race against the AI"
          size="big"
          onPress={() => go('race')}
          autofocus
        />
        <Tile
          icon="trophy"
          label="Championship"
          hint={
            inSeason
              ? `Round ${season.round + 1} of ${season.tracks.length}`
              : 'A season for points'
          }
          onPress={() => {
            store.update({ mode: 'race' });
            store.push('championship');
          }}
        />
        <Tile
          icon="stopwatch"
          label="Time Trial"
          hint="Beat your ghost"
          onPress={() => go('timeTrial')}
        />
        <Tile
          icon="drift"
          label="Drift Trial"
          hint="Slide for points"
          onPress={() => go('timeTrial', 'drift')}
        />
        <Tile
          icon="city"
          label="Free Roam"
          hint="The open world"
          onPress={() => {
            store.update({ mode: 'roam' });
            store.push('roamSetup');
          }}
        />
        <Tile
          icon="brush"
          label="Garage"
          hint="Paint and livery"
          onPress={() => store.push('livery')}
        />
        <Tile
          icon="school"
          label="School"
          hint={store.settings.schoolDone ? 'Graduated · drive it again' : 'Learn to race'}
          onPress={() => store.actions.startSchool()}
        />
        {daily && (
          <Tile
            icon="calendar"
            label="Daily Challenge"
            hint={dailyHint(daily)}
            size="wide"
            onPress={() => store.actions.startDaily()}
          />
        )}
      </nav>
      <nav class="mn-tiles small">
        <Tile icon="gear" label="Settings" size="small" onPress={() => store.push('settings')} />
        <Tile icon="pad" label="Controls" size="small" onPress={() => store.push('controls')} />
        <Tile icon="pulse" label="Tester" size="small" onPress={() => store.push('tester')} />
        <Tile icon="info" label="About" size="small" onPress={() => store.push('about')} />
      </nav>
    </div>
  );
}

/** The daily tile's line: the circuit, the car, the conditions and today's best. */
function dailyHint(daily: DailyInfo): string {
  const best = daily.best ? ` · best ${formatTime(daily.best)}` : '';
  return `${daily.trackName} · ${daily.carName} · ${daily.conditions}${best}`;
}

/** First visit: offer the driving school (it can always be found on the main menu). */
export function SchoolOfferScreen({ store }: ScreenProps) {
  const skip = () => {
    store.settings.schoolOffered = true;
    store.changed();
    store.set(['main']);
  };
  return (
    <div class="mn-panel mn-offer">
      <div class="logo">
        APEX <span>GRAND PRIX</span>
      </div>
      <p class="mn-offer-title">New here?</p>
      <nav class="mn-tiles">
        <Tile
          icon="school"
          label="Driving School"
          hint="Seven quick lessons"
          size="big"
          autofocus
          onPress={() => {
            store.settings.schoolOffered = true;
            store.changed();
            store.actions.startSchool();
          }}
        />
        <Tile icon="race" label="Skip" hint="Straight to the menu" onPress={skip} />
      </nav>
    </div>
  );
}

// ------------------------------------------------------------------ session setup

export function TrackSelectScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const pick = (trackId: string) => {
    store.update({ trackId, laps: TRACKS.find((t) => t.id === trackId)?.laps ?? 3 });
    store.push('carSelect');
  };
  return (
    <div class="mn-panel mn-wide">
      <Header
        title={setup.mode === 'race' ? 'Quick Race' : 'Time Trial'}
        subtitle="Choose a circuit"
      />
      <div class="mn-cards">
        {TRACKS.map((t) => {
          const info = trackInfo(t.id);
          const record = store.actions.record(t.id);
          return (
            <button
              type="button"
              class={t.id === setup.trackId ? 'mn-card selected' : 'mn-card'}
              data-nav="button"
              data-autofocus={t.id === setup.trackId ? '' : undefined}
              onClick={() => pick(t.id)}
            >
              <TrackOutline trackId={t.id} />
              <span class="mn-card-title">{t.name}</span>
              <span class="mn-card-sub">{t.location}</span>
              <span class="mn-card-meta">
                {info.km.toFixed(2)} km · {info.corners} corners
                {record ? ` · best ${formatTime(record)}` : ''}
              </span>
              <span class="mn-card-text">{t.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** L1 / R1 (or Q / E) switch tabs on the screen that contains `ref`. */
function useTabKeys<T>(
  ref: { current: HTMLElement | null },
  ids: readonly T[],
  set: (update: (current: T) => T) => void,
): void {
  useEffect(() => {
    const el = ref.current?.closest('.menu-screen');
    if (!el) return;
    const onTab = (e: Event) => {
      const delta = (e as CustomEvent<number>).detail;
      set((current) => ids[(ids.indexOf(current) + delta + ids.length) % ids.length]!);
    };
    el.addEventListener(NAV_TAB, onTab);
    return () => el.removeEventListener(NAV_TAB, onTab);
  }, []);
}

/** Car stats scaled 0…1 across the whole roster, for the bars. */
const CAR_STATS = (() => {
  const raw = CARS.map((c) => {
    const s = c.spec;
    const grip =
      ((s.front.tyre.muY + s.rear.tyre.muY) / 2) * (1 + (s.aero.downforceArea / s.mass) * 40);
    return {
      id: c.id,
      power: peakPower(s),
      speed: topSpeed(s),
      accel: peakPower(s) / s.mass,
      grip,
    };
  });
  const max = (k: 'power' | 'speed' | 'accel' | 'grip') => Math.max(...raw.map((r) => r[k]));
  const min = (k: 'power' | 'speed' | 'accel' | 'grip') => Math.min(...raw.map((r) => r[k]));
  const scale = (v: number, k: 'power' | 'speed' | 'accel' | 'grip') =>
    0.15 + (0.85 * (v - min(k))) / Math.max(max(k) - min(k), 1e-6);
  return new Map(
    raw.map((r) => [
      r.id,
      {
        power: scale(r.power, 'power'),
        speed: scale(r.speed, 'speed'),
        accel: scale(r.accel, 'accel'),
        grip: scale(r.grip, 'grip'),
      },
    ]),
  );
})();

export function CarSelectScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const root = useRef<HTMLDivElement>(null);
  const [cls, setCls] = useState(carById(setup.carId).className);
  useTabKeys(root, CAR_CLASSES, setCls);
  const pick = (carId: string) => {
    store.update({ carId });
    store.push('raceSetup');
  };
  const cars = CARS.filter((c) => c.className === cls);
  const focusId = cars.some((c) => c.id === setup.carId) ? setup.carId : cars[0]?.id;
  const focused = carById(store.previewCar.value || focusId || setup.carId);
  const stats = CAR_STATS.get(focused.id);
  return (
    <div class="mn-panel mn-cars" ref={root}>
      <Tabs tabs={CAR_CLASSES.map((c) => ({ id: c, label: c }))} active={cls} onSelect={setCls} />
      <div class="mn-car-list" key={cls}>
        {cars.map((c) => (
          <button
            type="button"
            class={c.id === setup.carId ? 'mn-car-row selected' : 'mn-car-row'}
            data-nav="button"
            data-autofocus={c.id === focusId ? '' : undefined}
            onFocus={() => (store.previewCar.value = c.id)}
            onClick={() => pick(c.id)}
          >
            <span class="mn-car-name">{c.name}</span>
            <span class="mn-car-power">{c.stats.power}</span>
          </button>
        ))}
      </div>
      <div class="mn-car-info">
        <div class="mn-car-class">{focused.className}</div>
        <div class="mn-car-title">{focused.name}</div>
        {stats && (
          <div class="mn-stats">
            <StatBar label="Power" value={stats.power} />
            <StatBar label="Accel" value={stats.accel} />
            <StatBar label="Top speed" value={stats.speed} />
            <StatBar label="Grip" value={stats.grip} />
          </div>
        )}
        <div class="mn-car-meta">
          {focused.stats.power} · {focused.stats.weight} · {focused.stats.topSpeed}
        </div>
        <p class="mn-car-text">{focused.description}</p>
        <Button
          label="Paint & livery"
          hint={liveryHint(store)}
          onPress={() => store.push('livery')}
        />
      </div>
    </div>
  );
}

/** A short description of the player's livery for the car select screen. */
function liveryHint(store: MenuStore): string {
  const l = store.settings.livery;
  const pattern = LIVERY_PATTERNS.find((p) => p.value === l.pattern)?.text ?? '';
  return `${colourName(l.primary) ?? 'Custom'} · ${pattern} · #${l.number}`;
}

const SEASON_LENGTHS = [3, 4, 6, 8];

export function ChampionshipScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const current = store.championship.value;
  const [races, setRaces] = useState(Math.min(4, TRACKS.length));
  const running = current !== null && current.round < current.tracks.length;
  const next = running ? TRACKS.find((t) => t.id === current.tracks[current.round]) : undefined;
  const lengths = SEASON_LENGTHS.filter((n) => n < TRACKS.length);
  return (
    <div class="mn-panel">
      <Header title="Championship" subtitle="A season of races: points for the top ten" />
      <div class="mn-list">
        <Button
          label="Career"
          hint={careerHint(store.career.value)}
          onPress={() => store.push('career')}
        />
        {running && (
          <>
            <Button
              label="Continue season"
              hint={`Round ${current.round + 1} of ${current.tracks.length}${next ? ` · ${next.name}` : ''}`}
              onPress={() => store.actions.nextRound()}
              autofocus
              primary
            />
            <Button label="Standings" onPress={() => store.push('standings')} />
          </>
        )}
        <Choice
          label="Races"
          value={races}
          options={[
            ...lengths.map((n) => ({ value: n, text: String(n) })),
            { value: TRACKS.length, text: `${TRACKS.length} (every circuit)` },
          ]}
          onChange={setRaces}
        />
        <Choice
          label="Car"
          value={setup.carId}
          options={CARS.map((c) => ({ value: c.id, text: `${c.name} (${c.className})` }))}
          onChange={(carId) => store.update({ carId })}
          wrap
        />
        <Choice
          label="Opponents"
          value={setup.opponents}
          options={[3, 5, 7, 9, 11].map((n) => ({ value: n, text: String(n) }))}
          onChange={(opponents) =>
            store.update({ opponents, gridSlot: Math.min(setup.gridSlot, opponents) })
          }
        />
        <FieldChoices store={store} />
        <Choice
          label="Laps per race"
          value={setup.laps}
          options={[2, 3, 4, 5, 8].map((n) => ({ value: n, text: String(n) }))}
          onChange={(laps) => store.update({ laps })}
        />
        <Choice
          label="Tyre wear"
          value={setup.tyreWear ?? 'off'}
          options={TYRE_WEAR}
          onChange={(tyreWear) => store.update({ tyreWear })}
        />
        <Choice
          label="Race rules"
          value={setup.rules !== false}
          options={RULES}
          onChange={(rules) => store.update({ rules })}
        />
        <Choice
          label="Difficulty"
          value={setup.difficulty}
          options={DIFFICULTY}
          onChange={(difficulty) => store.update({ difficulty })}
        />
        <AidChoices store={store} aids={store.settings.aids} />
        <Button
          label={running ? 'Start a new season' : 'Start season'}
          primary={!running}
          autofocus={!running}
          onPress={() => store.actions.startChampionship(races)}
        />
      </div>
    </div>
  );
}

/** The career button's line on the championship screen. */
function careerHint(info: CareerInfo | null): string {
  if (!info) return 'Six series, from street cars to formula cars';
  if (info.complete) return 'Champion of every series';
  const tier = info.tiers[info.tier];
  if (!tier) return '';
  return info.season
    ? `${tier.name} · Round ${info.season.round + 1} of ${info.season.races}`
    : `${tier.name} next`;
}

/** The career's word on a season's standings: what the finish means for moving up. */
function careerLine(champ: Championship, done: boolean, position: number): string | null {
  if (champ.career === undefined) return null;
  const tier = CAREER_TIERS[champ.career];
  if (!tier) return null;
  const next = CAREER_TIERS[champ.career + 1];
  if (!done) return `${tier.name}: finish P${tier.promote} or better to move up.`;
  if (position <= tier.promote) {
    return next ? `Promoted to the ${next.name}!` : 'Every series won: the career is complete.';
  }
  return `P${tier.promote} or better was needed to move up: the ${tier.name} can be run again.`;
}

/** The career: the ladder of series, the season under way, and the car for the next one. */
export function CareerScreen({ store }: ScreenProps) {
  const info = store.career.value;
  const tier = info ? CAREER_TIERS[info.tier] : undefined;
  const cars = tier ? CARS.filter((c) => c.className === tier.className) : [];
  const [carId, setCarId] = useState(() => {
    const chosen = store.setup.value.carId;
    return cars.some((c) => c.id === chosen) ? chosen : (cars[0]?.id ?? '');
  });
  if (!info) return null;
  return (
    <div class="mn-panel mn-wide mn-career">
      <Header
        title="Career"
        subtitle={
          info.complete
            ? 'Champion of every series'
            : tier
              ? `${tier.name} · ${tier.className} cars`
              : ''
        }
      />
      <div class="mn-list">
        {info.season ? (
          <>
            <Button
              label="Continue season"
              hint={`Round ${info.season.round + 1} of ${info.season.races} · ${info.season.next}${info.season.round > 0 ? ` · P${info.season.position} so far` : ''}`}
              onPress={() => store.actions.continueCareer()}
              autofocus
              primary
            />
            <Button label="Standings" onPress={() => store.push('standings')} />
          </>
        ) : (
          tier && (
            <>
              <Choice
                label="Car"
                value={carId}
                options={cars.map((c) => ({ value: c.id, text: c.name }))}
                onChange={setCarId}
                wrap
              />
              <Button
                label={`Start the ${tier.name}`}
                hint={`${tier.races} races · ${tier.laps} laps each · ${tier.opponents} rivals · ${tier.difficulty} · finish P${tier.promote} or better to move up`}
                onPress={() => store.actions.startCareerSeason(carId)}
                autofocus
                primary
              />
            </>
          )
        )}
      </div>
      <div class="mn-career-ladder">
        {info.tiers.map((t, i) => (
          <div class={`mn-career-tier ${t.status}`} key={i}>
            <span class="mn-career-step">{i + 1}</span>
            <span class="mn-career-name">{t.name}</span>
            <span class="mn-dim">
              {t.className} · {t.races} races · {t.difficulty}
            </span>
            <span class="mn-career-state">
              {t.status === 'done'
                ? `P${t.position}`
                : t.status === 'current'
                  ? t.position
                    ? `P${t.position} last time`
                    : 'Now'
                  : `Top ${t.promote} above`}
            </span>
          </div>
        ))}
      </div>
      <div class="mn-row-buttons">
        <Button label="Restart career" onPress={() => store.actions.resetCareer()} />
      </div>
    </div>
  );
}

export function StandingsScreen({ store }: ScreenProps) {
  const champ = store.championship.value;
  if (!champ) return null;
  const done = champ.round >= champ.tracks.length;
  const order = champ.points
    .map((points, car) => ({ car, points }))
    .sort((a, b) => b.points - a.points || a.car - b.car);
  const next = done ? undefined : TRACKS.find((t) => t.id === champ.tracks[champ.round]);
  const playerPos = order.findIndex((o) => o.car === 0) + 1;
  const career = careerLine(champ, done, playerPos);
  return (
    <div class="mn-panel mn-wide mn-results">
      <Header
        title={done ? 'Season complete' : 'Championship standings'}
        subtitle={
          done
            ? playerPos === 1
              ? 'You are the champion!'
              : `You finished the season P${playerPos}`
            : `After round ${champ.round} of ${champ.tracks.length}`
        }
      />
      {career && <p class="mn-note">{career}</p>}
      <table class="mn-table">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Driver</th>
            <th>Last race</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {order.map(({ car, points }, i) => (
            <tr class={car === 0 ? 'player' : ''} style={{ animationDelay: `${i * 60}ms` }}>
              <td>{i + 1}</td>
              <td>{champ.names[car] ?? `Driver ${car}`}</td>
              <td>{champ.last[car] ? `+${champ.last[car]}` : '—'}</td>
              <td>
                <strong>{points}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="mn-row-buttons">
        {next && (
          <Button
            label={`Next: ${next.name}`}
            onPress={() => store.actions.nextRound()}
            autofocus
            primary
          />
        )}
        <Button
          label="Main menu"
          onPress={() => store.actions.quitToMenu()}
          autofocus={!next}
          primary={!next}
        />
      </div>
    </div>
  );
}

/** A small drawing of the circuit's shape. */
function TrackOutline({ trackId }: { trackId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const def = TRACKS.find((t) => t.id === trackId);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !def || !ctx) return;
    const track = new Track(def);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of track.samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    const w = canvas.width;
    const h = canvas.height;
    const scale = Math.min((w - 16) / (maxX - minX), (h - 16) / (maxZ - minZ));
    const ox = (w - (maxX - minX) * scale) / 2;
    const oz = (h - (maxZ - minZ) * scale) / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    track.samples.forEach((p, i) => {
      const x = ox + (p.x - minX) * scale;
      const y = oz + (p.z - minZ) * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.stroke();
    const start = track.samples[0]!;
    ctx.fillStyle = '#ff3b2f';
    ctx.beginPath();
    ctx.arc(ox + (start.x - minX) * scale, oz + (start.z - minZ) * scale, 5, 0, Math.PI * 2);
    ctx.fill();
  }, [trackId]);
  return <canvas ref={ref} class="mn-outline" width={220} height={130} />;
}

export function RaceSetupScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const aids = store.settings.aids;
  const track = TRACKS.find((t) => t.id === setup.trackId);
  const race = setup.mode === 'race';
  const drift = !race && setup.trial === 'drift';
  return (
    <div class="mn-panel">
      <Header
        title={race ? 'Race setup' : drift ? 'Drift trial setup' : 'Time trial setup'}
        subtitle={track ? `${track.name} · ${track.location}` : ''}
      />
      <div class="mn-list">
        {race && (
          <>
            <Choice
              label="Opponents"
              value={setup.opponents}
              options={[1, 3, 5, 7, 9, 11].map((n) => ({ value: n, text: String(n) }))}
              onChange={(opponents) =>
                store.update({ opponents, gridSlot: Math.min(setup.gridSlot, opponents) })
              }
            />
            <Choice
              label="Laps"
              value={setup.laps}
              options={[1, 2, 3, 4, 5, 6, 8, 10, 15].map((n) => ({ value: n, text: String(n) }))}
              onChange={(laps) => store.update({ laps })}
            />
            <Choice
              label="Race type"
              value={setup.raceType}
              options={RACE_TYPES}
              onChange={(raceType) => store.update({ raceType })}
            />
            <Choice
              label="Difficulty"
              value={setup.difficulty}
              options={DIFFICULTY}
              onChange={(difficulty) => store.update({ difficulty })}
            />
            <Choice
              label="Tyre wear"
              value={setup.tyreWear ?? 'off'}
              options={TYRE_WEAR}
              onChange={(tyreWear) => store.update({ tyreWear })}
            />
            <Choice
              label="Race rules"
              value={setup.rules !== false}
              options={RULES}
              onChange={(rules) => store.update({ rules })}
            />
            <Choice
              label="Qualifying"
              value={setup.qualifying ?? 0}
              options={QUALIFYING}
              onChange={(qualifying) => store.update({ qualifying })}
            />
            {!(setup.qualifying > 0) && (
              <Choice
                label="Start position"
                value={setup.gridSlot}
                options={Array.from({ length: setup.opponents + 1 }, (_, i) => ({
                  value: i,
                  text: i === 0 ? 'Pole' : `P${i + 1}`,
                }))}
                onChange={(gridSlot) => store.update({ gridSlot })}
              />
            )}
            <FieldChoices store={store} />
          </>
        )}
        {drift && (
          <Choice
            label="Laps"
            value={setup.driftLaps ?? 2}
            options={[1, 2, 3].map((n) => ({ value: n, text: String(n) }))}
            onChange={(driftLaps) => store.update({ driftLaps })}
          />
        )}
        <ConditionChoices store={store} />
        <AidChoices store={store} aids={aids} drift={drift} />
        <Button
          label={race ? (setup.qualifying > 0 ? 'Start qualifying' : 'Start race') : 'Start'}
          primary
          autofocus
          onPress={() => store.actions.startSession(store.setup.value)}
        />
      </div>
    </div>
  );
}

const FIELDS = [
  { value: 'same', text: 'Same car' },
  { value: 'class', text: 'Mixed cars, one class' },
  { value: 'multi', text: 'Two classes' },
] as const;

/** Who the player races against: their own car, their class, or two classes. */
function FieldChoices({ store }: ScreenProps) {
  const setup = store.setup.value;
  const own = carById(setup.carId).className;
  const others = CAR_CLASSES.filter((c) => c !== own).map((c) => ({ value: c, text: c }));
  return (
    <>
      <Choice
        label="Field"
        value={setup.field}
        options={FIELDS}
        onChange={(field) => store.update({ field })}
      />
      {setup.field === 'multi' && (
        <Choice
          label="Second class"
          value={setup.secondClass === own ? (others[0]?.value ?? '') : setup.secondClass}
          options={others}
          onChange={(secondClass) => store.update({ secondClass })}
          wrap
        />
      )}
    </>
  );
}

/** Time of day, weather and the day's clock (free roam keeps its own choice of clock). */
function ConditionChoices({ store, roam = false }: ScreenProps & { roam?: boolean }) {
  const setup = store.setup.value;
  return (
    <>
      <Choice
        label="Time of day"
        value={setup.time}
        options={TIMES_OF_DAY}
        onChange={(time) => store.update({ time })}
      />
      <Choice
        label="Weather"
        value={setup.weather}
        options={WEATHERS}
        onChange={(weather) => store.update({ weather })}
      />
      <Choice
        label="Changing weather"
        value={roam ? setup.roamWeatherMotion : setup.weatherMotion}
        options={WEATHER_MOTIONS}
        onChange={(v) => store.update(roam ? { roamWeatherMotion: v } : { weatherMotion: v })}
      />
      <Choice
        label="The day"
        value={roam ? setup.roamDayLength : setup.dayLength}
        options={DAY_LENGTHS}
        onChange={(v) => store.update(roam ? { roamDayLength: v } : { dayLength: v })}
      />
    </>
  );
}

/** Post-processing: by the detail level, or as chosen. */
const EFFECTS: ReadonlyArray<{ value: EffectsSetting; text: string }> = [
  { value: 'auto', text: 'By detail level' },
  { value: 'off', text: 'Off' },
  { value: 'bloom', text: 'Bloom' },
  { value: 'full', text: 'Bloom and ambient occlusion' },
];

/** The HUD's colours: as designed, or safe for eyes that can't tell red from green. */
const PALETTES: ReadonlyArray<{ value: Palette; text: string }> = [
  { value: 'standard', text: 'Standard' },
  { value: 'colourSafe', text: 'Colour-safe: blue and orange' },
];

/** Race rules: track limits (warnings, then penalties), flags and the safety car. */
const RULES: ReadonlyArray<{ value: boolean; text: string }> = [
  { value: true, text: 'Track limits, flags and safety car' },
  { value: false, text: 'Off' },
];

/** Whether the tyres wear over a race, and how fast. */
const TYRE_WEAR: ReadonlyArray<{ value: TyreWear; text: string }> = [
  { value: 'off', text: 'Off' },
  { value: 'normal', text: 'Normal: a few per cent a lap' },
  { value: 'fast', text: 'Fast' },
];

/** Laps of qualifying before a race: the best lap sets the grid. */
const QUALIFYING: ReadonlyArray<{ value: number; text: string }> = [
  { value: 0, text: 'None' },
  { value: 1, text: '1 lap' },
  { value: 2, text: '2 laps' },
  { value: 3, text: '3 laps' },
];

const RACE_TYPES: ReadonlyArray<{ value: RaceType; text: string }> = [
  { value: 'standard', text: 'Standard' },
  { value: 'elimination', text: 'Elimination: last place out every 20 s' },
];

const HANDLING: ReadonlyArray<{ value: HandlingMode; text: string }> = [
  { value: 'sim', text: 'Sim' },
  { value: 'arcade', text: 'Arcade: grip, drifts, nitro, skill points' },
];

function AidChoices({
  store,
  aids,
  drift = false,
}: {
  store: MenuStore;
  aids: MenuStore['settings']['aids'];
  /** A drift trial: arcade handling, no choice about it. */
  drift?: boolean;
}) {
  return (
    <>
      {drift ? (
        <p class="mn-note">Arcade handling: the drifts score, chained for a multiplier.</p>
      ) : (
        <Choice
          label="Handling"
          value={store.setup.value.handling}
          options={HANDLING}
          onChange={(handling) => store.update({ handling })}
        />
      )}
      <Choice
        label="Gearbox"
        value={aids.gearbox}
        options={GEARBOX}
        onChange={(v) => ((aids.gearbox = v), store.changed())}
      />
      <Choice
        label="Traction control"
        value={aids.tc}
        options={AIDS}
        onChange={(v) => ((aids.tc = v), store.changed())}
      />
      <Choice
        label="ABS"
        value={aids.abs}
        options={AIDS}
        onChange={(v) => ((aids.abs = v), store.changed())}
      />
    </>
  );
}

export function FreeSetupScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  return (
    <div class="mn-panel">
      <Header title="Free Drive" subtitle="The proving ground: no timing, no traffic" />
      <div class="mn-list">
        <Choice
          label="Start at"
          value={setup.location}
          options={LOCATIONS}
          onChange={(location) => store.update({ location })}
        />
        <Choice
          label="Car"
          value={setup.carId}
          options={CARS.map((c) => ({ value: c.id, text: `${c.name} (${c.className})` }))}
          onChange={(carId) => store.update({ carId })}
          wrap
        />
        <AidChoices store={store} aids={store.settings.aids} />
        <Button
          label="Drive"
          primary
          autofocus
          onPress={() => store.actions.startSession({ ...store.setup.value, mode: 'free' })}
        />
      </div>
    </div>
  );
}

const DETAIL_OPTIONS: ReadonlyArray<{ value: Detail; text: string }> = [
  { value: 'auto', text: 'Auto' },
  { value: 'low', text: 'Low' },
  { value: 'medium', text: 'Medium' },
  { value: 'high', text: 'High' },
];

const ROAM_STARTS: ReadonlyArray<{ value: RoamStart; text: string }> = [
  { value: 'downtown', text: 'Downtown' },
  { value: 'highway', text: 'Orbital highway' },
  { value: 'suburbs', text: 'Suburbs' },
  { value: 'port', text: 'Port' },
  { value: 'mountain', text: 'Ridge Road' },
  { value: 'circuit', text: 'Circuit' },
];

const DESTINATION_COLOUR: Record<FestivalDestination['kind'], string> = {
  spawn: '#f2f4f8',
  race: '#ff3b2f',
  drift: '#37d4ff',
  camera: '#ffd166',
  jump: '#ff8a5b',
  getaway: '#c77dff',
};
const DESTINATION_LABEL: Record<FestivalDestination['kind'], string> = {
  spawn: 'Start',
  race: 'Race',
  drift: 'Drift zone',
  camera: 'Speed trap',
  jump: 'Jump',
  getaway: 'Getaway',
};

/** Free roam: the festival map (roads, events, the car) and the places to fast-travel to. */
export function MapScreen({ store }: ScreenProps) {
  const info = store.festival.value;
  if (!info) {
    return (
      <div class="mn-panel">
        <Header title="Festival map" subtitle="Only in free roam" />
      </div>
    );
  }
  const { bounds, roads, destinations, player, totals, ladder, wins } = info;
  const medals = [
    totals.gold ? `${totals.gold} gold` : '',
    totals.silver ? `${totals.silver} silver` : '',
    totals.bronze ? `${totals.bronze} bronze` : '',
  ].filter((m) => m);
  const standing = `Level ${ladder.level} ${ladder.title} · ${ladder.points.toLocaleString('en-US')} pts${wins ? ` · ${wins} ${wins === 1 ? 'win' : 'wins'}` : ''}`;
  const progress = `${standing} · ${totals.done} of ${totals.events} events done${medals.length ? ` · ${medals.join(' · ')}` : ''}`;
  const w = bounds.maxX - bounds.minX;
  const h = bounds.maxZ - bounds.minZ;
  const points = (road: (typeof roads)[number]) => {
    const pts: string[] = [];
    for (let i = 0; i < road.points.length; i += 2)
      pts.push(`${road.points[i]},${road.points[i + 1]}`);
    if (road.loop && road.points.length >= 2) pts.push(`${road.points[0]},${road.points[1]}`);
    return pts.join(' ');
  };
  return (
    <div class="mn-panel mn-wide mn-map">
      <Header title="Festival map" subtitle={`${progress} · pick a place to fast-travel to`} />
      <div class="mn-map-body">
        <svg
          class="mn-map-svg"
          viewBox={`${bounds.minX} ${bounds.minZ} ${w} ${h}`}
          preserveAspectRatio="xMidYMid meet"
        >
          {roads.map((road, i) => (
            <polyline
              key={i}
              points={points(road)}
              fill="none"
              stroke={road.elevated ? '#ffd678' : road.kind === 'avenue' ? '#e6e9ef' : '#8f98a8'}
              strokeWidth={road.elevated ? 14 : road.kind === 'avenue' ? 12 : 7}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {destinations.map((d) => (
            <circle
              key={d.id}
              cx={d.x}
              cy={d.z}
              r={d.kind === 'spawn' ? 18 : 22}
              fill={DESTINATION_COLOUR[d.kind]}
              stroke="#000"
              strokeWidth={4}
            />
          ))}
          <circle cx={player.x} cy={player.z} r={26} fill="#ff3b2f" stroke="#fff" strokeWidth={6} />
        </svg>
        <div class="mn-list mn-map-list">
          {destinations.map((d) => (
            <Button
              key={d.id}
              label={`${DESTINATION_LABEL[d.kind]}: ${d.name}${d.best ? ` · best ${d.best}` : ''}`}
              onPress={() => store.actions.fastTravel(d.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RoamSetupScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const spot = store.roamSpot.value;
  const spotCar = spot ? CARS.find((c) => c.id === spot.carId) : undefined;
  const spotTime = !spot
    ? ''
    : spot.hour !== undefined
      ? clockText(spot.hour)
      : spot.time !== 'track'
        ? TIMES_OF_DAY.find((t) => t.value === spot.time)?.text
        : '';
  const spotLabel = [spotCar?.name, spotTime].filter((s) => s).join(', ');
  return (
    <div class="mn-panel">
      <Header title="Free Roam" subtitle="The open world: city, orbital, port, ridge and circuit" />
      <div class="mn-list">
        <Choice
          label="Start"
          value={setup.roamStart}
          options={ROAM_STARTS}
          onChange={(roamStart) => store.update({ roamStart })}
          wrap
        />
        <Choice
          label="Car"
          value={setup.carId}
          options={CARS.map((c) => ({ value: c.id, text: `${c.name} (${c.className})` }))}
          onChange={(carId) => store.update({ carId })}
          wrap
        />
        <ConditionChoices store={store} roam />
        <AidChoices store={store} aids={store.settings.aids} />
        <Button
          label="Drive"
          primary
          autofocus
          onPress={() => store.actions.startSession({ ...store.setup.value, mode: 'roam' })}
        />
        {spot && (
          <Button
            label={`Continue where you left off${spotLabel ? ` · ${spotLabel}` : ''}`}
            onPress={() =>
              store.actions.startSession({ ...store.setup.value, mode: 'roam', resume: true })
            }
          />
        )}
        <Button label="Festival board" onPress={() => store.push('board')} />
        <Button label="Proving ground" onPress={() => store.push('freeSetup')} />
      </div>
    </div>
  );
}

const BOARD_GROUPS: ReadonlyArray<[FestivalDestination['kind'], string]> = [
  ['race', 'Races'],
  ['getaway', 'Getaways'],
  ['drift', 'Drift zones'],
  ['camera', 'Speed traps'],
  ['jump', 'Jumps'],
];

/** The festival board: the ladder, the totals, and every event's best and medal. */
export function BoardScreen({ store }: ScreenProps) {
  const info = store.festival.value;
  if (!info) {
    return (
      <div class="mn-panel">
        <Header title="Festival board" subtitle="Nothing yet" />
      </div>
    );
  }
  const { totals, ladder, wins, destinations } = info;
  const inRoam = store.inSession.value && store.setup.value.mode === 'roam';
  const next =
    ladder.toNext === null
      ? 'The top of the ladder'
      : `${ladder.toNext.toLocaleString('en-US')} pts to level ${ladder.level + 1}`;
  const medals = `${totals.gold} gold · ${totals.silver} silver · ${totals.bronze} bronze`;
  return (
    <div class="mn-panel mn-wide mn-board">
      <Header
        title="Festival board"
        subtitle={`Level ${ladder.level} ${ladder.title} · ${ladder.points.toLocaleString('en-US')} pts · ${wins} ${wins === 1 ? 'win' : 'wins'}`}
      />
      <div class="mn-board-ladder">
        <div class="mn-board-bar">
          <span style={{ width: `${Math.round(ladder.share * 100)}%` }} />
        </div>
        <div class="mn-board-next">{next}</div>
      </div>
      <div class="mn-board-totals">
        {totals.done} of {totals.events} events done · {medals}
      </div>
      <div class="mn-board-groups">
        {BOARD_GROUPS.map(([kind, title]) => {
          const rows = destinations.filter((d) => d.kind === kind);
          if (rows.length === 0) return null;
          return (
            <section class="mn-board-group" key={kind}>
              <h3>{title}</h3>
              <div class="mn-list">
                {rows.map((d) => {
                  const result = d.best ?? '—';
                  const medal = d.medal ? ` · ${d.medal}` : '';
                  return inRoam ? (
                    <Button
                      key={d.id}
                      label={d.name}
                      hint={`${result}${medal}`}
                      onPress={() => store.actions.fastTravel(d.id)}
                    />
                  ) : (
                    <div class={`mn-board-row${d.medal ? ` ${d.medal}` : ''}`} key={d.id}>
                      <span>{d.name}</span>
                      <span class="mn-dim">{`${result}${medal}`}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
      {inRoam && <p class="mn-board-hint">Pick an event to fast-travel to it.</p>}
    </div>
  );
}

// ------------------------------------------------------------------ pause & results

export function PauseScreen({ store }: ScreenProps) {
  const mode = store.setup.value.mode;
  return (
    <div class="mn-panel mn-pause">
      <Header title="Paused" />
      <div class="mn-list">
        <Button label="Resume" onPress={() => store.actions.resume()} autofocus primary />
        {mode !== 'free' && (
          <Button
            label={mode === 'race' ? 'Restart race' : 'Restart session'}
            onPress={() => store.actions.restartSession()}
          />
        )}
        <Button label="Reset car" onPress={() => store.actions.resetCar()} />
        <Button label="Photo mode" onPress={() => store.actions.photoMode()} />
        {mode === 'roam' && <Button label="Festival map" onPress={() => store.push('map')} />}
        {mode === 'roam' && <Button label="Festival board" onPress={() => store.push('board')} />}
        <Button label="Settings" onPress={() => store.push('settings')} />
        <Button label="Controls" onPress={() => store.push('controls')} />
        <Button label="Quit to main menu" onPress={() => store.actions.quitToMenu()} />
      </div>
    </div>
  );
}

export function ResultsScreen({ store }: ScreenProps) {
  const results = store.results.value;
  if (!results) return null;
  return (
    <div class="mn-panel mn-wide mn-results">
      <Header
        title={
          results.drift
            ? 'Drift trial'
            : results.qualifying
              ? 'Qualifying'
              : results.mode === 'race'
                ? 'Race results'
                : 'Session results'
        }
        subtitle={results.trackName}
      />
      {results.drift ? (
        <DriftResultCard drift={results.drift} />
      ) : results.mode === 'timeTrial' ? (
        <div class="mn-record">
          <div>
            Best lap <strong>{formatTime(results.bestLap ?? 0)}</strong>
          </div>
          <div>
            Track record <strong>{formatTime(results.record ?? 0)}</strong>
            {results.newRecord && <span class="mn-badge">New record!</span>}
          </div>
        </div>
      ) : (
        <table class="mn-table">
          <thead>
            <tr>
              <th>Pos</th>
              <th>Driver</th>
              <th>Car</th>
              <th>Best lap</th>
              <th>{results.qualifying ? 'Gap' : 'Time'}</th>
            </tr>
          </thead>
          <tbody>
            {results.rows.map((r, i) => (
              <tr class={r.player ? 'player' : ''} style={{ animationDelay: `${i * 60}ms` }}>
                <td>{r.position}</td>
                <td>{r.name}</td>
                <td class="mn-dim">{r.car}</td>
                <td>{formatTime(r.bestLap)}</td>
                <td>
                  {r.out
                    ? 'OUT'
                    : !Number.isFinite(r.time)
                      ? '—'
                      : i === 0
                        ? results.qualifying
                          ? 'Pole'
                          : formatTime(r.time)
                        : `+${r.gap.toFixed(3)}`}
                  {r.penalty ? <span class="mn-dim"> · {r.penalty} s pen.</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {results.qualifying ? (
        <div class="mn-row-buttons">
          <Button
            label="Start the race"
            hint="On this grid"
            onPress={() => store.actions.startRace()}
            autofocus
            primary
          />
          <Button label="Qualify again" onPress={() => store.actions.restartSession()} />
          {store.replayAvailable.value && (
            <Button label="Watch replay" onPress={() => store.actions.watchReplay()} />
          )}
          <Button label="Main menu" onPress={() => store.actions.quitToMenu()} />
        </div>
      ) : results.championship ? (
        <div class="mn-row-buttons">
          <Button
            label="Continue"
            hint="Championship standings"
            onPress={() => store.set(['standings'])}
            autofocus
            primary
          />
          {store.replayAvailable.value && (
            <Button label="Watch replay" onPress={() => store.actions.watchReplay()} />
          )}
        </div>
      ) : (
        <div class="mn-row-buttons">
          <Button
            label={results.mode === 'race' ? 'Race again' : 'Go again'}
            onPress={() => store.actions.restartSession()}
            autofocus
            primary
          />
          {store.replayAvailable.value && (
            <Button label="Watch replay" onPress={() => store.actions.watchReplay()} />
          )}
          <Button label="Choose track" onPress={() => store.set(['main', 'trackSelect'])} />
          <Button label="Main menu" onPress={() => store.actions.quitToMenu()} />
        </div>
      )}
    </div>
  );
}

/** A drift trial's card: the score with its medal, the best, and the targets. */
function DriftResultCard({ drift }: { drift: DriftResult }) {
  const n = (v: number) => v.toLocaleString('en-US');
  return (
    <div class="mn-record">
      <div>
        Drift score <strong>{n(drift.score)}</strong>
        {drift.medal && (
          <span class={`mn-badge mn-medal ${drift.medal}`}>{drift.medal.toUpperCase()}</span>
        )}
      </div>
      <div>
        Best <strong>{n(drift.best)}</strong>
        {drift.newBest && <span class="mn-badge">New best!</span>}
      </div>
      <div class="mn-dim">
        Gold {n(drift.targets.gold)} · Silver {n(drift.targets.silver)} · Bronze{' '}
        {n(drift.targets.bronze)}
      </div>
    </div>
  );
}

const CAMERA_NAMES = { tv: 'TV', chase: 'Chase', onboard: 'Onboard' } as const;

/** Replay controls over the 3D view: a timeline and buttons for mouse and touch. */
export function ReplayScreen({ store }: ScreenProps) {
  const info = store.replay.value;
  if (!info) return null;
  const send = (command: ReplayCommand) => () => store.actions.replay(command);
  const clock = (t: number) => {
    const m = Math.floor(t / 60);
    return `${m}:${Math.floor(t - m * 60)
      .toString()
      .padStart(2, '0')}`;
  };
  return (
    <div class="mn-replay">
      <div class="mn-replay-top">
        <span class="mn-replay-badge">REPLAY</span>
        <span class="mn-replay-car">{info.car}</span>
        <span class="mn-replay-meta">
          {CAMERA_NAMES[info.camera]} · {info.speed}×
        </span>
      </div>
      <div class="mn-replay-bar">
        <button type="button" class="mn-replay-btn" onClick={send('back5')} aria-label="Back 5 s">
          ⏪
        </button>
        <button
          type="button"
          class="mn-replay-btn"
          onClick={send('playPause')}
          aria-label={info.playing ? 'Pause' : 'Play'}
        >
          {info.playing ? '❚❚' : '▶'}
        </button>
        <button
          type="button"
          class="mn-replay-btn"
          onClick={send('forward5')}
          aria-label="Forward 5 s"
        >
          ⏩
        </button>
        <span class="mn-replay-time">{clock(info.time)}</span>
        <div class="mn-replay-track">
          <span style={{ width: `${(info.time / Math.max(info.duration, 0.001)) * 100}%` }} />
        </div>
        <span class="mn-replay-time">{clock(info.duration)}</span>
        <button
          type="button"
          class="mn-replay-btn"
          onClick={send('prevCar')}
          aria-label="Previous car"
        >
          ◀
        </button>
        <button type="button" class="mn-replay-btn" onClick={send('nextCar')} aria-label="Next car">
          ▶
        </button>
        <button type="button" class="mn-replay-btn wide" onClick={send('camera')}>
          Camera
        </button>
        <button type="button" class="mn-replay-btn wide" onClick={() => store.actions.photoMode()}>
          Photo
        </button>
        <button type="button" class="mn-replay-btn wide" onClick={send('exit')}>
          Exit
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ settings

type Tab = 'gameplay' | 'controls' | 'wheel' | 'rumble' | 'graphics' | 'audio' | 'data';
const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: 'gameplay', label: 'Gameplay' },
  { id: 'controls', label: 'Controls' },
  { id: 'wheel', label: 'Wheel' },
  { id: 'rumble', label: 'Rumble' },
  { id: 'graphics', label: 'Graphics' },
  { id: 'audio', label: 'Audio' },
  { id: 'data', label: 'Data' },
];

export function SettingsScreen({ store }: ScreenProps) {
  const [tab, setTab] = useState<Tab>('gameplay');
  const root = useRef<HTMLDivElement>(null);
  useTabKeys(
    root,
    TABS.map((t) => t.id),
    setTab,
  );
  const s = store.settings;
  const changed = () => store.changed();
  return (
    <div class="mn-panel mn-wide mn-settings" ref={root}>
      <Header title="Settings" />
      <Tabs tabs={TABS} active={tab} onSelect={setTab} />
      <div class="mn-tab-body" key={tab}>
        {tab === 'gameplay' && (
          <Section>
            <AidChoices store={store} aids={s.aids} />
            <Choice
              label="Units"
              value={s.units}
              options={UNITS}
              onChange={(v) => ((s.units = v), changed())}
            />
            <Choice
              label="Camera"
              value={s.camera}
              options={CAMERAS}
              onChange={(v) => ((s.camera = v), changed())}
            />
            <Choice
              label="Damage"
              value={s.damage}
              options={DAMAGE}
              onChange={(v) => ((s.damage = v), changed())}
            />
            <Toggle
              label="Time trial ghost"
              value={s.ghost}
              onChange={(v) => ((s.ghost = v), changed())}
            />
            <Toggle
              label="Telemetry panel"
              value={s.telemetry}
              onChange={(v) => ((s.telemetry = v), changed())}
            />
          </Section>
        )}
        {tab === 'controls' && (
          <>
            <Section title="Controller">
              <Choice
                label="Button prompts"
                value={s.prompts}
                options={(Object.keys(PROMPT_LABELS) as PromptSetting[]).map((v) => ({
                  value: v,
                  text: PROMPT_LABELS[v],
                }))}
                onChange={(v) => ((s.prompts = v), changed())}
              />
              <Slider
                label="Stick dead zone"
                value={s.pad.steerDeadzone}
                min={0}
                max={0.3}
                step={0.01}
                format={percent}
                onChange={(v) => ((s.pad.steerDeadzone = v), changed())}
              />
              <Slider
                label="Full lock at"
                value={s.pad.steerSaturation}
                min={0.8}
                max={1}
                step={0.01}
                format={percent}
                onChange={(v) => ((s.pad.steerSaturation = v), changed())}
              />
              <Slider
                label="Centre precision"
                value={s.pad.steerLinearity}
                min={0}
                max={1}
                step={0.05}
                format={percent}
                onChange={(v) => ((s.pad.steerLinearity = v), changed())}
              />
              <Slider
                label="Steering sensitivity"
                value={s.aids.steerSensitivity}
                min={0.5}
                max={1.5}
                step={0.05}
                format={percent}
                onChange={(v) => ((s.aids.steerSensitivity = v), changed())}
              />
              <Choice
                label="Steering smoothing"
                value={s.aids.steerSmoothing}
                options={SMOOTHING}
                onChange={(v) => ((s.aids.steerSmoothing = v), changed())}
              />
              <Choice
                label="Throttle curve"
                value={s.pad.throttleCurve}
                options={CURVES}
                onChange={(v) => ((s.pad.throttleCurve = v), changed())}
              />
              <Slider
                label="Throttle dead zone"
                value={s.pad.throttleDeadzone}
                min={0}
                max={0.3}
                step={0.01}
                format={percent}
                onChange={(v) => ((s.pad.throttleDeadzone = v), changed())}
              />
              <Choice
                label="Brake curve"
                value={s.pad.brakeCurve}
                options={CURVES}
                onChange={(v) => ((s.pad.brakeCurve = v), changed())}
              />
              <Slider
                label="Brake dead zone"
                value={s.pad.brakeDeadzone}
                min={0}
                max={0.3}
                step={0.01}
                format={percent}
                onChange={(v) => ((s.pad.brakeDeadzone = v), changed())}
              />
            </Section>
            <Section title="Touch screen">
              <Choice
                label="Touch steering"
                value={s.touchSteering}
                options={TOUCH_STEERING}
                onChange={(v) => ((s.touchSteering = v), changed())}
              />
            </Section>
            <Section title="Buttons">
              <Button label="Controller buttons" onPress={() => store.push('bindPad')} />
              <Button label="Keyboard keys" onPress={() => store.push('bindKeys')} />
            </Section>
          </>
        )}
        {tab === 'wheel' && (
          <Section>
            <Note>
              {store.wheelName.value
                ? `Connected: ${store.wheelName.value}`
                : 'No steering wheel found. Connect it and press one of its buttons.'}
            </Note>
            <Button
              label="Set up steering wheel"
              disabled={!store.wheelName.value}
              onPress={() => store.actions.openWheelSetup()}
            />
            <Note>
              Wheels steer 1:1 with the car. The wizard finds the steering axis, pedals and buttons;
              afterwards you can set the rotation, dead zones, pedal curves and bindings.
            </Note>
          </Section>
        )}
        {tab === 'rumble' && (
          <Section>
            {!store.rumbleSupported.value && (
              <Note>
                Rumble isn't available here: this browser or controller doesn't support it (Safari
                on iPad never does). It works with Chrome or Edge on a PC.
              </Note>
            )}
            <Toggle
              label="Rumble"
              value={s.rumble.enabled}
              onChange={(v) => ((s.rumble.enabled = v), changed())}
            />
            <Slider
              label="Strength"
              value={s.rumble.strength}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.rumble.strength = v), changed())}
            />
            {RUMBLE_CHANNELS.map(({ channel, label }) => (
              <Toggle
                label={label}
                value={s.rumble.channels[channel]}
                onChange={(v) => ((s.rumble.channels[channel] = v), changed())}
              />
            ))}
            <Button label="Test rumble" onPress={() => store.actions.testRumble()} />
          </Section>
        )}
        {tab === 'graphics' && (
          <Section>
            <Slider
              label="Resolution"
              value={s.resolutionScale}
              min={0.5}
              max={1.5}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.resolutionScale = v), changed())}
            />
            <Choice
              label="World detail"
              value={s.detail}
              options={DETAIL_OPTIONS}
              onChange={(v) => ((s.detail = v), changed())}
            />
            <Toggle
              label="Performance overlay"
              value={s.overlay}
              onChange={(v) => ((s.overlay = v), changed())}
            />
            <Slider
              label="HUD size"
              value={s.hudScale}
              min={0.8}
              max={1.4}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.hudScale = v), changed())}
            />
            <Choice
              label="Colours"
              value={s.palette}
              options={PALETTES}
              onChange={(v) => ((s.palette = v), changed())}
            />
            <Choice
              label="Effects"
              value={s.effects}
              options={EFFECTS}
              onChange={(v) => ((s.effects = v), changed())}
            />
          </Section>
        )}
        {tab === 'audio' && (
          <Section>
            <Slider
              label="Volume"
              value={s.audio.volume}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.audio.volume = v), changed())}
            />
            <Slider
              label="Music"
              value={s.audio.music}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.audio.music = v), changed())}
            />
            <Slider
              label="Menu sounds"
              value={s.audio.sfx}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.audio.sfx = v), changed())}
            />
            <Toggle
              label="Mute"
              value={s.audio.muted}
              onChange={(v) => ((s.audio.muted = v), changed())}
            />
            <Toggle
              label="Race engineer voice"
              value={s.radio.voice}
              onChange={(v) => ((s.radio.voice = v), changed())}
            />
            <Slider
              label="Race engineer volume"
              value={s.radio.volume}
              min={0}
              max={1}
              step={0.05}
              format={percent}
              onChange={(v) => ((s.radio.volume = v), changed())}
            />
            <Toggle
              label="Radio subtitles"
              value={s.radio.subtitles}
              onChange={(v) => ((s.radio.subtitles = v), changed())}
            />
          </Section>
        )}
        {tab === 'data' && <DataTab store={store} />}
      </div>
    </div>
  );
}

function DataTab({ store }: ScreenProps) {
  const file = useRef<HTMLInputElement>(null);
  const [confirm, setConfirm] = useState(false);
  return (
    <Section>
      <Note>Settings, wheel profiles and records are saved in this browser automatically.</Note>
      <Button label="Export settings to a file" onPress={() => store.actions.exportSettings()} />
      <Button label="Import settings from a file" onPress={() => file.current?.click()} />
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={async (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (!f) return;
          const error = await store.actions.importSettings(f);
          store.message.value = error ?? 'Settings imported.';
        }}
      />
      <Button
        label={confirm ? 'Press again to reset everything' : 'Reset to defaults'}
        onPress={() => {
          if (!confirm) return setConfirm(true);
          setConfirm(false);
          store.actions.resetSettings();
          store.message.value = 'Settings reset to defaults.';
        }}
      />
    </Section>
  );
}

/** Rebinding: pick an action, then press the new button or key. */
function BindScreen({ store, kind }: ScreenProps & { kind: 'pad' | 'key' }) {
  const [waiting, setWaiting] = useState<string | null>(null);
  const bindings = store.settings.bindings;
  const family = store.padFamily.value;
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => store.actions.cancelCapture(), 6000);
    return () => clearTimeout(timer);
  }, [waiting]);
  const start = (action: string) => {
    setWaiting(action);
    store.actions.capture(kind, (value) => {
      setWaiting(null);
      if (value === null) return;
      if (kind === 'pad' && typeof value === 'number') {
        store.settings.bindings = rebindPad(store.settings.bindings, action as PadAction, value);
      } else if (typeof value === 'string') {
        store.settings.bindings = rebindKey(store.settings.bindings, action as KeyAction, value);
      }
      store.changed();
    });
  };
  const rows =
    kind === 'pad'
      ? PAD_ACTIONS.map(({ action, label }) => ({
          action,
          label,
          value: padButtonName(bindings.pad[action], family),
        }))
      : KEY_ACTIONS.map(({ action, label }) => ({
          action,
          label,
          value: bindings.keys[action].map(keyName).join(' / ') || '—',
        }));
  return (
    <div class="mn-panel">
      <Header
        title={kind === 'pad' ? 'Controller buttons' : 'Keyboard keys'}
        subtitle="Choose an action, then press the new button or key"
      />
      <div class="mn-list">
        {rows.map((r, i) => (
          <Button
            label={r.label}
            hint={r.value}
            onPress={() => start(r.action)}
            autofocus={i === 0}
          />
        ))}
        <Button
          label="Restore defaults"
          onPress={() => {
            const d = defaultBindings();
            store.settings.bindings =
              kind === 'pad' ? { ...bindings, pad: d.pad } : { ...bindings, keys: d.keys };
            store.changed();
          }}
        />
      </div>
      {waiting && (
        <div class="mn-modal" data-modal>
          <div class="mn-modal-card">
            <p>
              Press the {kind === 'pad' ? 'controller button' : 'key'} for{' '}
              <strong>{rows.find((r) => r.action === waiting)?.label}</strong>
            </p>
            <p class="mn-note">Waits 6 seconds{kind === 'key' ? ' · Esc cancels' : ''}</p>
          </div>
        </div>
      )}
    </div>
  );
}

export const BindPadScreen = ({ store }: ScreenProps) => <BindScreen store={store} kind="pad" />;
export const BindKeysScreen = ({ store }: ScreenProps) => <BindScreen store={store} kind="key" />;

// ------------------------------------------------------------------ info screens

export function TesterScreen({ store }: ScreenProps) {
  const pads = store.pads.value;
  return (
    <div class="mn-panel mn-wide">
      <Header
        title="Controller tester"
        subtitle="Hold ○ / B for a second (or press Esc) to go back"
      />
      {pads.length === 0 && (
        <Note>No controllers found. Press a button on one so the browser can see it.</Note>
      )}
      {pads.map((p) => (
        <Section title={`${p.index}: ${p.id}`}>
          <div class="mn-tester">
            <div class="mn-axes">
              {p.axes.map((v, i) => (
                <div class="mn-axis">
                  <span>Axis {i}</span>
                  <div class="mn-axis-bar">
                    <span style={{ left: `${50 + Math.min(Math.max(v, -1), 1) * 50}%` }} />
                  </div>
                  <span>{v.toFixed(2)}</span>
                </div>
              ))}
            </div>
            <div class="mn-buttons-grid">
              {p.buttons.map((b, i) => (
                <span class={b.pressed ? 'on' : ''} style={{ opacity: 0.35 + b.value * 0.65 }}>
                  {i}
                </span>
              ))}
            </div>
          </div>
          <Note>
            Mapping: {p.mapping || 'non-standard'} · Rumble: {p.rumble ? 'yes' : 'not supported'}
          </Note>
        </Section>
      ))}
      <div class="mn-row-buttons">
        <Button label="Test rumble" onPress={() => store.actions.testRumble()} />
        <Button label="Back" onPress={() => store.pop()} autofocus />
      </div>
    </div>
  );
}

export function ControlsScreen({ store }: ScreenProps) {
  const b = store.settings.bindings;
  const family = store.padFamily.value;
  const pad = (a: PadAction) => padButtonName(b.pad[a], family);
  const keys = (a: KeyAction) => b.keys[a].map(keyName).join(' / ');
  const rows: Array<[string, string, string]> = [
    [
      'Throttle / brake',
      `${keys('throttle')} · ${keys('brake')}`,
      family === 'playstation' ? 'R2 · L2' : 'RT · LT',
    ],
    ['Steer', `${keys('steerLeft')} · ${keys('steerRight')}`, 'Left stick'],
    [
      'Shift up / down',
      `${keys('shiftUp')} · ${keys('shiftDown')}`,
      `${pad('shiftUp')} · ${pad('shiftDown')}`,
    ],
    ['Handbrake', keys('handbrake'), pad('handbrake')],
    ['Camera', keys('camera'), pad('camera')],
    ['Reset car', keys('reset'), pad('reset')],
    ['Pause', keys('pause'), pad('pause')],
    ['Quick menu', 'Tab, then [ ]', 'D-pad'],
    ['Telemetry', keys('telemetry'), `${pad('telemetry')} · L3+R3`],
    ['Performance overlay', keys('overlay'), pad('overlay')],
    ['Steering wheel setup', 'K', '—'],
  ];
  return (
    <div class="mn-panel mn-wide">
      <Header title="Controls" subtitle="Change them in Settings → Controls" />
      <table class="mn-table mn-controls">
        <thead>
          <tr>
            <th />
            <th>Keyboard</th>
            <th>Controller</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([action, key, button]) => (
            <tr>
              <td>{action}</td>
              <td>{key}</td>
              <td>{button}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div class="mn-row-buttons">
        <Button label="Back" onPress={() => store.pop()} autofocus />
      </div>
    </div>
  );
}

export function AboutScreen({ store }: ScreenProps) {
  return (
    <div class="mn-panel">
      <Header title="About" subtitle={VERSION_TEXT} />
      <Note>
        APEX GRAND PRIX is a browser racing game with a 400 Hz physics simulation, built with
        TypeScript, three.js and Preact. Every car, team, driver and circuit is fictional.
      </Note>
      <Note>
        Installable as an app: on iPad use Share → Add to Home Screen; it then works offline.
      </Note>
      <div class="mn-row-buttons">
        <Button label="Back" onPress={() => store.pop()} autofocus />
      </div>
    </div>
  );
}
