/** Best lap per track (time trial and races), kept in this browser. */

const KEY = 'apex-gp.records';

export type Records = Record<string, number>;

export function loadRecords(): Records {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Records = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/** Stores a new best lap for `trackId` and returns the updated records. */
export function saveRecord(trackId: string, seconds: number): Records {
  const records = loadRecords();
  records[trackId] = seconds;
  try {
    localStorage.setItem(KEY, JSON.stringify(records));
  } catch {
    // Storage blocked: the record lasts for this session only.
  }
  return records;
}

const SEASON_KEY = 'apex-gp.championship';

/** The championship in progress, kept so a season survives closing the game. */
export function loadSeason<T>(valid: (value: unknown) => value is T): T | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SEASON_KEY) ?? 'null');
    return valid(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveSeason(season: unknown): void {
  try {
    if (season === null) localStorage.removeItem(SEASON_KEY);
    else localStorage.setItem(SEASON_KEY, JSON.stringify(season));
  } catch {
    // Storage blocked: the season lasts for this session only.
  }
}

const FESTIVAL_KEY = 'apex-gp.festival';

/** Best result per festival event (a race's time in seconds, a zone's points, a trap's km/h, a jump's metres). */
export function loadFestivalRecords(): Records {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(FESTIVAL_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const out: Records = {};
    for (const [id, value] of Object.entries(raw)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveFestivalRecord(id: string, value: number): Records {
  const records = loadFestivalRecords();
  records[id] = value;
  try {
    localStorage.setItem(FESTIVAL_KEY, JSON.stringify(records));
  } catch {
    // Storage blocked: the record lasts for this session only.
  }
  return records;
}

const ROAM_KEY = 'apex-gp.roam';

/** Where a free roam drive was left: the car and where it stood, with the day and the weather. */
export interface RoamSpot {
  x: number;
  z: number;
  y: number;
  yaw: number;
  carId: string;
  time: string;
  weather: string;
  handling: string;
}

export function loadRoamSpot(): RoamSpot | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(ROAM_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    const str = (v: unknown) => typeof v === 'string' && v.length > 0;
    if (!num(r.x) || !num(r.z) || !num(r.y) || !num(r.yaw)) return null;
    if (!str(r.carId) || !str(r.time) || !str(r.weather) || !str(r.handling)) return null;
    return {
      x: r.x as number,
      z: r.z as number,
      y: r.y as number,
      yaw: r.yaw as number,
      carId: r.carId as string,
      time: r.time as string,
      weather: r.weather as string,
      handling: r.handling as string,
    };
  } catch {
    return null;
  }
}

export function saveRoamSpot(spot: RoamSpot | null): void {
  try {
    if (spot === null) localStorage.removeItem(ROAM_KEY);
    else localStorage.setItem(ROAM_KEY, JSON.stringify(spot));
  } catch {
    // Storage blocked: the spot lasts for this session only.
  }
}
