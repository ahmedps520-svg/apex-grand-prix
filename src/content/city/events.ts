import { RING_HALF, type CityMap, type Road, type RoadPiece } from './map';

/**
 * The festival: events placed on the open world's roads, derived from the map so the physics
 * worker (ramps), the renderer (markers) and the main thread (the events' rules) all agree.
 *
 * - Speed cameras: a gantry across a road; crossing it registers your speed.
 * - Drift zones: a stretch of road where a drift's points count, banked when you leave.
 * - Jumps (danger signs): a ramp on a straight; the distance from its lip to the landing counts.
 * - Races: point-to-point (or a lap) through checkpoints against the clock, with medal times.
 */

export type EventKind = 'race' | 'drift' | 'camera' | 'jump';

export interface Checkpoint {
  x: number;
  z: number;
  y: number;
  radius: number;
}

export interface RampSpec {
  /** Along the direction of travel: the ramp's length, its rise at the lip, and its width. */
  length: number;
  rise: number;
  width: number;
}

export interface FestivalEvent {
  id: string;
  kind: EventKind;
  name: string;
  /** The marker (the line, the gantry, the ramp's foot), its road height and its heading. */
  x: number;
  z: number;
  y: number;
  yaw: number;
  /** Unit direction of travel through it, on the ground. */
  tx: number;
  tz: number;
  /** Half the width of the line across the road. */
  halfWidth: number;
  /** Races: the checkpoints in order (the first is the start line, the last the finish). */
  checkpoints: Checkpoint[];
  /** Races and drift zones: the route's length, m. Races: the par time for gold, s. */
  length: number;
  par: number;
  /** Drift zones: the road, the stretch along it, and the road's pieces (for the zone test). */
  zone?: { road: Road; s0: number; s1: number; pieces: RoadPiece[] };
  ramp?: RampSpec;
}

/** Medal thresholds as multiples of the par time. */
export const MEDALS: ReadonlyArray<{ name: 'gold' | 'silver' | 'bronze'; factor: number }> = [
  { name: 'gold', factor: 1 },
  { name: 'silver', factor: 1.15 },
  { name: 'bronze', factor: 1.35 },
];

export const RAMP: RampSpec = { length: 12, rise: 1.8, width: 7 };

const cache = new WeakMap<CityMap, FestivalEvent[]>();

/** The festival's events for a map (built once per map). */
export function festivalEvents(map: CityMap): FestivalEvent[] {
  let events = cache.get(map);
  if (!events) {
    events = build(map);
    cache.set(map, events);
  }
  return events;
}

function build(map: CityMap): FestivalEvent[] {
  const events: FestivalEvent[] = [];
  const along = (road: Road) => (x: number, z: number) => map.alongRoad(road, x, z)?.s ?? 0;

  // The roads the festival uses: the central avenue (x = 0), the boulevard (z = 0), the orbital,
  // the ridge, the circuit, the port's roads and the paddock lane.
  const avenue = map.roads.find(
    (r) => r.kind === 'avenue' && Math.abs(r.points[0]!) < 1 && Math.abs(r.points[2]!) < 1,
  );
  const boulevard = map.roads.find(
    (r) => r.kind === 'avenue' && Math.abs(r.points[1]!) < 1 && Math.abs(r.points[3]!) < 1,
  );
  const orbital = map.roads.find((r) => r.kind === 'highway');
  const ridge = map.roads.find((r) => r.kind === 'mountain');
  const circuit = map.roads.find((r) => r.kind === 'circuit');
  const dock = map.roads.find((r) => r.name === 'Dock Road');
  const quay = map.roads.find((r) => r.name === 'Quay Street');
  const paddock = map.roads.find((r) => r.kind === 'access');
  const drive = map.roads.find((r) => r.kind === 'suburb' && r.name.endsWith('Drive'));

  const marker = (
    id: string,
    kind: EventKind,
    name: string,
    road: Road,
    s: number,
    forward = 1,
  ): FestivalEvent | null => {
    const p = map.pointAlong(road, s);
    if (!p) return null;
    const tx = p.tx * forward;
    const tz = p.tz * forward;
    return {
      id,
      kind,
      name,
      x: p.x,
      z: p.z,
      y: p.y,
      yaw: Math.atan2(-tx, -tz),
      tx,
      tz,
      halfWidth: road.width / 2,
      checkpoints: [],
      length: 0,
      par: 0,
    };
  };

  // Speed cameras.
  const cameras: Array<[string, string, Road | undefined, (r: Road) => number]> = [
    ['cam-avenue', 'Avenue South', avenue, (r) => along(r)(0, -350)],
    ['cam-boulevard', 'Boulevard East', boulevard, (r) => along(r)(600, 0)],
    ['cam-orbital', 'Orbital North', orbital, (r) => along(r)(-300, -RING_HALF)],
    ['cam-dock', 'Dock Road', dock, (r) => r.length / 2],
    ['cam-ridge', 'Ridge Climb', ridge, () => 220],
    ['cam-paddock', 'Paddock Lane', paddock, (r) => r.length / 2],
  ];
  for (const [id, name, road, at] of cameras) {
    if (!road) continue;
    const e = marker(id, 'camera', name, road, at(road));
    if (e) events.push(e);
  }

  // Jumps: a ramp on a straight with a run-up, facing the given way along the road.
  const jumps: Array<[string, string, Road | undefined, (r: Road) => number, number]> = [
    ['jump-avenue', 'Avenue Leap', avenue, (r) => along(r)(0, 150), -1],
    ['jump-boulevard', 'Boulevard Bounce', boulevard, (r) => along(r)(-400, 0), 1],
    ['jump-dock', 'Dock Drop', dock, (r) => r.length * 0.3, 1],
    ['jump-drive', 'Suburb Skip', drive, (r) => r.length * 0.4, 1],
  ];
  for (const [id, name, road, at, dir] of jumps) {
    if (!road) continue;
    const s = at(road);
    const p = map.pointAlong(road, s);
    if (!p) continue;
    // Whether the road's own direction or its reverse is the way over the ramp.
    const forward = dir >= 0 ? 1 : -1;
    // A ramp only where the road is flat enough to matter.
    const ahead = map.pointAlong(road, s + forward * RAMP.length);
    if (!ahead || Math.abs(ahead.y - p.y) > 0.3) continue;
    const e = marker(id, 'jump', name, road, s, forward);
    if (!e) continue;
    e.ramp = { ...RAMP, width: Math.min(RAMP.width, road.width - 2) };
    events.push(e);
  }

  // Drift zones: a stretch of a road, the marker at its start.
  const zones: Array<[string, string, Road | undefined, number, number]> = [
    ['drift-ridge', 'Ridge Switchbacks', ridge, 250, 900],
    ['drift-circuit', 'Circuit Esses', circuit, 60, 760],
    ['drift-dock', 'Dock Road Sweep', dock, 40, 360],
    ['drift-quay', 'Quay Street', quay, 40, 360],
  ];
  for (const [id, name, road, s0, s1] of zones) {
    if (!road || road.length < s1 + 10) continue;
    const e = marker(id, 'drift', name, road, s0);
    if (!e) continue;
    e.zone = { road, s0, s1, pieces: map.pieces.filter((p) => p.road === road) };
    e.length = s1 - s0;
    events.push(e);
  }

  // Races: checkpoints every so often along a stretch (or a lap), the last one the finish.
  const races: Array<[string, string, Road | undefined, number, number, number]> = [
    ['race-avenue', 'Downtown Dash', avenue, 0, 0, 30],
    ['race-boulevard', 'Crosstown', boulevard, 0, 0, 30],
    ['race-orbital', 'Orbital Lap', orbital, 0, 0, 40],
    ['race-ridge', 'Ridge Climb', ridge, 0, 0, 16],
    ['race-circuit', 'Club Lap', circuit, 0, 0, 34],
  ];
  for (const [id, name, road, from, to, pace] of races) {
    if (!road) continue;
    const start = road.loop ? from : Math.min(from + 40, road.length);
    const end = road.loop ? start + road.length : to > 0 ? to : road.length - 40;
    const length = end - start;
    if (length < 300) continue;
    const e = marker(id, 'race', name, road, start);
    if (!e) continue;
    const gap = length / Math.max(Math.round(length / 200), 2);
    const checkpoints: Checkpoint[] = [];
    for (let s = start; s <= end + 0.5; s += gap) {
      const p = map.pointAlong(road, Math.min(s, end));
      if (!p) continue;
      checkpoints.push({ x: p.x, z: p.z, y: p.y, radius: Math.max(road.width / 2 + 6, 14) });
    }
    if (checkpoints.length < 3) continue;
    e.checkpoints = checkpoints;
    e.length = length;
    e.par = length / pace;
    events.push(e);
  }
  return events;
}

/** A jump's ramp in world terms: its foot, its direction and its height at the foot. */
export function rampOf(event: FestivalEvent): {
  x: number;
  z: number;
  y: number;
  tx: number;
  tz: number;
  length: number;
  rise: number;
  width: number;
} | null {
  if (!event.ramp) return null;
  return { x: event.x, z: event.z, y: event.y, tx: event.tx, tz: event.tz, ...event.ramp };
}
