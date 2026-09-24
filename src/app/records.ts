import { isCareerSave, type CareerSave } from '../content/career';
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
  /** The hour on free roam's day clock when the drive was left (unset: the time of day's). */
  hour?: number;
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
      ...(num(r.hour) ? { hour: r.hour as number } : {}),
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

const PROGRESS_KEY = 'apex-gp.progress';

/** The festival's lifetime tallies: skill points banked over every drive, and races won. */
export interface FestivalProgress {
  skill: number;
  wins: number;
}

export function loadProgress(): FestivalProgress {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const count = (v: unknown) =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
    return { skill: count(r.skill), wins: count(r.wins) };
  } catch {
    return { skill: 0, wins: 0 };
  }
}

export function saveProgress(progress: FestivalProgress): void {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage blocked: the tallies last for this session only.
  }
}

const DRIFT_KEY = 'apex-gp.drift';

/** Best drift trial score per circuit and laps (`trackId:laps`), kept in this browser. */
export function loadDriftRecords(): Records {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DRIFT_KEY) ?? '{}');
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

export function saveDriftRecord(key: string, score: number): Records {
  const records = loadDriftRecords();
  records[key] = score;
  try {
    localStorage.setItem(DRIFT_KEY, JSON.stringify(records));
  } catch {
    // Storage blocked: the record lasts for this session only.
  }
  return records;
}

const DAILY_KEY = 'apex-gp.daily';

/** The daily challenge's best lap, and the day it was set on. */
export interface DailyBest {
  key: string;
  best: number;
}

export function loadDailyBest(): DailyBest | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(DAILY_KEY) ?? 'null');
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.key !== 'string' || typeof r.best !== 'number' || !(r.best > 0)) return null;
    return { key: r.key, best: r.best };
  } catch {
    return null;
  }
}

export function saveDailyBest(best: DailyBest): void {
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(best));
  } catch {
    // Storage blocked: the best lasts for this session only.
  }
}

const CAREER_KEY = 'apex-gp.career';

/** The career: the tier reached and every season's result, kept in this browser. */
export function loadCareer(): CareerSave | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(CAREER_KEY) ?? 'null');
    return isCareerSave(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function saveCareer(career: CareerSave): void {
  try {
    localStorage.setItem(CAREER_KEY, JSON.stringify(career));
  } catch {
    // Storage blocked: the career lasts for this session only.
  }
}
