import { describe, expect, it } from 'vitest';
import {
  LaneGraph,
  SIGNAL_CYCLE,
  SIGNAL_GREEN,
  laneGraph,
  signalState,
  type LaneLink,
} from '../../src/content/city/lanes';
import { cityMap } from '../../src/content/city/map';

describe('lane graph', () => {
  const graph = laneGraph(cityMap());

  it('builds lanes for every road but the circuit, with turn connectors at the junctions', () => {
    expect(graph.links.length).toBeGreaterThan(500);
    expect(graph.nodes.length).toBeGreaterThan(100);
    const lanes = graph.links.filter((l) => l.kind === 'lane');
    const turns = graph.links.filter((l) => l.kind === 'turn');
    expect(turns.length).toBeGreaterThan(lanes.length);
    expect(lanes.some((l) => l.road?.kind === 'circuit')).toBe(false);
    for (const link of graph.links) {
      expect(link.length).toBeGreaterThan(0);
      expect(link.points.length).toBe(link.heights.length * 2);
      for (const v of [...link.points, ...link.heights]) expect(Number.isFinite(v)).toBe(true);
    }
    // Avenues have two lanes each way, streets one.
    const avenue = lanes.filter((l) => l.road?.kind === 'avenue');
    expect(new Set(avenue.map((l) => l.lane))).toEqual(new Set([0, 1]));
  });

  it('gives every lane that ends at a junction somewhere to go, and connectors are short', () => {
    for (const link of graph.links) {
      if (link.kind === 'lane' && link.to >= 0)
        expect(link.next.length, `link ${link.id}`).toBeGreaterThan(0);
      if (link.kind === 'turn') {
        expect(link.length).toBeLessThan(90);
        expect(link.next.length).toBe(1);
      }
    }
  });

  it('keeps right-hand traffic: a forward lane sits to the right of its road', () => {
    const road = cityMap().roads.find((r) => r.kind === 'street' && r.points[0] === r.points[2])!;
    // A north–south street (constant x): its southbound lane is on the west (-x) side… no:
    // driving south (+z), the right-hand side is -x.
    const south = graph.links.find(
      (l) => l.road === road && l.kind === 'lane' && l.points[3]! > l.points[1]!,
    )!;
    expect(south.points[0]!).toBeLessThan(road.points[0]!);
    const north = graph.links.find(
      (l) => l.road === road && l.kind === 'lane' && l.points[3]! < l.points[1]!,
    )!;
    expect(north.points[0]!).toBeGreaterThan(road.points[0]!);
  });

  it('controls the approaches: signals downtown, the minor road stops, ramps merge freely', () => {
    const signalled = graph.links.filter((l) => l.control === 'signal');
    expect(signalled.length).toBeGreaterThan(50);
    const streetStops = graph.links.filter(
      (l) => l.kind === 'lane' && l.road?.kind === 'street' && l.control === 'stop',
    );
    expect(streetStops.length).toBeGreaterThan(10);
    const avenueStops = graph.links.filter(
      (l) => l.kind === 'lane' && l.road?.kind === 'avenue' && l.control === 'stop',
    );
    expect(avenueStops.length).toBe(0);
    const ramps = graph.links.filter((l) => l.kind === 'lane' && l.road?.kind === 'ramp');
    expect(ramps.length).toBe(16);
    // Every ramp joins something: the orbital at one end, the avenue at the other.
    for (const ramp of ramps)
      expect(ramp.next.length + (ramp.from >= 0 ? 1 : 0)).toBeGreaterThan(0);
    const merges = graph.nodes.filter((n) => n.merge);
    expect(merges.length).toBe(16);
  });

  it('reaches the orbital from downtown and the suburbs from the orbital', () => {
    const reach = (from: LaneLink, want: (l: LaneLink) => boolean, hops: number): boolean => {
      const seen = new Set<number>();
      let frontier = [from];
      for (let i = 0; i < hops; i++) {
        const next: LaneLink[] = [];
        for (const l of frontier) {
          if (want(l)) return true;
          for (const n of l.next) {
            if (seen.has(n.id)) continue;
            seen.add(n.id);
            next.push(n);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      return false;
    };
    const downtown = graph.links.find(
      (l) => l.kind === 'lane' && l.road?.kind === 'avenue' && Math.abs(l.points[0]!) < 30,
    )!;
    expect(reach(downtown, (l) => l.road?.kind === 'highway', 60)).toBe(true);
    const orbital = graph.links.find((l) => l.kind === 'lane' && l.road?.kind === 'highway')!;
    expect(reach(orbital, (l) => l.road?.kind === 'suburb', 80)).toBe(true);
  });

  it('samples points along a link', () => {
    const link = graph.links.find((l) => l.kind === 'lane' && l.length > 50)!;
    const p = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
    graph.pointAt(link, 0, p);
    expect(p.x).toBeCloseTo(link.points[0]!, 5);
    graph.pointAt(link, link.length, p);
    expect(p.x).toBeCloseTo(link.points[link.points.length - 2]!, 5);
    expect(Math.hypot(p.tx, p.tz)).toBeCloseTo(1, 5);
    expect(graph.linksNear(0, 0, 150).length).toBeGreaterThan(4);
  });

  it('cycles the signals: one axis green while the other is red, never both green', () => {
    const node = { x: 0, z: 0 };
    let greens = 0;
    for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) {
      const a = signalState(node, 0, t);
      const b = signalState(node, 1, t);
      expect(a === 'green' && b === 'green').toBe(false);
      if (a === 'green' || b === 'green') greens++;
    }
    expect(greens).toBeGreaterThan((2 * SIGNAL_GREEN) / 0.5 - 4);
    expect(new LaneGraph(cityMap()).links.length).toBe(graph.links.length);
  });
});
