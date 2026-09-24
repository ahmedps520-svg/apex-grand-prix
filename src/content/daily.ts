import { mulberry32 } from '../shared/math';
import { CARS } from '../sim/vehicle/cars';
import type { Conditions, Weather } from './conditions';
import { TRACKS } from './tracks';

/**
 * The daily challenge: a time trial on a circuit, in a car and in conditions drawn from the
 * day's date, the same for everyone that day, with the day's best lap kept apart.
 */
export interface DailyChallenge {
  /** The day, UTC, as YYYY-MM-DD: the key its best is kept under. */
  key: string;
  trackId: string;
  carId: string;
  time: Conditions['time'];
  weather: Weather;
}

const TIMES: ReadonlyArray<Conditions['time']> = [
  'track',
  'morning',
  'midday',
  'afternoon',
  'golden',
  'dusk',
  'night',
];
/** Dry days come round more often. */
const WEATHERS: readonly Weather[] = [
  'clear',
  'clear',
  'cloudy',
  'overcast',
  'lightRain',
  'heavyRain',
];

export function dailyKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function dailyChallenge(date = new Date()): DailyChallenge {
  const key = dailyKey(date);
  const rand = mulberry32(Number(key.replace(/-/g, '')) ^ 0x5eed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  return {
    key,
    trackId: pick(TRACKS).id,
    carId: pick(CARS).id,
    time: pick(TIMES),
    weather: pick(WEATHERS),
  };
}
