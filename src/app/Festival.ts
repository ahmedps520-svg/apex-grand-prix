import { MEDALS, type EventKind, type FestivalEvent } from '../content/city/events';
import { racerName } from '../content/drivers';
import type { CarRenderState } from '../render/interpolate';
import type { PoliceStatus, RoamRaceStatus } from '../shared/protocol';

/**
 * The festival's rules, on the main thread from the render states: speed cameras register a
 * crossing, drift zones tally a drift while you are in them, jumps measure the flight from the
 * ramp's lip, and races run you through their checkpoints against rivals and the clock, with
 * medals. The simulation forms a race's grid, counts down, drives the rivals and keeps the
 * time and the positions (its status comes in with each update); this keeps the checkpoints,
 * the abandonment, the notices and the records. Best results go to `save`.
 */

export type Medal = 'gold' | 'silver' | 'bronze' | null;

export interface FestivalNotice {
  event: FestivalEvent;
  text: string;
  /** A finished race's medal, when it is one, the finishing position and the field. */
  medal?: Medal;
  position?: number;
  results?: Standing[];
  /** A new best. */
  best: boolean;
}

/** A car's place in a race: its time once home, else its gap to the player in metres. */
export interface Standing {
  position: number;
  name: string;
  you: boolean;
  gap: string;
}

/** What the HUD shows: the event under way, or the nearest one to head for. */
export interface FestivalView {
  active: {
    kind: EventKind;
    name: string;
    line: string;
    detail: string;
    /** A race's countdown is showing, or the sweep over the grid before it. */
    countdown?: boolean;
    intro?: boolean;
    /** A race's field in order. */
    standings?: Standing[];
  } | null;
  hint: { kind: EventKind; name: string; distance: number } | null;
}

/** Records by event id: a race's time (s), a zone's points, a trap's km/h, a jump's metres. */
export type FestivalRecords = Record<string, number>;

type Active =
  | {
      kind: 'race';
      event: FestivalEvent;
      next: number;
      time: number;
      idle: number;
      position: number;
      count: number;
      countdown: number;
      intro: boolean;
    }
  | { kind: 'drift'; event: FestivalEvent; points: number; out: number }
  | { kind: 'getaway'; event: FestivalEvent; time: number; chased: boolean }
  | {
      kind: 'jump';
      event: FestivalEvent;
      lipX: number;
      lipZ: number;
      air: number;
      flying: boolean;
    };

/** Drift zones: the rear slip that counts, and how far past its ends the zone reaches. */
const DRIFT_SLIP = 0.12;
const ZONE_MARGIN = 6;
/** A race is abandoned this far from its next checkpoint, or after this long stopped. */
const RACE_LOST = 400;
const RACE_IDLE = 20;
const HINT_RANGE = 500;

export class Festival {
  readonly notices: FestivalNotice[] = [];
  readonly view: FestivalView = { active: null, hint: null };
  private active: Active | null = null;
  private readonly prevAlong = new Map<string, number>();
  private prevX = 0;
  private prevZ = 0;
  private started = false;
  /** A race the sim still reports after this finished or abandoned it (until it is reset). */
  private ignoreId = '';
  private race: RoamRaceStatus | null = null;

  constructor(
    readonly events: readonly FestivalEvent[],
    readonly records: FestivalRecords,
    private readonly save: (id: string, value: number) => void = () => undefined,
    /** Tells the simulation the race under way is off (its rivals stand down). */
    private readonly endRace: () => void = () => undefined,
    /** A getaway's line crossed: the police come at this many stars. */
    private readonly startPursuit: (heat: number) => void = () => undefined,
  ) {}

  /** Whether a lower result is better for an event (races), or a higher one. */
  static lowerIsBetter(kind: EventKind): boolean {
    return kind === 'race' || kind === 'getaway';
  }

  /** Reads an event's best result as text. */
  static format(kind: EventKind, value: number): string {
    switch (kind) {
      case 'race':
      case 'getaway':
        return formatTime(value);
      case 'drift':
        return `${Math.round(value).toLocaleString('en-US')} pts`;
      case 'camera':
        return `${Math.round(value)} km/h`;
      case 'jump':
        return `${value.toFixed(1)} m`;
    }
  }

  /** Forgets the event under way (a reset or a fast travel). */
  abandon(): void {
    if (this.active?.kind === 'race') {
      this.ignoreId = this.active.event.id;
      this.notice(this.active.event, 'Race abandoned.', false);
      this.endRace();
    }
    this.active = null;
    this.started = false;
    this.prevAlong.clear();
  }

  update(
    dt: number,
    player: CarRenderState,
    race: RoamRaceStatus | null = null,
    police: PoliceStatus | null = null,
  ): void {
    const x = player.pos.x;
    const z = player.pos.z;
    if (!this.started) {
      this.started = true;
      this.prevX = x;
      this.prevZ = z;
    }
    const speed = Math.abs(player.speed);
    this.race = race;
    // A race starts in the simulation (the grid, the countdown): follow it.
    if (!race || race.phase === 'grid' || race.phase === 'countdown') this.ignoreId = '';
    if (
      race &&
      (race.phase === 'countdown' || race.phase === 'racing') &&
      race.finished < 0 &&
      race.id !== this.ignoreId
    ) {
      const a = this.active;
      if (a?.kind !== 'race' || a.event.id !== race.id) {
        const event = this.events.find((e) => e.id === race.id);
        if (event) {
          this.active = {
            kind: 'race',
            event,
            next: 1,
            time: 0,
            idle: 0,
            position: race.position,
            count: race.count,
            countdown: race.countdown,
            intro: race.intro,
          };
        }
      }
    }
    const active = this.active;
    if (active) this.updateActive(active, dt, player, race, police);
    // Lines: the cameras register a crossing.
    for (const event of this.events) {
      if (event.kind === 'camera' && this.crossed(event, x, z, player.pos.y)) {
        const kmh = speed * 3.6;
        const best = this.record(event, kmh);
        this.notice(event, `Speed trap · ${event.name}: ${Math.round(kmh)} km/h`, best);
      }
      // A getaway starts on its line: the police come at its stars.
      if (event.kind === 'getaway' && this.crossed(event, x, z, player.pos.y) && !this.active) {
        this.active = { kind: 'getaway', event, time: 0, chased: false };
        this.startPursuit(event.heat ?? 3);
      }
    }
    // Drift zones and jumps start by being there.
    if (!this.active) {
      for (const event of this.events) {
        if (event.kind === 'drift' && event.zone && this.inZone(event, x, z)) {
          this.active = { kind: 'drift', event, points: 0, out: 0 };
          break;
        }
        if (event.kind === 'jump' && event.ramp && this.onRamp(event, x, z) !== null) {
          const lipX = event.x + event.tx * event.ramp.length;
          const lipZ = event.z + event.tz * event.ramp.length;
          this.active = { kind: 'jump', event, lipX, lipZ, air: 0, flying: false };
          break;
        }
      }
    }
    this.prevX = x;
    this.prevZ = z;
    this.updateView(x, z);
  }

  /** The checkpoint to head for in the race under way (for the marker), or null. */
  nextCheckpoint(): { x: number; z: number; y: number; radius: number } | null {
    const a = this.active;
    return a?.kind === 'race' ? (a.event.checkpoints[a.next] ?? null) : null;
  }

  /** The best results, for the map screen. */
  best(event: FestivalEvent): string | null {
    const value = this.records[event.id];
    return value === undefined ? null : Festival.format(event.kind, value);
  }

  private updateActive(
    a: Active,
    dt: number,
    player: CarRenderState,
    race: RoamRaceStatus | null,
    police: PoliceStatus | null,
  ): void {
    const x = player.pos.x;
    const z = player.pos.z;
    const speed = Math.abs(player.speed);
    if (a.kind === 'race') {
      // The simulation dropped it (a reset, a fast travel): so does this.
      if (!race || race.id !== a.event.id || race.phase === 'grid') {
        this.active = null;
        return;
      }
      a.position = race.position;
      a.count = race.count;
      a.countdown = race.phase === 'countdown' ? race.countdown : 0;
      a.intro = race.phase === 'countdown' && race.intro;
      a.time = race.time;
      if (race.phase === 'countdown') return;
      if (race.finished >= 0) {
        // Over the line: the time and the position come from the simulation.
        this.active = null;
        this.ignoreId = race.id;
        const time = race.finished;
        const best = this.record(a.event, time);
        const medal = medalFor(a.event, time);
        this.notice(
          a.event,
          `${a.event.name}: P${race.position} of ${race.count} · ${formatTime(time)}${medal ? ` · ${medal.toUpperCase()}` : ''}`,
          best,
          medal,
          race.position,
          this.standings(),
        );
        return;
      }
      const cp = a.event.checkpoints[a.next]!;
      const d = Math.hypot(cp.x - x, cp.z - z);
      a.idle = speed < 1 ? a.idle + dt : 0;
      if (d > RACE_LOST || a.idle > RACE_IDLE) {
        this.active = null;
        this.ignoreId = race.id;
        this.notice(a.event, 'Race abandoned.', false);
        this.endRace();
        return;
      }
      // Through a checkpoint: the next one (the finish line stays until the sim calls it).
      if (d < cp.radius && Math.abs(cp.y - player.pos.y) < 6) {
        a.next = Math.min(a.next + 1, a.event.checkpoints.length - 1);
      }
      return;
    }
    if (a.kind === 'getaway') {
      this.updateGetaway(a, dt, police);
      return;
    }
    if (a.kind === 'drift') {
      const inside = this.inZone(a.event, x, z);
      if (inside) {
        a.out = 0;
        const w = player.wheels;
        const rear = (Math.abs(w[2]?.slipAngle ?? 0) + Math.abs(w[3]?.slipAngle ?? 0)) / 2;
        if (rear > DRIFT_SLIP && speed > 6) a.points += speed * rear * dt * 15;
      } else {
        a.out += dt;
        if (a.out > 1.5) {
          this.active = null;
          if (a.points >= 20) {
            const best = this.record(a.event, a.points);
            this.notice(
              a.event,
              `Drift zone · ${a.event.name}: ${Math.round(a.points).toLocaleString('en-US')} pts`,
              best,
            );
          }
        }
      }
      return;
    }
    // A jump: airborne after the ramp until the wheels touch again.
    const grounded = player.wheels.some((w) => w.contact);
    if (!a.flying) {
      if (!grounded) {
        a.flying = true;
        a.air = 0;
      } else if (this.onRamp(a.event, x, z) === null) {
        // Drove off the ramp's side, or back down it.
        this.active = null;
      }
      return;
    }
    a.air += dt;
    if (grounded) {
      this.active = null;
      const distance = Math.hypot(x - a.lipX, z - a.lipZ);
      if (a.air > 0.25 && distance > 3) {
        const best = this.record(a.event, distance);
        this.notice(a.event, `Jump · ${a.event.name}: ${distance.toFixed(1)} m`, best);
      }
    }
  }

  /**
   * A getaway runs on the police's word: from the first sight of the pursuit, an escape ends
   * it with the time (a medal against par), a bust ends it with nothing. Police that never
   * come (none in the session) let it lapse.
   */
  private updateGetaway(
    a: Extract<Active, { kind: 'getaway' }>,
    dt: number,
    police: PoliceStatus | null,
  ): void {
    a.time += dt;
    if (police?.state === 'pursuit') a.chased = true;
    if (!a.chased) {
      if (a.time > 6) this.active = null;
      return;
    }
    if (police?.state === 'escaped') {
      this.active = null;
      const best = this.record(a.event, a.time);
      const medal = medalFor(a.event, a.time);
      // On the race card, as a race's result is (no field to list).
      this.notice(
        a.event,
        `Getaway · ${a.event.name}: ${formatTime(a.time)}${medal ? ` · ${medal.toUpperCase()}` : ''}`,
        best,
        medal,
        undefined,
        [],
      );
    } else if (police?.state === 'busted') {
      this.active = null;
      this.notice(a.event, `Getaway · ${a.event.name}: busted.`, false);
    }
  }

  private updateView(x: number, z: number): void {
    const a = this.active;
    const view = this.view;
    if (a) {
      view.hint = null;
      if (a.kind === 'race') {
        const cp = a.event.checkpoints[a.next]!;
        const rivals = a.count - 1;
        view.active = a.intro
          ? {
              kind: 'race',
              name: a.event.name,
              line: 'GET READY',
              detail: `Standing start · ${rivals} rival${rivals === 1 ? '' : 's'}`,
              intro: true,
            }
          : a.countdown > 0
            ? {
                kind: 'race',
                name: a.event.name,
                line: String(Math.ceil(a.countdown)),
                detail: `Standing start · ${rivals} rival${rivals === 1 ? '' : 's'}`,
                countdown: true,
              }
            : {
                kind: 'race',
                name: a.event.name,
                line: `P${a.position} · ${formatTime(a.time)}`,
                detail:
                  a.time < 1.5
                    ? 'GO!'
                    : `Checkpoint ${a.next} / ${a.event.checkpoints.length - 1} · ${Math.round(Math.hypot(cp.x - x, cp.z - z))} m`,
                standings: this.standings(),
              };
      } else if (a.kind === 'getaway') {
        view.active = {
          kind: 'getaway',
          name: a.event.name,
          line: formatTime(a.time),
          detail: a.chased ? `${a.event.heat ?? 3} stars · lose them` : 'Here they come',
        };
      } else if (a.kind === 'drift') {
        view.active = {
          kind: 'drift',
          name: a.event.name,
          line: `${Math.round(a.points).toLocaleString('en-US')} pts`,
          detail: 'Drift zone',
        };
      } else {
        view.active = {
          kind: 'jump',
          name: a.event.name,
          line: a.flying ? `${Math.hypot(x - a.lipX, z - a.lipZ).toFixed(1)} m` : 'Ramp',
          detail: 'Jump',
        };
      }
      return;
    }
    view.active = null;
    let nearest: FestivalEvent | null = null;
    let nearestD = HINT_RANGE;
    for (const event of this.events) {
      const d = Math.hypot(event.x - x, event.z - z);
      if (d < nearestD) {
        nearestD = d;
        nearest = event;
      }
    }
    view.hint = nearest ? { kind: nearest.kind, name: nearest.name, distance: nearestD } : null;
  }

  /** The field in order: home first by time, then by progress; gaps relative to the player. */
  private standings(): Standing[] {
    const race = this.race;
    if (!race) return [];
    const rows = [
      { name: 'You', you: true, progress: race.progress, time: race.finished },
      ...race.rivals.map((r, i) => ({
        name: racerName(i),
        you: false,
        progress: r.progress,
        time: r.time,
      })),
    ];
    rows.sort((p, q) => {
      if (p.time >= 0 && q.time >= 0) return p.time - q.time;
      if (p.time >= 0 || q.time >= 0) return p.time >= 0 ? -1 : 1;
      return q.progress - p.progress;
    });
    return rows.map((r, i) => ({
      position: i + 1,
      name: r.name,
      you: r.you,
      gap:
        r.time >= 0
          ? formatTime(r.time)
          : r.you
            ? ''
            : `${r.progress >= race.progress ? '+' : '−'}${Math.round(Math.abs(r.progress - race.progress))} m`,
    }));
  }

  /** Whether the car crossed an event's line this frame (either way, within its width). */
  private crossed(event: FestivalEvent, x: number, z: number, y: number): boolean {
    const along = (x - event.x) * event.tx + (z - event.z) * event.tz;
    const prev = this.prevAlong.get(event.id);
    this.prevAlong.set(event.id, along);
    if (prev === undefined) return false;
    if (Math.abs(along) > 30 || Math.sign(along) === Math.sign(prev) || along === 0) return false;
    const across = -(x - event.x) * event.tz + (z - event.z) * event.tx;
    if (Math.abs(across) > event.halfWidth + 2) return false;
    if (Math.abs(y - event.y) > 4) return false;
    return Math.hypot(x - this.prevX, z - this.prevZ) < 40;
  }

  private inZone(event: FestivalEvent, x: number, z: number): boolean {
    const zone = event.zone;
    if (!zone) return false;
    const road = zone.road;
    // Nearest piece of the zone's road (its pieces are consecutive along it).
    let best = Infinity;
    let s = -1;
    for (const p of zone.pieces) {
      const dx = x - p.ax;
      const dz = z - p.az;
      const t = Math.min(Math.max((dx * p.tx + dz * p.tz) / p.len, 0), 1);
      const d = Math.hypot(dx - p.tx * p.len * t, dz - p.tz * p.len * t);
      if (d < best) {
        best = d;
        s = p.s0 + p.len * t;
      }
    }
    return best <= road.width / 2 + ZONE_MARGIN && s >= zone.s0 && s <= zone.s1;
  }

  /** How far along a jump's ramp a point is (0 … length), or null off it. */
  private onRamp(event: FestivalEvent, x: number, z: number): number | null {
    const ramp = event.ramp;
    if (!ramp) return null;
    const dx = x - event.x;
    const dz = z - event.z;
    const u = dx * event.tx + dz * event.tz;
    if (u < -1 || u > ramp.length + 1) return null;
    const v = -dx * event.tz + dz * event.tx;
    return Math.abs(v) <= ramp.width / 2 + 1 ? u : null;
  }

  /** Stores a result when it beats the record; true when it did. */
  private record(event: FestivalEvent, value: number): boolean {
    const old = this.records[event.id];
    const better =
      old === undefined || (Festival.lowerIsBetter(event.kind) ? value < old : value > old);
    if (better) {
      this.records[event.id] = value;
      this.save(event.id, value);
    }
    return better;
  }

  private notice(
    event: FestivalEvent,
    text: string,
    best: boolean,
    medal: Medal = null,
    position?: number,
    results?: Standing[],
  ): void {
    this.notices.push({
      event,
      text: best ? `${text} · new best!` : text,
      best,
      medal,
      position,
      results,
    });
  }
}

/** How the festival is going: events with a result, and the races' medals. */
export interface FestivalTotals {
  events: number;
  done: number;
  gold: number;
  silver: number;
  bronze: number;
}

export function festivalTotals(
  events: readonly FestivalEvent[],
  records: FestivalRecords,
): FestivalTotals {
  const totals: FestivalTotals = { events: events.length, done: 0, gold: 0, silver: 0, bronze: 0 };
  for (const e of events) {
    const value = records[e.id];
    if (value === undefined) continue;
    totals.done++;
    if (e.kind !== 'race' && e.kind !== 'getaway') continue;
    const medal = medalFor(e, value);
    if (medal) totals[medal]++;
  }
  return totals;
}

export function medalFor(event: FestivalEvent, time: number): Medal {
  for (const m of MEDALS) if (time <= event.par * m.factor) return m.name;
  return null;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
