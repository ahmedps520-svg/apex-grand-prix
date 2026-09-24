/**
 * Session conditions: time of day and weather. Pure data and functions (no three.js or DOM), so
 * the simulation, the menus and the renderer can all share them.
 */

export type TimeOfDay = 'morning' | 'midday' | 'afternoon' | 'golden' | 'dusk' | 'night';
export type Weather = 'clear' | 'cloudy' | 'overcast' | 'lightRain' | 'heavyRain';

export interface Conditions {
  /** Time of day; 'track' keeps the circuit's own sun (its theme). */
  time: TimeOfDay | 'track';
  weather: Weather;
}

/** The circuit as designed: its own sun, and dry. */
export const DEFAULT_CONDITIONS: Readonly<Conditions> = { time: 'track', weather: 'clear' };

/** Choices for a time-of-day setting, the circuit's own sun first. */
export const TIMES_OF_DAY: ReadonlyArray<{ value: Conditions['time']; text: string }> = [
  { value: 'track', text: 'Circuit default' },
  { value: 'morning', text: 'Morning' },
  { value: 'midday', text: 'Midday' },
  { value: 'afternoon', text: 'Afternoon' },
  { value: 'golden', text: 'Golden hour' },
  { value: 'dusk', text: 'Dusk' },
  { value: 'night', text: 'Night' },
];

/** Choices for a weather setting, driest first. */
export const WEATHERS: ReadonlyArray<{ value: Weather; text: string }> = [
  { value: 'clear', text: 'Clear' },
  { value: 'cloudy', text: 'Cloudy' },
  { value: 'overcast', text: 'Overcast' },
  { value: 'lightRain', text: 'Light rain' },
  { value: 'heavyRain', text: 'Heavy rain' },
];

/** Height of the sun above the horizon for each time of day, degrees. */
export const SUN_ELEVATION: Readonly<Record<TimeOfDay, number>> = {
  morning: 15,
  midday: 60,
  afternoon: 35,
  golden: 7,
  dusk: 2,
  night: -14,
};

const WETNESS: Readonly<Record<Weather, number>> = {
  clear: 0,
  cloudy: 0,
  overcast: 0,
  lightRain: 0.55,
  heavyRain: 1,
};

const GRIP: Readonly<Record<Weather, number>> = {
  clear: 1,
  cloudy: 1,
  overcast: 1,
  lightRain: 0.85,
  heavyRain: 0.72,
};

/** How wet the track is in this weather: 0 dry … 1 soaked (standing water). */
export function wetness(weather: Weather): number {
  return WETNESS[weather];
}

/** Tyre grip in this weather as a fraction of dry grip (1 in the dry). */
export function gripFactor(weather: Weather): number {
  return GRIP[weather];
}

/** Is it raining? */
export function isRaining(weather: Weather): boolean {
  return weather === 'lightRain' || weather === 'heavyRain';
}

/** Sun elevation in degrees for a time of day, or the circuit's own for 'track'. */
export function sunElevation(time: Conditions['time'], trackElevation: number): number {
  return time === 'track' ? trackElevation : SUN_ELEVATION[time];
}

export function isTimeOfDay(value: unknown): value is Conditions['time'] {
  return TIMES_OF_DAY.some((option) => option.value === value);
}

export function isWeather(value: unknown): value is Weather {
  return WEATHERS.some((option) => option.value === value);
}

/** Valid conditions from stored or untrusted data; anything unknown falls back to the default. */
export function sanitizeConditions(value: unknown): Conditions {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof Conditions, unknown>
  >;
  return {
    time: isTimeOfDay(raw.time) ? raw.time : DEFAULT_CONDITIONS.time,
    weather: isWeather(raw.weather) ? raw.weather : DEFAULT_CONDITIONS.weather,
  };
}

/**
 * The day's clock (free roam): the sun rises at 6:00, stands 60° high at noon, sets at 18:00 and
 * sinks 14° under the horizon by midnight. Each time-of-day setting is an hour on it.
 */
export const SUNRISE = 6;
export const SUNSET = 18;
const NOON_ELEVATION = 60;
const MIDNIGHT_ELEVATION = -14;

/** An hour brought into 0 … 24 (the clock wraps at midnight). */
export function wrapHour(hour: number): number {
  const h = hour % 24;
  return h < 0 ? h + 24 : h;
}

/** The sun's height above the horizon at an hour of the day, degrees (negative at night). */
export function sunElevationAt(hour: number): number {
  const h = wrapHour(hour);
  if (h >= SUNRISE && h <= SUNSET) {
    return NOON_ELEVATION * Math.sin(((h - SUNRISE) / 12) * Math.PI);
  }
  const sinceSunset = h > SUNSET ? h - SUNSET : h + 24 - SUNSET;
  return MIDNIGHT_ELEVATION * Math.sin((sinceSunset / 12) * Math.PI);
}

/**
 * The hour at which the sun stands at an elevation (degrees), in the morning or the afternoon
 * (the evening or the small hours for a sun under the horizon).
 */
export function hourAtElevation(
  elevation: number,
  half: 'morning' | 'afternoon' = 'afternoon',
): number {
  if (elevation < 0) {
    const depth = Math.min(elevation / MIDNIGHT_ELEVATION, 1);
    const t = (12 * Math.asin(depth)) / Math.PI;
    return wrapHour(half === 'morning' ? SUNRISE - t : SUNSET + t);
  }
  const t = (12 * Math.asin(Math.min(elevation / NOON_ELEVATION, 1))) / Math.PI;
  return half === 'morning' ? SUNRISE + t : SUNSET - t;
}

/**
 * The hour of the day a time-of-day setting stands for: morning in the morning, the rest in the
 * afternoon and evening, midnight for night; 'track' is the hour the circuit's own sun stands at.
 */
export function hourOf(time: Conditions['time'], trackElevation: number): number {
  const half = time === 'morning' ? 'morning' : 'afternoon';
  return hourAtElevation(sunElevation(time, trackElevation), half);
}

/** Darkness by sun elevation: full night 6° under the horizon, dusk at 2°, golden hour at 7°, day from 12°. */
const DARKNESS_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-6, 1],
  [2, 0.7],
  [7, 0.25],
  [12, 0],
];

/** How dark it is with the sun at an elevation (degrees), 0 (day) … 1 (night). */
export function darknessAt(elevation: number): number {
  const curve = DARKNESS_CURVE;
  if (!Number.isFinite(elevation) || elevation <= curve[0]![0]) return 1;
  for (let i = 1; i < curve.length; i++) {
    const [e0, d0] = curve[i - 1]!;
    const [e1, d1] = curve[i]!;
    if (elevation <= e1) return d0 + ((d1 - d0) * (elevation - e0)) / (e1 - e0);
  }
  return 0;
}

/** How dark a time of day is, 0 (day) … 1 (night): the lamps, windows and searchlights follow it. */
export function darkness(time: Conditions['time']): number {
  return time === 'track' ? 0 : darknessAt(SUN_ELEVATION[time]);
}

/** Headlights come on by themselves with the sun this low: dusk and night, not golden hour. */
export function afterDark(elevation: number): boolean {
  return darknessAt(elevation) >= 0.5;
}

/** Free roam: how long a day of its clock takes in real time. */
export type DayLength = 'still' | 'short' | 'long';

/** Real minutes for a full day of the clock; 0 keeps the chosen time of day. */
export const DAY_MINUTES: Readonly<Record<DayLength, number>> = {
  still: 0,
  short: 24,
  long: 60,
};

/** Choices for the day-length setting. */
export const DAY_LENGTHS: ReadonlyArray<{ value: DayLength; text: string }> = [
  { value: 'still', text: 'Still: the time chosen' },
  { value: 'short', text: 'A day in 24 minutes' },
  { value: 'long', text: 'A day in an hour' },
];

export function isDayLength(value: unknown): value is DayLength {
  return DAY_LENGTHS.some((option) => option.value === value);
}

/** The clock's rate for a day that takes this many real minutes: hours per real second (0 still). */
export function dayRate(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? 24 / (minutes * 60) : 0;
}

/** An hour of the day as a clock readout, "18:42". */
export function clockText(hour: number): string {
  const h = wrapHour(Number.isFinite(hour) ? hour : 0);
  const minutes = Math.floor(h * 60);
  const hh = String(Math.floor(minutes / 60) % 24).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}
