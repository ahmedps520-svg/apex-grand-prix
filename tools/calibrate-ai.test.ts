import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { trackById } from '../src/content/tracks';
import { SIM_DT, defaultAids } from '../src/shared/protocol';
import { AiDriver } from '../src/sim/race/AiDriver';
import { computeRacingLine } from '../src/sim/race/racingLine';
import { Track } from '../src/sim/track/Track';
import { Car } from '../src/sim/vehicle/car';
import { CARS, type CarModel } from '../src/sim/vehicle/cars';
import { lineOptionsFor } from '../src/sim/world';

/**
 * Measures `aiGrip` for every car: the largest share of its estimated grip the AI's racing
 * line can plan with while a flat-out AI (skill 1.01) laps five circuits without leaving the
 * road. Writes the table for AI_GRIP in src/sim/vehicle/cars.ts to tools/ai-grip.txt. Takes about 20 minutes for
 * every car (about a minute a car):
 *
 *   npx vitest run -c tools/vitest.config.ts
 *   CARS=suv,suv-trx npx vitest run -c tools/vitest.config.ts
 */

const TRACK_IDS = ['merriford-park', 'solmara', 'sunhaven', 'lake-vireska', 'veltmoor'];
/** Seconds off the road allowed over all the laps. */
const TOLERANCE = 0.3;

/** Seconds off the road (plus 10 per reset) over 1.3 laps of each circuit. */
function badness(model: CarModel, tracks: readonly Track[], f: number): number {
  let bad = 0;
  for (const track of tracks) {
    const line = computeRacingLine(track, lineOptionsFor(model.spec, f));
    const car = new Car(model.spec, track.gridSlot(0), track);
    car.setAids({ ...defaultAids(), gearbox: 'auto', tc: 'high', abs: 'high' });
    const ai = new AiDriver(track, line, { skill: 1.01, seed: 5 });
    let distance = 0;
    let prev = track.project(car.pos.x, car.pos.z).s;
    for (let t = 0; t < 300; t += SIM_DT) {
      car.setInput(ai.drive(car, [car], SIM_DT));
      if (ai.needsReset) {
        bad += 10;
        const p = track.at(track.project(car.pos.x, car.pos.z).s);
        car.teleport({ x: p.x, z: p.z, yaw: Math.atan2(-p.tx, -p.tz) });
        ai.needsReset = false;
      }
      car.step(SIM_DT, track);
      const pr = track.project(car.pos.x, car.pos.z);
      if (Math.abs(pr.lateral) > track.halfWidth + 1.2) bad += SIM_DT;
      let d = pr.s - prev;
      if (d < -track.length / 2) d += track.length;
      if (d > track.length / 2) d -= track.length;
      distance += d;
      prev = pr.s;
      if (distance > track.length * 1.3) break;
    }
    if (bad > TOLERANCE) break;
  }
  return bad;
}

it('calibrates the AI grip of every car', () => {
  const tracks = TRACK_IDS.map((id) => new Track(trackById(id)!));
  const rows: string[] = [];
  // CARS=suv,suv-trx limits the run to those cars.
  const only = process.env.CARS?.split(',');
  for (const model of CARS.filter((c) => !only || only.includes(c.id))) {
    let lo = 0.55;
    let hi = 1.05;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (badness(model, tracks, mid) <= TOLERANCE) lo = mid;
      else hi = mid;
    }
    rows.push(`  '${model.id}': ${Math.floor(lo * 100) / 100},`);
  }
  const table = `const AI_GRIP: Record<string, number> = {\n${rows.join('\n')}\n};\n`;
  writeFileSync('tools/ai-grip.txt', table);
  console.log(table);
});
