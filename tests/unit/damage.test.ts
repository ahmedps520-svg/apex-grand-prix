import { describe, expect, it } from 'vitest';
import { trackById } from '../../src/content/tracks';
import { SIM_DT, defaultAids, neutralInput } from '../../src/shared/protocol';
import { AiDriver } from '../../src/sim/race/AiDriver';
import { computeRacingLine } from '../../src/sim/race/racingLine';
import { Track } from '../../src/sim/track/Track';
import { Car } from '../../src/sim/vehicle/car';
import { carById } from '../../src/sim/vehicle/cars';
import { lineOptionsFor } from '../../src/sim/world';

describe('damage', () => {
  const track = new Track(trackById('merriford-park')!);
  const model = carById('gt');

  it('a clean AI lap does no damage', () => {
    const car = new Car(model.spec, track.gridSlot(0), track);
    car.damageScale = 1;
    car.setAids({ ...defaultAids(), gearbox: 'auto' });
    const line = computeRacingLine(track, lineOptionsFor(model.spec, model.aiGrip));
    const ai = new AiDriver(track, line, { skill: 0.95, seed: 1 });
    for (let t = 0; t < 40; t += SIM_DT) {
      car.setInput(ai.drive(car, [car], SIM_DT));
      car.step(SIM_DT, track);
    }
    expect(car.damage.aero + car.damage.engine + Math.abs(car.damage.steering)).toBeLessThan(0.02);
  });

  it('driving into a barrier damages the front and bends the steering', () => {
    // On the grid, turned 50° towards the barrier on the right, so one corner hits first.
    const start = track.gridSlot(0);
    const car = new Car(model.spec, { ...start, yaw: start.yaw - (50 * Math.PI) / 180 }, track);
    car.damageScale = 1;
    car.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high' });
    car.setInput({ ...neutralInput(), throttle: 1 });
    for (let t = 0; t < 6; t += SIM_DT) car.step(SIM_DT, track);
    expect(car.isFinite()).toBe(true);
    expect(car.damage.aero).toBeGreaterThan(0.05);
    expect(Math.abs(car.damage.steering)).toBeGreaterThan(0.02);
  });

  it('does nothing when damage is off', () => {
    const start = track.gridSlot(0);
    const car = new Car(model.spec, { ...start, yaw: start.yaw - Math.PI / 2 }, track);
    car.setInput({ ...neutralInput(), throttle: 1 });
    for (let t = 0; t < 6; t += SIM_DT) car.step(SIM_DT, track);
    expect(car.damage.aero).toBe(0);
  });
});
