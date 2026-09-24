import { describe, expect, it } from 'vitest';
import { WEATHERS, gripFactor, wetness } from '../../src/content/conditions';
import { TRACKS } from '../../src/content/tracks';
import { sceneLook } from '../../src/render/sceneLook';
import { SIM_DT, defaultAids, type SessionConfig } from '../../src/shared/protocol';
import {
  MovingWeather,
  WEATHER_TRANSITION,
  WEATHER_WAIT_MAX,
  WEATHER_WAIT_MIN,
} from '../../src/sim/weather';
import { World } from '../../src/sim/world';

const LADDER = WEATHERS.map((w) => w.value);

const run = (world: World, seconds: number) => {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) world.step(SIM_DT);
};

describe('moving weather', () => {
  it('waits a few minutes, then steps one rung along the ladder over a transition', () => {
    const w = new MovingWeather('cloudy', 7);
    expect(w.blend).toBe(1);
    expect(w.wait).toBeGreaterThanOrEqual(WEATHER_WAIT_MIN);
    expect(w.wait).toBeLessThanOrEqual(WEATHER_WAIT_MAX);
    const wait = w.wait;
    w.step(wait - 1);
    expect(w.to).toBe('cloudy');
    w.step(2);
    expect(w.to).not.toBe('cloudy');
    expect(Math.abs(LADDER.indexOf(w.to) - LADDER.indexOf('cloudy'))).toBe(1);
    expect(w.blend).toBe(0);
    w.step(WEATHER_TRANSITION / 2);
    expect(w.blend).toBeCloseTo(0.5, 6);
    expect(w.from).toBe('cloudy');
    w.step(WEATHER_TRANSITION);
    expect(w.blend).toBe(1);
    expect(w.from).toBe(w.to);
    expect(w.wait).toBeGreaterThanOrEqual(WEATHER_WAIT_MIN);
  });

  it('never skips a rung, turns back at the ends and repeats for a seed', () => {
    const a = new MovingWeather('clear', 3);
    const b = new MovingWeather('clear', 3);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const before = a.from;
      a.change();
      b.change();
      expect(b.to).toBe(a.to);
      expect(Math.abs(LADDER.indexOf(a.to) - LADDER.indexOf(before))).toBe(1);
      seen.add(a.to);
      a.from = a.to;
      a.blend = 1;
      b.from = b.to;
      b.blend = 1;
    }
    expect(seen.size).toBeGreaterThan(2);
    const top = new MovingWeather('heavyRain', 1);
    top.change();
    expect(top.to).toBe('lightRain');
    const bottom = new MovingWeather('clear', 1);
    bottom.change();
    expect(bottom.to).toBe('cloudy');
  });

  it('wets the road, cuts the grip and slows the AI in step with the change', () => {
    const w = new MovingWeather('overcast', 5);
    expect(w.wetness).toBe(0);
    expect(w.grip).toBe(1);
    expect(w.pace).toBe(1);
    w.to = 'heavyRain';
    w.blend = 0.5;
    expect(w.wetness).toBeCloseTo(wetness('heavyRain') / 2, 9);
    expect(w.grip).toBeCloseTo((1 + gripFactor('heavyRain')) / 2, 9);
    expect(w.pace).toBeCloseTo(Math.sqrt(w.grip), 9);
    // A session that starts in the rain plans its lines for the rain: clearing up is quicker.
    const wet = new MovingWeather('heavyRain', 5);
    wet.to = 'lightRain';
    wet.blend = 1;
    wet.from = 'lightRain';
    expect(wet.pace).toBeCloseTo(Math.sqrt(gripFactor('lightRain') / gripFactor('heavyRain')), 9);
  });
});

describe('moving weather in a session', () => {
  const race = (extra: Partial<SessionConfig> = {}): SessionConfig => ({
    mode: 'race',
    trackId: TRACKS[0]!.id,
    carId: 'gt',
    location: 'loop',
    roamStart: 'downtown',
    opponents: 2,
    laps: 1,
    difficulty: 'medium',
    gridSlot: 0,
    aids: defaultAids(),
    seed: 11,
    conditions: { time: 'midday', weather: 'overcast' },
    grip: 1,
    weatherMoves: true,
    ...extra,
  });

  it('follows the sky with the grip of the road and the pace of the rivals', () => {
    const world = World.forSession(race());
    const weather = world.weather!;
    expect(weather).toBeTruthy();
    run(world, 1);
    expect(world.surface.gripScale).toBeCloseTo(1, 9);
    expect(world.drivers[1]!.paceScale).toBeCloseTo(1, 9);
    weather.to = 'heavyRain';
    weather.blend = 0;
    run(world, WEATHER_TRANSITION + 1);
    expect(weather.from).toBe('heavyRain');
    expect(world.surface.gripScale).toBeCloseTo(gripFactor('heavyRain'), 6);
    expect(world.drivers[1]!.paceScale).toBeCloseTo(Math.sqrt(gripFactor('heavyRain')), 6);
    expect(world.weather!.status).toEqual({ from: 'heavyRain', to: 'heavyRain', blend: 1 });
  });

  it('stays as chosen without it, and never moves on the proving ground', () => {
    const fixed = World.forSession(race({ weatherMoves: false, grip: 0.72 }));
    expect(fixed.weather).toBeNull();
    run(fixed, 1);
    expect(fixed.surface.gripScale).toBe(0.72);
    const free = World.forSession(race({ mode: 'free', trackId: '' }));
    expect(free.weather).toBeNull();
    const roam = World.forSession(race({ mode: 'roam', trackId: '', traffic: 2 }));
    expect(roam.weather).toBeTruthy();
  });
});

describe('the look between weathers', () => {
  const theme = TRACKS[0]!.theme;
  const at = (time: 'track' | 'midday' = 'midday') => time;

  it('arrives exactly at the next weather and never jumps on the way', () => {
    for (let i = 0; i < LADDER.length - 1; i++) {
      const from = LADDER[i]!;
      const to = LADDER[i + 1]!;
      const target = sceneLook(theme, { time: at(), weather: to });
      const arrived = sceneLook(theme, { time: at(), weather: from }, undefined, { to, blend: 1 });
      expect(arrived.fogNear).toBeCloseTo(target.fogNear, 9);
      expect(arrived.sunIntensity).toBeCloseTo(target.sunIntensity, 9);
      expect(arrived.lightElevation).toBeCloseTo(target.lightElevation, 9);
      expect(arrived.wetness).toBeCloseTo(target.wetness, 9);
      expect(arrived.sky.overcast).toBeCloseTo(target.sky.overcast, 9);
      let last = sceneLook(theme, { time: at(), weather: from });
      for (let b = 0.02; b <= 1.0001; b += 0.02) {
        const look = sceneLook(theme, { time: at(), weather: from }, undefined, { to, blend: b });
        expect(Math.abs(look.lightElevation - last.lightElevation)).toBeLessThan(8);
        expect(Math.abs(look.sunIntensity - last.sunIntensity)).toBeLessThan(0.25);
        expect(Math.abs(look.sky.overcast - last.sky.overcast)).toBeLessThan(0.12);
        expect(Math.abs(look.fogColor.r - last.fogColor.r)).toBeLessThan(0.06);
        last = look;
      }
    }
  });

  it("keeps each preset's look as it was, and reports the cloud", () => {
    const own = sceneLook(theme);
    expect(own.cloud).toBe(0);
    expect(own.sky.haze).toBe(0);
    expect(sceneLook(theme, { time: 'track', weather: 'overcast' }).lightElevation).toBeCloseTo(
      Math.max(theme.sunElevation, 6) * 0.15 + 72 * 0.85,
      6,
    );
    expect(sceneLook(theme, { time: 'midday', weather: 'cloudy' }).sky.overcast).toBeCloseTo(
      0.35 * 0.3,
      9,
    );
    expect(sceneLook(theme, { time: 'midday', weather: 'heavyRain' }).cloud).toBe(1);
  });
});
