import { useEffect, useRef, useState } from 'preact/hooks';
import { VERSION_TEXT } from '../../app/version';
import { PAINTS } from '../../content/paints';
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
import type { AidLevel, SpawnPoint } from '../../shared/protocol';
import { Track } from '../../sim/track/Track';
import { CARS, CAR_CLASSES, carById } from '../../sim/vehicle/cars';
import { NAV_TAB } from './focus';
import { PROMPT_LABELS, type PromptSetting } from './prompts';
import type { Difficulty, MenuStore } from './store';
import { Button, Choice, Note, Section, Slider, Tabs, Toggle, percent } from './widgets';

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

export function TitleScreen({ store }: ScreenProps) {
  return (
    <div class="mn-title-screen" onClick={() => store.set(['main'])}>
      <div class="logo big">
        APEX <span>GRAND PRIX</span>
      </div>
      <p class="mn-press">Press any button</p>
      <Button label="Start" onPress={() => store.set(['main'])} autofocus primary />
      <p class="mn-version">{VERSION_TEXT}</p>
    </div>
  );
}

export function MainScreen({ store }: ScreenProps) {
  const go = (mode: 'race' | 'timeTrial') => {
    store.update({ mode, trackId: store.setup.value.trackId || TRACKS[0]?.id || '' });
    store.push('trackSelect');
  };
  return (
    <div class="mn-panel mn-main">
      <div class="logo">
        APEX <span>GRAND PRIX</span>
      </div>
      <nav class="mn-list">
        <Button
          label="Quick Race"
          hint="Race the AI on a circuit"
          onPress={() => go('race')}
          autofocus
          primary
        />
        <Button
          label="Championship"
          hint={
            store.championship.value &&
            store.championship.value.round < store.championship.value.tracks.length
              ? `Round ${store.championship.value.round + 1} of ${store.championship.value.tracks.length}`
              : 'A season of races for points'
          }
          onPress={() => {
            store.update({ mode: 'race' });
            store.push('championship');
          }}
        />
        <Button label="Time Trial" hint="Chase the perfect lap" onPress={() => go('timeTrial')} />
        <Button
          label="Free Drive"
          hint="Proving ground: loop, drag strip, skidpad"
          onPress={() => {
            store.update({ mode: 'free' });
            store.push('freeSetup');
          }}
        />
        <Button label="Settings" onPress={() => store.push('settings')} />
        <Button label="Controls" onPress={() => store.push('controls')} />
        <Button label="Controller tester" onPress={() => store.push('tester')} />
        <Button label="About" onPress={() => store.push('about')} />
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

export function CarSelectScreen({ store }: ScreenProps) {
  const setup = store.setup.value;
  const root = useRef<HTMLDivElement>(null);
  const [cls, setCls] = useState(carById(setup.carId).className);
  useTabKeys(root, CAR_CLASSES, setCls);
  const pick = (carId: string) => {
    store.update({ carId });
    if (setup.mode === 'race') store.push('raceSetup');
    else store.actions.startSession({ ...store.setup.value, carId });
  };
  const cars = CARS.filter((c) => c.className === cls);
  const focusId = cars.some((c) => c.id === setup.carId) ? setup.carId : cars[0]?.id;
  return (
    <div class="mn-panel mn-wide" ref={root}>
      <Header title="Choose your car" subtitle="Every car in the race is the one you pick" />
      <Tabs tabs={CAR_CLASSES.map((c) => ({ id: c, label: c }))} active={cls} onSelect={setCls} />
      <PaintChoice store={store} />
      <div class="mn-cards" key={cls}>
        {cars.map((c) => (
          <button
            type="button"
            class={c.id === setup.carId ? 'mn-card selected' : 'mn-card'}
            data-nav="button"
            data-autofocus={c.id === focusId ? '' : undefined}
            onClick={() => pick(c.id)}
          >
            <span class="mn-card-sub">{c.className}</span>
            <span class="mn-card-title">{c.name}</span>
            <span class="mn-card-meta">
              {c.stats.power} · {c.stats.weight} · {c.stats.topSpeed}
            </span>
            <span class="mn-card-text">{c.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The player's paint colour, with a swatch. */
function PaintChoice({ store }: ScreenProps) {
  const s = store.settings;
  return (
    <div class="mn-paint">
      <span class="mn-swatch" style={{ background: `#${s.paint.toString(16).padStart(6, '0')}` }} />
      <Choice
        label="Paint"
        value={s.paint}
        options={PAINTS.map((p) => ({ value: p.hex, text: p.name }))}
        onChange={(v) => ((s.paint = v), store.changed())}
        wrap
      />
    </div>
  );
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
        <Choice
          label="Laps per race"
          value={setup.laps}
          options={[2, 3, 4, 5, 8].map((n) => ({ value: n, text: String(n) }))}
          onChange={(laps) => store.update({ laps })}
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

export function StandingsScreen({ store }: ScreenProps) {
  const champ = store.championship.value;
  if (!champ) return null;
  const done = champ.round >= champ.tracks.length;
  const order = champ.points
    .map((points, car) => ({ car, points }))
    .sort((a, b) => b.points - a.points || a.car - b.car);
  const next = done ? undefined : TRACKS.find((t) => t.id === champ.tracks[champ.round]);
  const playerPos = order.findIndex((o) => o.car === 0) + 1;
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
  return (
    <div class="mn-panel">
      <Header title="Race setup" subtitle={track ? `${track.name} · ${track.location}` : ''} />
      <div class="mn-list">
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
          label="Difficulty"
          value={setup.difficulty}
          options={DIFFICULTY}
          onChange={(difficulty) => store.update({ difficulty })}
        />
        <Choice
          label="Start position"
          value={setup.gridSlot}
          options={Array.from({ length: setup.opponents + 1 }, (_, i) => ({
            value: i,
            text: i === 0 ? 'Pole' : `P${i + 1}`,
          }))}
          onChange={(gridSlot) => store.update({ gridSlot })}
        />
        <AidChoices store={store} aids={aids} />
        <Button
          label="Start race"
          primary
          autofocus
          onPress={() => store.actions.startSession(store.setup.value)}
        />
      </div>
    </div>
  );
}

function AidChoices({ store, aids }: { store: MenuStore; aids: MenuStore['settings']['aids'] }) {
  return (
    <>
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
        title={results.mode === 'race' ? 'Race results' : 'Session results'}
        subtitle={results.trackName}
      />
      {results.mode === 'timeTrial' ? (
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
              <th>Best lap</th>
              <th>Time</th>
            </tr>
          </thead>
          <tbody>
            {results.rows.map((r, i) => (
              <tr class={r.player ? 'player' : ''} style={{ animationDelay: `${i * 60}ms` }}>
                <td>{r.position}</td>
                <td>{r.name}</td>
                <td>{formatTime(r.bestLap)}</td>
                <td>
                  {!Number.isFinite(r.time)
                    ? 'DNF'
                    : i === 0
                      ? formatTime(r.time)
                      : `+${r.gap.toFixed(3)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {results.championship ? (
        <div class="mn-row-buttons">
          <Button
            label="Continue"
            hint="Championship standings"
            onPress={() => store.set(['standings'])}
            autofocus
            primary
          />
        </div>
      ) : (
        <div class="mn-row-buttons">
          <Button
            label={results.mode === 'race' ? 'Race again' : 'Go again'}
            onPress={() => store.actions.restartSession()}
            autofocus
            primary
          />
          <Button label="Choose track" onPress={() => store.set(['main', 'trackSelect'])} />
          <Button label="Main menu" onPress={() => store.actions.quitToMenu()} />
        </div>
      )}
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
            <Toggle
              label="Performance overlay"
              value={s.overlay}
              onChange={(v) => ((s.overlay = v), changed())}
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
