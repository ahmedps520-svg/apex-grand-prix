import { describe, expect, it } from 'vitest';
import { cityMap, SIDEWALK } from '../../src/content/city/map';
import {
  CONE_BUDGET,
  JUNCTION_CLEAR,
  PROP_BUDGET,
  PROP_SPECS,
  cityPropPlacements,
  type PropKind,
} from '../../src/content/city/props';
import type { CarRenderState } from '../../src/render/interpolate';
import { Props } from '../../src/render/Props';
import { TEST_MULE } from '../../src/sim/vehicle/spec';

describe('street props', () => {
  const map = cityMap();
  const placements = cityPropPlacements(map);
  const furniture = placements.filter((p) => p.kind !== 'cone');
  const cones = placements.filter((p) => p.kind === 'cone');

  it('stands on the pavements, clear of the junctions, within its budget, the same every time', () => {
    expect(cones.length).toBeGreaterThan(100);
    expect(cones.length).toBeLessThanOrEqual(CONE_BUDGET);
    expect(furniture.length).toBeGreaterThan(300);
    expect(furniture.length).toBeLessThanOrEqual(PROP_BUDGET);
    const ground = ['street', 'avenue', 'port', 'suburb'] as const;
    for (const p of furniture) {
      const road = map.project(p.x, p.z, { maxDist: 30, kinds: [...ground] })!;
      expect(road).not.toBeNull();
      // Off the carriageway and on the pavement band beside it.
      expect(road.dist).toBeGreaterThan(road.piece.halfWidth + 0.5);
      expect(road.dist).toBeLessThan(road.piece.halfWidth + SIDEWALK + 0.6);
      for (const j of map.junctions) {
        expect(Math.hypot(j.x - p.x, j.z - p.z)).toBeGreaterThan(JUNCTION_CLEAR - 3.6);
      }
    }
    expect(cityPropPlacements(map)).toEqual(placements);
  });

  it('puts crates on the quays and bins downtown', () => {
    const kinds = (roadKind: string) => {
      const out = new Map<PropKind, number>();
      for (const p of furniture) {
        const road = map.project(p.x, p.z, {
          maxDist: 30,
          kinds: ['street', 'avenue', 'port', 'suburb'],
        })!;
        if (road.piece.road.kind !== roadKind) continue;
        out.set(p.kind, (out.get(p.kind) ?? 0) + 1);
      }
      return out;
    };
    const port = kinds('port');
    const street = kinds('street');
    expect(port.get('crate') ?? 0).toBeGreaterThan(port.get('bin') ?? 0);
    expect(street.get('bin') ?? 0).toBeGreaterThan(street.get('crate') ?? 0);
    for (const kind of Object.keys(PROP_SPECS) as PropKind[]) {
      expect(PROP_SPECS[kind].points).toBeGreaterThan(0);
      expect(PROP_SPECS[kind].heft).toBeGreaterThanOrEqual(1);
    }
  });

  it('sends a bin flying when the car drives through it, and puts it back later', () => {
    const props = new Props(
      [
        { kind: 'bin', x: 0, z: -10, y: 0, yaw: 0 },
        { kind: 'fence', x: 6, z: -10, y: 0, yaw: 0 },
      ],
      TEST_MULE.body,
    );
    expect(props.count).toBe(2);
    const knocked: PropKind[] = [];
    props.onKnock = (kind) => knocked.push(kind);
    const car = (z: number): CarRenderState =>
      ({
        pos: { x: 0, y: 0.5, z },
        rot: { x: 0, y: 0, z: 0, w: 1 },
        vel: { x: 0, y: 0, z: -12 },
        speed: 12,
      }) as unknown as CarRenderState;
    // Straight down the z axis (the car's forward is -z with an identity rotation).
    let z = 0;
    for (let i = 0; i < 60; i++) {
      z -= 12 / 60;
      props.update(1 / 60, car(z));
    }
    expect(knocked).toEqual(['bin']);
    expect(props.knocked).toBe(1);
    // It flies, lands and lies knocked over, then comes back.
    for (let i = 0; i < 60 * 3; i++) props.update(1 / 60, car(-40));
    expect(props.knocked).toBe(1);
    for (let i = 0; i < 60 * 6; i++) props.update(1 / 60, car(-40));
    expect(props.knocked).toBe(0);
    props.dispose();
  });
});
