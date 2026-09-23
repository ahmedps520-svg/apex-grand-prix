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
