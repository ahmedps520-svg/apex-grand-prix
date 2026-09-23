import { describe, expect, it } from 'vitest';
import { SIM_DT, defaultAids, neutralInput, type SessionConfig } from '../../src/shared/protocol';
import { World } from '../../src/sim/world';

const config = (): SessionConfig => ({
  mode: 'roam',
  trackId: '',
  carId: 'gt',
  location: 'loop',
  roamStart: 'downtown',
  traffic: 6,
  police: 4,
  opponents: 0,
  laps: 0,
  difficulty: 'medium',
  gridSlot: 0,
  aids: defaultAids(),
  seed: 11,
  conditions: { time: 'midday', weather: 'clear' },
});

const run = (world: World, seconds: number, each?: () => void) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) {
    world.step(SIM_DT);
    if (each && i % 40 === 0) each();
  }
};

/** Parks a patrol car right beside the player so it can see everything. */
function witness(world: World): void {
  const player = world.cars[0]!;
  const unit = world.traffic!.vehicles.find((v) => v.police)!;
  unit.active = true;
  unit.mode = 'block';
  unit.x = player.pos.x + 6;
  unit.z = player.pos.z + 20;
  unit.y = 0.5;
}

describe('traffic and the police', () => {
  it('pulls over and stops for a siren close by', () => {
    const world = World.forSession(config());
    // The siren is worked by hand here, not by the police module (which would clear it).
    world.police = null;
    const player = world.cars[0]!;
    run(world, 2);
    const traffic = world.traffic!;
    const car = traffic.vehicles.find(
      (v) =>
        v.active &&
        !v.police &&
        v.mode === 'lane' &&
        Math.hypot(v.x - player.pos.x, v.z - player.pos.z) < 300,
    )!;
    expect(car).toBeDefined();
    // A unit parked with its siren on, 20 m from it.
    const unit = traffic.vehicles.find((v) => v.police)!;
    unit.active = true;
    unit.mode = 'block';
    unit.siren = true;
    const follow = () => {
      unit.x = car.x + 15;
      unit.z = car.z + 12;
      unit.y = car.y;
    };
    follow();
    run(world, 4, follow);
    expect(car.active).toBe(true);
    expect(car.pullOver).toBeGreaterThan(0.9);
    expect(car.v).toBeLessThan(2.5);
    // Off the lane's centre, to the right.
    const p = traffic.graph.pointAt(car.link, car.s, { x: 0, z: 0, y: 0, tx: 0, tz: 0 });
    const right = (car.x - p.x) * -p.tz + (car.z - p.z) * p.tx;
    expect(right).toBeGreaterThan(1.2);
    // The siren gone, it eases back and drives on.
    unit.siren = false;
    unit.active = false;
    run(world, 4);
    expect(car.pullOver).toBe(0);
  });
});

describe('traffic and the horn', () => {
  it('pulls over for the player leaning on the horn right behind', () => {
    const world = World.forSession(config());
    world.police = null;
    const player = world.cars[0]!;
    run(world, 2);
    const traffic = world.traffic!;
    const car = traffic.vehicles.find(
      (v) => v.active && !v.police && !v.racer && v.mode === 'lane' && v.s > 40,
    )!;
    expect(car).toBeDefined();
    // Sat in its lane 15 m behind it, on the horn, going nowhere.
    const point = { x: 0, z: 0, y: 0, tx: 0, tz: 0 };
    const behind = () => {
      traffic.graph.pointAt(car.link, Math.max(car.s - 15, 0), point);
      player.pos.x = point.x;
      player.pos.z = point.z;
      player.vel.x = 0;
      player.vel.z = 0;
    };
    behind();
    player.setInput({ ...neutralInput(), horn: true });
    run(world, 4, behind);
    expect(player.horn).toBe(true);
    expect(car.pullOver).toBeGreaterThan(0.9);
    expect(car.v).toBeLessThan(2.5);
    // Horn off: it eases back and drives on.
    player.setInput(neutralInput());
    run(world, 4, behind);
    expect(car.pullOver).toBe(0);
  });
});

describe('police', () => {
  it('starts clear with patrol cars and no fine', () => {
    const world = World.forSession(config());
    expect(world.police).not.toBeNull();
    expect(world.snapshotCount).toBe(11);
    run(world, 2);
    const status = world.police!.status;
    expect(status.heat).toBe(0);
    expect(status.state).toBe('clear');
    const units = world.traffic!.vehicles.filter((v) => v.police);
    expect(units.length).toBe(4);
    expect(units.filter((u) => u.active).length).toBeGreaterThan(0);
    expect(units.every((u) => !u.siren)).toBe(true);
  });

  it('raises the heat for speeding in sight of a patrol car, then gives chase with sirens', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    witness(world);
    // 120 km/h down a 60 km/h avenue, held by force.
    run(world, 4, () => {
      player.vel.x = 0;
      player.vel.z = -120 / 3.6;
      player.pos.z = 380;
    });
    const status = world.police!.status;
    expect(status.heat).toBeGreaterThanOrEqual(1);
    expect(status.state).toBe('pursuit');
    expect(status.fine).toBeGreaterThan(0);
    const chasing = world.traffic!.vehicles.filter((v) => v.police && v.siren);
    expect(chasing.length).toBeGreaterThan(0);
  });

  it('lets sanctioned speeding go (a festival event), but not a crash', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    witness(world);
    world.police!.sanctioned = true;
    run(world, 4, () => {
      player.vel.x = 0;
      player.vel.z = -120 / 3.6;
      player.pos.z = 380;
    });
    expect(world.police!.status.heat).toBe(0);
    expect(world.police!.status.state).toBe('clear');
    // A crash into the traffic is still an offence.
    world.traffic!.playerHits++;
    run(world, 0.2, () => {
      player.vel.z = 0;
      player.pos.z = 380;
    });
    expect(world.police!.status.heat).toBe(1);
  });

  it('busts a player who stops next to a police car, and charges the fine', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    witness(world);
    run(world, 4, () => {
      player.vel.z = -120 / 3.6;
      player.pos.z = 380;
    });
    expect(world.police!.status.heat).toBeGreaterThan(0);
    const owed = world.police!.status.fine;
    // Now stop dead beside the parked unit.
    const unit = world.traffic!.vehicles.find((v) => v.police)!;
    run(world, 5, () => {
      player.vel.x = 0;
      player.vel.z = 0;
      player.pos.x = unit.x - 4;
      player.pos.z = unit.z;
    });
    const status = world.police!.status;
    expect(status.state).toBe('busted');
    expect(status.heat).toBe(0);
    expect(status.fines).toBe(owed);
  });

  it('comes to a player who pulls over in the open, and busts them', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    witness(world);
    run(world, 4, () => {
      player.vel.x = 0;
      player.vel.z = -120 / 3.6;
      player.pos.z = 380;
    });
    expect(world.police!.status.state).toBe('pursuit');
    // Pull over on the avenue and wait: a unit closes in, stops behind, and that is that
    // (the bust needs a unit within 14 m; afterwards the units go back to their patrols).
    const outcomes: string[] = [];
    run(world, 75, () => {
      player.vel.x = 0;
      player.vel.z = 0;
      player.pos.x = 5.4;
      player.pos.z = 380;
      outcomes.push(world.police!.status.state);
    });
    expect(outcomes).toContain('busted');
    expect(world.police!.status.fines).toBeGreaterThan(0);
  });

  it('lets a player who stays out of sight get away', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    witness(world);
    run(world, 4, () => {
      player.vel.z = -120 / 3.6;
      player.pos.z = 380;
    });
    expect(world.police!.status.heat).toBeGreaterThan(0);
    // Far from everyone, standing still (no unit can reach or see). Escaped after 14 s unseen,
    // shown for a few seconds before the state reads clear again.
    run(world, 16, () => {
      player.pos.x = -1400;
      player.pos.z = 1400;
      player.vel.x = 0;
      player.vel.z = 0;
    });
    expect(world.police!.status.state).toBe('escaped');
    expect(world.police!.status.heat).toBe(0);
  });

  it('bursts a tyre on a spike strip', () => {
    const world = World.forSession(config());
    const player = world.cars[0]!;
    world.police!.status.heat = 4;
    world.police!.status.state = 'pursuit';
    // Lay a strip right under the front axle.
    const y = player.pos.z - player.spec.body.front;
    world.police!.status.strips.push([player.pos.x - 3, y, player.pos.x + 3, y]);
    run(world, 0.2);
    expect(player.tyresBurst).toBe(true);
    expect(world.police!.status.strips.length).toBe(0);
  });
});
