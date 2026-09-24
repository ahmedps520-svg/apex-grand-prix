import { hourOf, sunElevationAt, wrapHour, type Conditions } from '../conditions';

/**
 * The city's day: its own sun (the "circuit default" look, an afternoon sun from the south-west)
 * and the path the sun takes across its sky when the clock runs, 15° an hour, passing through
 * that sun at its hour. Pure data, shared by the simulation (headlights) and the renderer.
 */

/** The city's own sun: elevation and bearing, degrees. */
export const CITY_SUN_ELEVATION = 38;
export const CITY_SUN_AZIMUTH = 215;

/** The hour of the day the city's own sun stands at (an afternoon). */
export const CITY_SUN_HOUR = hourOf('track', CITY_SUN_ELEVATION);

/** The sun's bearing at noon, so that the path passes the city's own sun at its hour. */
const NOON_AZIMUTH = CITY_SUN_AZIMUTH - (CITY_SUN_HOUR - 12) * 15;

/** The hour of the city's day a time-of-day setting stands for. */
export function cityHourOf(time: Conditions['time']): number {
  return hourOf(time, CITY_SUN_ELEVATION);
}

/** The sun's bearing at an hour of the city's day, degrees (continuous round midnight). */
export function citySunAzimuthAt(hour: number): number {
  return NOON_AZIMUTH + (wrapHour(hour) - 12) * 15;
}

/** The city's sun at an hour of its day: elevation and bearing, degrees. */
export function citySunAt(hour: number): { elevation: number; azimuth: number } {
  return { elevation: sunElevationAt(hour), azimuth: citySunAzimuthAt(hour) };
}
