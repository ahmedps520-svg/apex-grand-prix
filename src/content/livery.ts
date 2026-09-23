import { PAINTS } from './paints';

/**
 * Car liveries: three colours, a pattern, a race number and a paint finish. Plain data, so they
 * save with the settings and can be generated for the AI field; `render/liveryMaterial.ts` turns
 * one into a paint shader.
 */

export type LiveryPattern =
  'solid' | 'stripes' | 'halves' | 'chevron' | 'fade' | 'hoops' | 'sides' | 'number';

export const LIVERY_PATTERNS: ReadonlyArray<{ value: LiveryPattern; text: string }> = [
  { value: 'solid', text: 'Solid' },
  { value: 'stripes', text: 'Twin stripes' },
  { value: 'halves', text: 'Halves' },
  { value: 'chevron', text: 'Chevron' },
  { value: 'fade', text: 'Fade' },
  { value: 'hoops', text: 'Hoops' },
  { value: 'sides', text: 'Side split' },
  { value: 'number', text: 'Number panels' },
];

export type LiveryFinish = 'gloss' | 'matte' | 'metallic' | 'pearl';

export const LIVERY_FINISHES: ReadonlyArray<{ value: LiveryFinish; text: string }> = [
  { value: 'gloss', text: 'Gloss' },
  { value: 'matte', text: 'Matte' },
  { value: 'metallic', text: 'Metallic' },
  { value: 'pearl', text: 'Pearl' },
];

/**
 * What a car looks like. The primary colour covers most of the body, the secondary fills the
 * pattern, and the accent draws pinstripes along the pattern's edges and trims the number.
 */
export interface Livery {
  primary: number;
  secondary: number;
  accent: number;
  pattern: LiveryPattern;
  /** Race number, 1–99. */
  number: number;
  finish: LiveryFinish;
}

/** Colour families, used to keep random colour schemes harmonious. */
type Family =
  | 'white'
  | 'grey'
  | 'black'
  | 'red'
  | 'orange'
  | 'yellow'
  | 'gold'
  | 'brown'
  | 'green'
  | 'teal'
  | 'blue'
  | 'purple'
  | 'pink';

const WHITE = 0xf5f5f5;
const BLACK = 0x1c1c1c;

/** Families of every paint in PAINTS plus the livery-only colours, keyed by hex. */
const EXTRA_COLOURS: ReadonlyArray<{ name: string; hex: number; family: Family }> = [
  { name: 'White', hex: WHITE, family: 'white' },
  { name: 'Ivory', hex: 0xece2c6, family: 'white' },
  { name: 'Gunmetal', hex: 0x3b4149, family: 'grey' },
  { name: 'Scarlet', hex: 0xd8231c, family: 'red' },
  { name: 'Burgundy', hex: 0x611024, family: 'red' },
  { name: 'Gold', hex: 0xc9a13c, family: 'gold' },
  { name: 'Bronze', hex: 0x8c5a2b, family: 'brown' },
  { name: 'Lime', hex: 0x8cc63f, family: 'green' },
  { name: 'Emerald', hex: 0x119c55, family: 'green' },
  { name: 'Sky blue', hex: 0x6db5e2, family: 'blue' },
  { name: 'Plum', hex: 0x55246f, family: 'purple' },
  { name: 'Flamingo', hex: 0xf27bb3, family: 'pink' },
];

const PAINT_FAMILIES: Readonly<Record<string, Family>> = {
  'Racing red': 'red',
  'Midnight blue': 'blue',
  'Electric blue': 'blue',
  'Signal yellow': 'yellow',
  'Racing green': 'green',
  Papaya: 'orange',
  Violet: 'purple',
  'Pearl white': 'white',
  'Carbon black': 'black',
  'Hot pink': 'pink',
  Silver: 'grey',
  Teal: 'teal',
};

/** Display order of the families: neutrals first, then round the colour wheel. */
const FAMILY_ORDER: readonly Family[] = [
  'white',
  'grey',
  'black',
  'red',
  'orange',
  'yellow',
  'gold',
  'brown',
  'green',
  'teal',
  'blue',
  'purple',
  'pink',
];

interface Swatch {
  name: string;
  hex: number;
  family: Family;
}

const SWATCHES: readonly Swatch[] = [
  ...PAINTS.map((p) => ({ ...p, family: PAINT_FAMILIES[p.name] ?? familyOf(p.hex) })),
  ...EXTRA_COLOURS,
]
  .map((s, i) => ({ s, i }))
  .sort(
    (a, b) =>
      FAMILY_ORDER.indexOf(a.s.family) - FAMILY_ORDER.indexOf(b.s.family) ||
      oklab(b.s.hex)[0] - oklab(a.s.hex)[0] ||
      a.i - b.i,
  )
  .map(({ s }) => s);

/** The livery palette: every player paint plus livery colours, light to dark by colour family. */
export const LIVERY_COLOURS: ReadonlyArray<{ name: string; hex: number }> = SWATCHES.map(
  ({ name, hex }) => ({ name, hex }),
);

/** Name of a palette colour, or null for any other colour. */
export function colourName(hex: number): string | null {
  return LIVERY_COLOURS.find((c) => c.hex === hex)?.name ?? null;
}

export const defaultLivery = (): Livery => ({
  primary: 0xa3101f,
  secondary: WHITE,
  accent: BLACK,
  pattern: 'stripes',
  number: 7,
  finish: 'gloss',
});

/** Named, fictional liveries in the style of famous racing colour schemes. */
export const LIVERY_PRESETS: ReadonlyArray<{ name: string; livery: Livery }> = [
  {
    name: 'Lagoon',
    livery: {
      primary: 0x6db5e2,
      secondary: 0xf07f13,
      accent: 0x14306b,
      pattern: 'stripes',
      number: 9,
      finish: 'gloss',
    },
  },
  {
    name: 'Heritage',
    livery: {
      primary: 0x1d5e3a,
      secondary: 0xece2c6,
      accent: 0xc9a13c,
      pattern: 'number',
      number: 5,
      finish: 'gloss',
    },
  },
  {
    name: 'Rosso Corsa',
    livery: {
      primary: 0xd8231c,
      secondary: WHITE,
      accent: 0xf2b705,
      pattern: 'number',
      number: 27,
      finish: 'gloss',
    },
  },
  {
    name: 'Arrowhead',
    livery: {
      primary: WHITE,
      secondary: 0xd8231c,
      accent: BLACK,
      pattern: 'chevron',
      number: 1,
      finish: 'gloss',
    },
  },
  {
    name: 'Papaya Works',
    livery: {
      primary: 0xf07f13,
      secondary: 0x14306b,
      accent: WHITE,
      pattern: 'halves',
      number: 4,
      finish: 'gloss',
    },
  },
  {
    name: 'Silver Arrow',
    livery: {
      primary: 0x9e9e9e,
      secondary: BLACK,
      accent: 0x10a7b8,
      pattern: 'fade',
      number: 44,
      finish: 'metallic',
    },
  },
  {
    name: 'Black & Gold',
    livery: {
      primary: BLACK,
      secondary: BLACK,
      accent: 0xc9a13c,
      pattern: 'sides',
      number: 12,
      finish: 'gloss',
    },
  },
  {
    name: 'Riviera',
    livery: {
      primary: WHITE,
      secondary: 0x14306b,
      accent: 0xd8231c,
      pattern: 'sides',
      number: 3,
      finish: 'gloss',
    },
  },
  {
    name: 'Hornet',
    livery: {
      primary: 0xf2b705,
      secondary: BLACK,
      accent: WHITE,
      pattern: 'hoops',
      number: 19,
      finish: 'gloss',
    },
  },
  {
    name: 'Solaris',
    livery: {
      primary: 0xf2b705,
      secondary: 0xd8231c,
      accent: BLACK,
      pattern: 'fade',
      number: 11,
      finish: 'pearl',
    },
  },
  {
    name: 'Nightshade',
    livery: {
      primary: BLACK,
      secondary: 0x8cc63f,
      accent: 0x8cc63f,
      pattern: 'chevron',
      number: 66,
      finish: 'matte',
    },
  },
  {
    name: 'Flamingo',
    livery: {
      primary: 0xf27bb3,
      secondary: 0x14306b,
      accent: WHITE,
      pattern: 'halves',
      number: 18,
      finish: 'pearl',
    },
  },
];

/** True when two liveries look the same apart from the race number. */
export function sameDesign(a: Livery, b: Livery): boolean {
  return (
    a.primary === b.primary &&
    a.secondary === b.secondary &&
    a.accent === b.accent &&
    a.pattern === b.pattern &&
    a.finish === b.finish
  );
}

const isColour = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffff;

/** Checks a stored livery, repairing anything missing or invalid. */
export function sanitizeLivery(raw: unknown): Livery {
  const d = defaultLivery();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Partial<Record<keyof Livery, unknown>>;
  const number =
    typeof r.number === 'number' && Number.isFinite(r.number)
      ? Math.min(Math.max(Math.round(r.number), 1), 99)
      : d.number;
  return {
    primary: isColour(r.primary) ? r.primary : d.primary,
    secondary: isColour(r.secondary) ? r.secondary : d.secondary,
    accent: isColour(r.accent) ? r.accent : d.accent,
    pattern: LIVERY_PATTERNS.some((p) => p.value === r.pattern)
      ? (r.pattern as LiveryPattern)
      : d.pattern,
    number,
    finish: LIVERY_FINISHES.some((f) => f.value === r.finish)
      ? (r.finish as LiveryFinish)
      : d.finish,
  };
}

// ------------------------------------------------------------------ colour maths

/** OKLab coordinates [L, a, b] of an sRGB hex colour. */
function oklab(hex: number): [number, number, number] {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((hex >> 16) & 255);
  const g = lin((hex >> 8) & 255);
  const b = lin(hex & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceptual difference between two colours (OKLab distance: 0 = same, ~0.1 = clearly different). */
export function colourDifference(a: number, b: number): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** Relative luminance (WCAG), 0 = black … 1 = white. */
function luminance(hex: number): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((hex >> 16) & 255) + 0.7152 * lin((hex >> 8) & 255) + 0.0722 * lin(hex & 255);
}

/** Near-black or white, whichever reads better on `hex`. */
export function inkOn(hex: number): number {
  const l = luminance(hex);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? 0x111111 : 0xffffff;
}

/** Family of a colour outside the palette, from its hue and chroma. */
function familyOf(hex: number): Family {
  const [l, a, b] = oklab(hex);
  const chroma = Math.hypot(a, b);
  if (chroma < 0.035) return l > 0.8 ? 'white' : l > 0.35 ? 'grey' : 'black';
  const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  if (hue < 15 || hue >= 345) return 'pink';
  if (hue < 45) return 'red';
  if (hue < 70) return l > 0.6 ? 'orange' : 'brown';
  if (hue < 100) return l > 0.75 ? 'yellow' : 'gold';
  if (hue < 160) return 'green';
  if (hue < 215) return 'teal';
  if (hue < 280) return 'blue';
  return 'purple';
}

/** The number's roundel (fill), its thin outline (ring) and the digits (ink). */
export interface NumberColours {
  fill: number;
  ring: number;
  ink: number;
}

/**
 * Colours for the race number. Number panels use the secondary colour; the small roundels of
 * the other patterns are white (or the accent, or black, on a light car) so they always stand out
 * from the paint around them. The ring uses the accent where it shows.
 */
export function numberColours(livery: Livery): NumberColours {
  const body = livery.pattern === 'sides' ? livery.secondary : livery.primary;
  const stands = (hex: number): boolean => colourDifference(hex, body) > 0.22;
  let fill: number;
  if (livery.pattern === 'number' && stands(livery.secondary)) fill = livery.secondary;
  else if (stands(WHITE)) fill = WHITE;
  else if (stands(livery.accent)) fill = livery.accent;
  else fill = BLACK;
  const ink = inkOn(fill);
  const ring = colourDifference(livery.accent, fill) > 0.12 ? livery.accent : ink;
  return { fill, ring, ink };
}

// ------------------------------------------------------------------ random liveries

/** Chromatic family pairs that look good together (neutrals go with anything). */
const HARMONIES: ReadonlyArray<readonly [Family, Family]> = [
  ['red', 'yellow'],
  ['red', 'gold'],
  ['red', 'blue'],
  ['orange', 'blue'],
  ['orange', 'teal'],
  ['yellow', 'blue'],
  ['yellow', 'green'],
  ['yellow', 'purple'],
  ['gold', 'blue'],
  ['gold', 'green'],
  ['gold', 'purple'],
  ['brown', 'blue'],
  ['brown', 'teal'],
  ['brown', 'green'],
  ['green', 'green'],
  ['teal', 'pink'],
  ['teal', 'blue'],
  ['blue', 'blue'],
  ['blue', 'pink'],
  ['purple', 'green'],
];

const NEUTRAL: ReadonlySet<Family> = new Set(['white', 'grey', 'black']);

function harmonious(a: Swatch, b: Swatch): boolean {
  if (NEUTRAL.has(a.family) || NEUTRAL.has(b.family)) return true;
  // Lime with plum or violet works; darker greens with purple don't.
  if (a.family === 'purple' || b.family === 'purple') {
    const other = a.family === 'purple' ? b : a;
    if (other.family === 'green' && other.name !== 'Lime') return false;
  }
  return HARMONIES.some(
    ([x, y]) => (a.family === x && b.family === y) || (a.family === y && b.family === x),
  );
}

function pick<T>(rand: () => number, items: ReadonlyArray<{ item: T; weight: number }>): T {
  const total = items.reduce((sum, i) => sum + i.weight, 0);
  let r = rand() * total;
  for (const i of items) {
    r -= i.weight;
    if (r < 0) return i.item;
  }
  return items[items.length - 1]!.item;
}

const PATTERN_WEIGHTS: ReadonlyArray<{ item: LiveryPattern; weight: number }> = [
  { item: 'solid', weight: 1 },
  { item: 'stripes', weight: 3 },
  { item: 'halves', weight: 2 },
  { item: 'chevron', weight: 2 },
  { item: 'fade', weight: 2 },
  { item: 'hoops', weight: 2 },
  { item: 'sides', weight: 3 },
  { item: 'number', weight: 2 },
];

const FINISH_WEIGHTS: ReadonlyArray<{ item: LiveryFinish; weight: number }> = [
  { item: 'gloss', weight: 11 },
  { item: 'metallic', weight: 4 },
  { item: 'matte', weight: 3 },
  { item: 'pearl', weight: 2 },
];

/**
 * A random livery with a harmonious colour scheme: the secondary colour contrasts clearly
 * with the primary and comes from a matching colour family, and the accent stands out from
 * both. `rand` returns numbers in [0, 1), like Math.random or a seeded generator. With `avoid`
 * (say, the player's livery) the primary colour is clearly different from its primary.
 */
export function randomLivery(rand: () => number, avoid?: Livery): Livery {
  const primaries = avoid
    ? SWATCHES.filter((s) => colourDifference(s.hex, avoid.primary) > 0.15)
    : SWATCHES;
  const primary = pick(
    rand,
    primaries.map((s) => ({ item: s, weight: NEUTRAL.has(s.family) ? 2 : 3 })),
  );
  const secondaries = SWATCHES.filter(
    (s) => s !== primary && harmonious(primary, s) && colourDifference(s.hex, primary.hex) > 0.2,
  );
  // Each neutral partner is a little likelier than each colour; colour pairs still win overall.
  const secondary = pick(
    rand,
    secondaries.map((s) => ({ item: s, weight: NEUTRAL.has(s.family) ? 2 : 1.5 })),
  );
  const accents = SWATCHES.filter(
    (s) =>
      s !== primary &&
      s !== secondary &&
      harmonious(primary, s) &&
      harmonious(secondary, s) &&
      colourDifference(s.hex, primary.hex) > 0.15 &&
      colourDifference(s.hex, secondary.hex) > 0.12,
  );
  const accent =
    accents.length > 0
      ? pick(
          rand,
          accents.map((s) => ({
            item: s.hex,
            weight: NEUTRAL.has(s.family) ? 3 : s.family === 'gold' ? 2 : 1,
          })),
        )
      : inkOn(primary.hex) === 0xffffff
        ? WHITE
        : BLACK;
  return {
    primary: primary.hex,
    secondary: secondary.hex,
    accent,
    pattern: pick(rand, PATTERN_WEIGHTS),
    number: 1 + Math.floor(rand() * 99),
    finish: pick(rand, FINISH_WEIGHTS),
  };
}
