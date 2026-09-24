import { mulberry32 } from '../../shared/math';
import { SIDEWALK, type CityMap, type RoadKind } from './map';

/**
 * Smashable street props for the arcade festival: cones on the junction corners, and bins,
 * bollards, crates and fence panels along the pavements, placed by the map (seeded, so the
 * same city has the same street furniture). Pure data: the renderer draws them and sends them
 * flying, the skill system scores them.
 */

export type PropKind = 'cone' | 'bin' | 'bollard' | 'crate' | 'fence';
export type PropSound = 'plastic' | 'wood' | 'metal';

export interface PropSpec {
  /** Footprint radius and height, m: the car's footprint has to reach them. */
  radius: number;
  height: number;
  /** Skill points for a hit, and the label that comes up. */
  points: number;
  label: string;
  /** How much of the car's speed it takes with it: 1 flies like a cone, 3 barely lifts. */
  heft: number;
  sound: PropSound;
}

export const PROP_SPECS: Readonly<Record<PropKind, PropSpec>> = {
  cone: { radius: 0.2, height: 0.58, points: 25, label: 'CONE', heft: 1, sound: 'plastic' },
  bin: { radius: 0.34, height: 0.96, points: 40, label: 'BIN', heft: 1.4, sound: 'plastic' },
  bollard: { radius: 0.1, height: 0.92, points: 50, label: 'BOLLARD', heft: 2.2, sound: 'metal' },
  crate: { radius: 0.42, height: 0.62, points: 60, label: 'CRATE', heft: 1.8, sound: 'wood' },
  fence: { radius: 0.9, height: 1.05, points: 80, label: 'FENCE', heft: 2.6, sound: 'metal' },
};

export interface PropPlacement {
  kind: PropKind;
  x: number;
  z: number;
  /** Ground height there. */
  y: number;
  yaw: number;
}

/** What stands beside each kind of road, with its share. */
const KIND_MIX: Partial<Record<RoadKind, ReadonlyArray<readonly [PropKind, number]>>> = {
  street: [
    ['bin', 0.55],
    ['bollard', 0.3],
    ['crate', 0.15],
  ],
  avenue: [
    ['bin', 0.5],
    ['bollard', 0.35],
    ['crate', 0.15],
  ],
  port: [
    ['crate', 0.6],
    ['bollard', 0.25],
    ['fence', 0.15],
  ],
  suburb: [
    ['bin', 0.5],
    ['fence', 0.5],
  ],
};

/** Along the pavements: one prop about every so many metres, clear of the junctions. */
export const PROP_SPACING = 22;
export const JUNCTION_CLEAR = 11;
/** At most this many cones, and this many other props (each kind is one instanced draw). */
export const CONE_BUDGET = 480;
export const PROP_BUDGET = 1100;

function pick(mix: ReadonlyArray<readonly [PropKind, number]>, r: number): PropKind {
  let acc = 0;
  for (const [kind, share] of mix) {
    acc += share;
    if (r < acc) return kind;
  }
  return mix[mix.length - 1]![0];
}

/** How far from the kerb each kind stands (fences at the back of the pavement). */
function inset(kind: PropKind): number {
  return kind === 'fence' ? SIDEWALK - 0.5 : kind === 'crate' ? 1.8 : 0.85;
}

/** Cones on the corners of the flat junctions, and the street furniture along the pavements. */
export function cityPropPlacements(map: CityMap, seed = 7): PropPlacement[] {
  const out: PropPlacement[] = [];
  let cones = 0;
  for (const j of map.junctions) {
    if (j.control === 'none' || Math.abs(map.groundHeight(j.x, j.z)) > 0.05) continue;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        out.push({ kind: 'cone', x: j.x + sx * 7.5, z: j.z + sz * 7.5, y: 0, yaw: 0 });
      }
    }
    cones += 4;
    if (cones >= CONE_BUDGET) break;
  }
  const rand = mulberry32(seed);
  const junctions = map.junctions;
  const nearJunction = (x: number, z: number) => {
    for (const j of junctions) {
      const dx = j.x - x;
      const dz = j.z - z;
      if (dx * dx + dz * dz < JUNCTION_CLEAR * JUNCTION_CLEAR) return true;
    }
    return false;
  };
  // Every candidate spot first, then an even share of them, so every part of the map gets
  // its furniture whatever the budget.
  const candidates: PropPlacement[] = [];
  for (const piece of map.pieces) {
    const mix = KIND_MIX[piece.road.kind];
    if (!mix) continue;
    const nx = -piece.tz;
    const nz = piece.tx;
    for (
      let s = PROP_SPACING * (0.4 + rand() * 0.6);
      s < piece.len - 4;
      s += PROP_SPACING * (0.8 + rand() * 0.5)
    ) {
      const t = s / piece.len;
      const x0 = piece.ax + piece.tx * s;
      const z0 = piece.az + piece.tz * s;
      if (nearJunction(x0, z0)) continue;
      const side = rand() < 0.5 ? -1 : 1;
      const kind = pick(mix, rand());
      const d = piece.halfWidth + inset(kind);
      // Fences run along the road; the rest stand any way round.
      const yaw = kind === 'fence' ? Math.atan2(-piece.tz, piece.tx) : rand() * Math.PI * 2;
      candidates.push({
        kind,
        x: x0 + nx * side * d,
        z: z0 + nz * side * d,
        y: piece.ay + (piece.by - piece.ay) * t,
        yaw,
      });
    }
  }
  const n = candidates.length;
  if (n <= PROP_BUDGET) return out.concat(candidates);
  for (let i = 0; i < n; i++) {
    const slot = Math.floor((i * PROP_BUDGET) / n);
    const prev = Math.floor(((i - 1) * PROP_BUDGET) / n);
    if (i === 0 || slot !== prev) out.push(candidates[i]!);
  }
  return out;
}
