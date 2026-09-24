import * as THREE from 'three/webgpu';
import {
  DEFAULT_CONDITIONS,
  sunElevation,
  wetness,
  type Conditions,
  type Weather,
} from '../content/conditions';
import type { TrackTheme } from '../sim/track/Track';

/** Fog distances on a clear day. */
export const CLEAR_FOG_NEAR = 350;
export const CLEAR_FOG_FAR = 2600;

/** Sky settings: the Preetham model's (see SkyMesh), then our cloud deck over it. */
export interface SkyLook {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  mieDirectionalG: number;
  cloudCoverage: number;
  cloudDensity: number;
  /** 1 shows the sun disc, 0 hides it. */
  sunDisc: number;
  /** Blend from the clear sky to a grey cloud deck: 0 … 1. */
  overcast: number;
  /** The deck's colour at the horizon (also the fog colour when fully overcast) and overhead. */
  horizon: THREE.Color;
  zenith: THREE.Color;
  /** How mottled the deck looks: 0 flat … 1. */
  mottle: number;
  /** Blend of the sky towards the fog colour just above the horizon, hiding the ground's edge. */
  haze: number;
  /** Blend from the daylight model to a twilight gradient: 0 by day … 1 at dusk. */
  twilight: number;
  /** The twilight gradient's colour overhead. */
  duskZenith: THREE.Color;
}

/** Everything that sets the light and the atmosphere of a circuit for some conditions. */
export interface SceneLook {
  /** The sun in the sky, degrees. */
  sunElevation: number;
  sunAzimuth: number;
  /**
   * Where the shadow-casting light shines from: the sun, but never grazing the ground, and from
   * high overhead under a closed cloud deck (soft light from the whole sky); at night the moon,
   * opposite the sun's bearing and 25° up.
   */
  lightElevation: number;
  lightAzimuth: number;
  /** 0 for a high sun, up to 1 for a low golden-hour one. */
  lowSun: number;
  sky: SkyLook;
  sunColor: THREE.Color;
  sunIntensity: number;
  shadowRadius: number;
  /** How dark shadows are (1 = only the sky's light reaches them). */
  shadowIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  environmentIntensity: number;
  /** Fog (and horizon haze) colour looking away from the sun, and looking towards it. */
  fogColor: THREE.Color;
  fogSunColor: THREE.Color;
  fogNear: number;
  fogFar: number;
  /** Road wetness, 0 dry … 1 standing water. */
  wetness: number;
  /** Falling rain, 0 none … 1 heavy. */
  rain: number;
  /** Colour of rain streaks and spray (lit by the sky). */
  waterColor: THREE.Color;
  /** How far into the night the sun is: 0 by day and dusk, 1 with the sun well under. */
  night: number;
  /** Cloud cover, 0 clear … 1 a closed deck. */
  cloud: number;
}

interface WeatherStyle {
  /** Cloud: 0 clear … 1 a closed deck with no sun. */
  cover: number;
  /** Rain clouds: darker sky and light, 0 … 1. */
  gloom: number;
  cloudCoverage: number;
  cloudDensity: number;
  /** Extra turbidity: a hazier sky. */
  haze: number;
  fogNear: number;
  fogFar: number;
  rain: number;
}

const WEATHER_STYLE: Readonly<Record<Weather, WeatherStyle>> = {
  clear: {
    cover: 0,
    gloom: 0,
    cloudCoverage: 0.32,
    cloudDensity: 0.4,
    haze: 0,
    fogNear: CLEAR_FOG_NEAR,
    fogFar: CLEAR_FOG_FAR,
    rain: 0,
  },
  cloudy: {
    cover: 0.35,
    gloom: 0,
    cloudCoverage: 0.6,
    cloudDensity: 0.62,
    haze: 2.5,
    fogNear: 280,
    fogFar: 2000,
    rain: 0,
  },
  overcast: {
    cover: 1,
    gloom: 0,
    cloudCoverage: 0,
    cloudDensity: 0.4,
    haze: 4,
    fogNear: 140,
    fogFar: 1400,
    rain: 0,
  },
  lightRain: {
    cover: 1,
    gloom: 0.5,
    cloudCoverage: 0,
    cloudDensity: 0.4,
    haze: 5,
    fogNear: 40,
    fogFar: 760,
    rain: 0.45,
  },
  heavyRain: {
    cover: 1,
    gloom: 1,
    cloudCoverage: 0,
    cloudDensity: 0.4,
    haze: 6,
    fogNear: 12,
    fogFar: 430,
    rain: 1,
  },
};

/**
 * Horizon haze on a clear day by sun elevation (degrees), looking away from the sun and towards
 * it: the fog colours when the time of day is chosen rather than the circuit's own (whose fog
 * suits its own sun).
 */
const CLEAR_HAZE: ReadonlyArray<readonly [number, number, number]> = [
  [2, 0x6f6a8e, 0xf08c4e],
  [7, 0xc3c7d3, 0xf2c089],
  [15, 0xcdd5de, 0xece0cc],
  [35, 0xd2dce6, 0xe0e4e4],
  [60, 0xd0dde9, 0xd6e1ea],
];

/** Cloud deck at the horizon and overhead: plain overcast, and in heavy rain. */
const DECK_HORIZON = 0xcdd1d6;
const DECK_ZENITH = 0xc1c7ce;
const STORM_HORIZON = 0x8e959c;
const STORM_ZENITH = 0x767e87;
/** Lowest the shadow-casting light goes, degrees (grazing shadows smear and streak). */
const MIN_LIGHT_ELEVATION = 6;
/** The moon's height at night, degrees (where the night sky hangs it). */
const MOON_ELEVATION = 25;

const color = (hex: number) => new THREE.Color(hex);

/** Hermite smoothstep of x between edges a and b (like GLSL). */
function smooth(x: number, a: number, b: number): number {
  return THREE.MathUtils.smoothstep(x, a, b);
}

/** A style part way from one weather to another (every setting is a number). */
function mixStyle(a: WeatherStyle, b: WeatherStyle, t: number): WeatherStyle {
  const out = { ...a };
  for (const key of Object.keys(a) as Array<keyof WeatherStyle>) {
    out[key] = THREE.MathUtils.lerp(a[key], b[key], t);
  }
  return out;
}

/** Clear-day haze at a sun elevation: [away from the sun, towards it]. */
function hazeAt(elevation: number): [THREE.Color, THREE.Color] {
  const table = CLEAR_HAZE;
  let i = 1;
  while (i < table.length - 1 && elevation > table[i]![0]) i++;
  const [e0, away0, sun0] = table[i - 1]!;
  const [e1, away1, sun1] = table[i]!;
  const t = THREE.MathUtils.clamp((elevation - e0) / (e1 - e0), 0, 1);
  return [color(away0).lerp(color(away1), t), color(sun0).lerp(color(sun1), t)];
}

/**
 * The look of a circuit in some conditions. With the default conditions (the circuit's own sun,
 * clear) it is exactly the look the circuit's theme describes. A `sun` (elevation and bearing,
 * degrees) puts the sun anywhere in the sky instead: a clock running through the day. A `mix`
 * takes the weather part way (`blend`, 0 … 1) from the conditions' to another: weather moving.
 */
export function sceneLook(
  theme: TrackTheme,
  conditions: Conditions = DEFAULT_CONDITIONS,
  sun?: { elevation: number; azimuth: number },
  mix?: { to: Weather; blend: number },
): SceneLook {
  const moving = mix !== undefined && mix.to !== conditions.weather;
  const blend = moving ? THREE.MathUtils.clamp(mix.blend, 0, 1) : 0;
  const style = moving
    ? mixStyle(WEATHER_STYLE[conditions.weather], WEATHER_STYLE[mix.to], blend)
    : WEATHER_STYLE[conditions.weather];
  const elevation = sun ? sun.elevation : sunElevation(conditions.time, theme.sunElevation);
  const ownSun = !sun && conditions.time === 'track';
  const lowSun = 1 - smooth(elevation, 5, 40);
  /** 1 at dusk, fading out by a 7° sun. */
  const twilight = 1 - smooth(elevation, 2, 7);
  /** 1 at night (the sun below the horizon): moonlight, a dark sky, dark fog. */
  const night = 1 - smooth(elevation, -6, 1);
  const { cover, gloom } = style;
  // A closed deck (soft light from the whole sky) comes in over the last of the cover, so
  // weather moving in never jumps.
  const closed = smooth(cover, 0.85, 1);

  // Clear-sky light, as the circuit themes were tuned: warmer and softer as the sun gets low,
  // and at dusk a weak orange sun under a blue sky.
  const sunColor = color(0xfff1dd).lerp(color(0xffb46e), lowSun).lerp(color(0xff7a36), twilight);
  let sunIntensity = (3.2 - lowSun * 0.3) * (1 - 0.45 * twilight);
  const hemiSky = color(0xc3d8ff)
    .lerp(color(0xf2cfae), lowSun * 0.6)
    .lerp(color(0x8aa0e0), twilight * 0.85);
  const hemiGround = color(theme.grass).multiplyScalar(0.6);
  // Dusk leans on the sky's light so the track stays readable.
  let hemiIntensity = 0.35 + lowSun * 0.15 + twilight * 0.75;
  let environmentIntensity = 0.55 + lowSun * 0.3 + twilight * 0.35;

  // Daylight under cloud: the deck is dimmer with a low sun, warmer at golden hour, bluer at dusk.
  const daylight = 0.4 + 0.6 * smooth(elevation, 0, 25);
  const tint = color(0xffffff)
    .lerp(color(0xffd9b8), lowSun * 0.35)
    .lerp(color(0xb9b3d6), twilight * 0.6);
  const horizon = color(DECK_HORIZON)
    .lerp(color(STORM_HORIZON), gloom)
    .multiply(tint)
    .multiplyScalar(daylight);
  const zenith = color(DECK_ZENITH)
    .lerp(color(STORM_ZENITH), gloom)
    .multiply(tint)
    .multiplyScalar(daylight);

  horizon.multiplyScalar(1 - 0.9 * night);
  zenith.multiplyScalar(1 - 0.94 * night);

  // Clouds dim and soften the sun; the sky's light takes over.
  sunIntensity *= (1 - 0.8 * cover) * (1 - 0.35 * gloom);
  sunColor.lerp(color(0xe6ecf4), closed * 0.7);
  hemiSky.lerp(color(0xdde3ea).multiply(tint), cover * 0.8);
  hemiIntensity += cover * 0.5 - gloom * 0.12;
  environmentIntensity += cover * 0.4 - gloom * 0.1;

  // The circuit's own fog, or the haze for the chosen sun with a little of the circuit's in it.
  const [away, toward] = ownSun ? [color(theme.fog), color(theme.fog)] : hazeAt(elevation);
  if (!ownSun) {
    away.lerp(color(theme.fog), 0.3);
    toward.lerp(color(theme.fog), 0.3 * (1 - twilight));
  }
  const greyFog = THREE.MathUtils.lerp(cover * 0.5, 1, closed);
  const fogColor = away.lerp(horizon, greyFog).lerp(color(0x06080f), night);
  const fogSunColor = toward.lerp(horizon, greyFog).lerp(color(0x0a0c16), night);
  hemiSky.lerp(color(0x141c3a), night);
  hemiGround.multiplyScalar(1 - 0.85 * night);

  const sunAzimuth = sun ? sun.azimuth : theme.sunAzimuth;
  const lightElevation = THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(Math.max(elevation, MIN_LIGHT_ELEVATION), 72, closed * 0.85),
    MOON_ELEVATION,
    night,
  );
  // Round to the moon's side as the night comes: its light is faint, so the swing is not seen.
  const lightAzimuth = sunAzimuth + 180 * night;

  return {
    sunElevation: elevation,
    sunAzimuth,
    lightElevation,
    lightAzimuth,
    lowSun,
    sky: {
      turbidity: 3.2 + lowSun * 4 + twilight * 2 + style.haze,
      rayleigh: 1.1 + lowSun * 0.9 + twilight * 1.2,
      mieCoefficient: 0.004 + lowSun * 0.004 + cover * 0.004,
      mieDirectionalG: 0.86,
      cloudCoverage: style.cloudCoverage,
      cloudDensity: style.cloudDensity,
      sunDisc: 1 - closed,
      overcast: THREE.MathUtils.lerp(cover * 0.3, 1, closed),
      horizon,
      zenith,
      mottle: 0.5 + gloom * 0.5,
      // The circuit's own look is unchanged; chosen conditions blend the horizon into the fog.
      haze: ownSun ? 0.85 * smooth(cover, 0, 0.1) : 0.85,
      twilight: twilight * (1 - closed),
      duskZenith: color(0x1d2f63).lerp(color(0x03040a), night),
    },
    sunColor: sunColor.lerp(color(0x8fa6ff), night),
    sunIntensity: sunIntensity * (1 - 0.9 * night),
    shadowRadius: 1 + cover * 3,
    shadowIntensity: 1 - cover * 0.45,
    hemiSky,
    hemiGround,
    hemiIntensity: hemiIntensity * (1 - 0.65 * night),
    environmentIntensity: environmentIntensity * (1 - 0.9 * night),
    fogColor,
    fogSunColor,
    fogNear: style.fogNear,
    fogFar: style.fogFar,
    wetness: moving
      ? THREE.MathUtils.lerp(wetness(conditions.weather), wetness(mix.to), blend)
      : wetness(conditions.weather),
    rain: style.rain,
    waterColor: horizon.clone().lerp(color(0xffffff), 0.25),
    night,
    cloud: cover,
  };
}
