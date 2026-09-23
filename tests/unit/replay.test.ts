import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { ReplayRecorder } from '../../src/app/replay';
import { createCarRenderState, type CarRenderState } from '../../src/render/interpolate';
import { TvDirector } from '../../src/render/TvCamera';
import { quat, quatFromYaw } from '../../src/shared/math';
import { FLAG_LIMITER } from '../../src/shared/protocol';
import { Track, type TrackDef } from '../../src/sim/track/Track';

const TAU = Math.PI * 2;
const SPEED = 50;
const YAW_RATE = 0.5;
/** Fast enough that a wheel turns more than half a revolution between 30 Hz samples. */
const WHEEL_RATE = SPEED / 0.34;

/** A car driving along +x at 50 m/s while yawing, with its values changing over time. */
function drive(car: CarRenderState, t: number): void {
  car.pos.x = SPEED * t;
  car.pos.y = 0.5;
  car.pos.z = -3;
  quatFromYaw(car.rot, YAW_RATE * t);
  car.speed = SPEED;
  car.rpm = 3000 + 1000 * t;
  car.gear = t < 0.41 ? 2 : 3;
  car.throttle = t / 2;
  car.flags = t < 0.41 ? FLAG_LIMITER : 0;
  car.wheels.forEach((w, i) => {
    w.length = 0.1 + 0.01 * i;
    w.steer = i < 2 ? 0.2 : 0;
    w.spin = (WHEEL_RATE * t) % TAU;
    w.slip = 0.3;
    w.contact = i !== 3;
    w.surface = i;
  });
}

describe('replay', () => {
  it('keeps one sample per 1/hz of the clock and ignores calls in between', () => {
    const recorder = new ReplayRecorder(1, 30);
    const car = createCarRenderState();
    for (let frame = 0; frame <= 3 * 144; frame++) {
      const t = 10 + frame / 144;
      drive(car, t);
      recorder.record(t, [car]);
      recorder.record(t, [car]); // same time again: ignored
    }
    expect(recorder.sampleCount).toBeGreaterThanOrEqual(89);
    expect(recorder.sampleCount).toBeLessThanOrEqual(92);
    expect(recorder.duration).toBeGreaterThan(3 - 1 / 30);
    expect(recorder.duration).toBeLessThanOrEqual(3 + 1e-4);
    const replay = recorder.finish();
    expect(replay.startTime).toBe(10);
    expect(replay.duration).toBeCloseTo(recorder.duration, 6);
  });

  it('interpolates between samples and holds discrete values', () => {
    const recorder = new ReplayRecorder(2);
    const cars = [createCarRenderState(), createCarRenderState()];
    for (let k = 0; k <= 60; k++) {
      drive(cars[0]!, k / 30);
      recorder.record(k / 30, cars);
    }
    const replay = recorder.finish();
    expect(replay.carCount).toBe(2);
    expect(replay.sampleCount).toBe(61);
    expect(replay.duration).toBeCloseTo(2, 5);

    const out = createCarRenderState();
    const t = 0.51; // 30 % of the way from the sample at 0.5 to the one at 0.5333
    replay.sample(t, 0, out);
    expect(out.pos.x).toBeCloseTo(SPEED * t, 3);
    expect(out.pos.z).toBeCloseTo(-3, 5);
    const yaw = quatFromYaw(quat(), YAW_RATE * t);
    expect(Math.abs(out.rot.y * yaw.y + out.rot.w * yaw.w)).toBeCloseTo(1, 6);
    expect(out.vel.x).toBeCloseTo(SPEED, 2);
    expect(out.speed).toBeCloseTo(SPEED, 4);
    expect(out.rpm).toBeCloseTo(3000 + 1000 * t, 1);
    expect(out.throttle).toBeCloseTo(t / 2, 3);
    const wheel = out.wheels[1]!;
    expect(wheel.length).toBeCloseTo(0.11, 3);
    expect(wheel.steer).toBeCloseTo(0.2, 3);
    expect(wheel.slip).toBeCloseTo(0.3, 3);
    expect(wheel.surface).toBe(1);
    expect(wheel.contact).toBe(true);
    expect(out.wheels[3]!.contact).toBe(false);
    // Nearly five radians per sample: only the right number of whole turns lands here.
    const spinError = Math.abs(wheel.spin - ((WHEEL_RATE * t) % TAU));
    expect(Math.min(spinError, TAU - spinError)).toBeLessThan(0.01);

    // Discrete values come from the sample at or before the time asked for.
    replay.sample(0.43, 0, out);
    expect(out.gear).toBe(2);
    expect(out.flags).toBe(FLAG_LIMITER);
    replay.sample(0.434, 0, out);
    expect(out.gear).toBe(3);
    expect(out.flags).toBe(0);

    // Clamped at both ends.
    replay.sample(-5, 0, out);
    expect(out.pos.x).toBeCloseTo(0, 5);
    replay.sample(99, 0, out);
    expect(out.pos.x).toBeCloseTo(SPEED * 2, 3);
    expect(() => replay.sample(0, 2, out)).toThrow(RangeError);
  });

  it('turns a slow wheel the short way across the wrap, and never blends a teleport', () => {
    const recorder = new ReplayRecorder(1);
    const car = createCarRenderState();
    car.speed = 1;
    car.wheels[0]!.spin = 6.2;
    recorder.record(0, [car]);
    car.wheels[0]!.spin = 0.1;
    car.pos.x = 500; // reset to the other end of the circuit
    recorder.record(0.1, [car]);
    const out = createCarRenderState();
    recorder.finish().sample(0.05, 0, out);
    expect(out.pos.x).toBe(0);
    car.pos.x = 0;
    const recorder2 = new ReplayRecorder(1);
    car.wheels[0]!.spin = 6.2;
    recorder2.record(0, [car]);
    car.wheels[0]!.spin = 0.1;
    recorder2.record(0.1, [car]);
    recorder2.finish().sample(0.05, 0, out);
    const mid = (6.2 + (0.1 + TAU - 6.2) / 2) % TAU;
    expect(out.wheels[0]!.spin).toBeCloseTo(mid, 2);
  });

  it('fits a 20-minute race of 12 cars at 30 Hz in under 40 MB', () => {
    const recorder = new ReplayRecorder(12);
    const cars = Array.from({ length: 12 }, () => createCarRenderState());
    const samples = 20 * 60 * 30;
    for (let k = 0; k < samples; k++) {
      for (let i = 0; i < cars.length; i++) cars[i]!.pos.x = k * 0.1 + i;
      recorder.record(k / 30, cars);
    }
    expect(recorder.sampleCount).toBe(samples);
    expect(recorder.finish().byteLength).toBeLessThan(40e6);
  });
});

/** A 1.4 km oval: 400 m straights joined by 100 m radius bends. */
function ovalTrack(): Track {
  const points: Array<[number, number]> = [];
  for (let z = 200; z > -200; z -= 25) points.push([100, z]);
  for (let a = 0; a < Math.PI - 1e-6; a += Math.PI / 12) {
    points.push([100 * Math.cos(a), -200 - 100 * Math.sin(a)]);
  }
  for (let z = -200; z < 200; z += 25) points.push([-100, z]);
  for (let a = Math.PI; a < TAU - 1e-6; a += Math.PI / 12) {
    points.push([100 * Math.cos(a), 200 - 100 * Math.sin(a)]);
  }
  const def: TrackDef = {
    id: 'test-oval',
    name: 'Test Oval',
    description: '',
    location: '',
    points,
    width: 12,
    runoff: 10,
    laps: 3,
    theme: {
      grass: 0,
      runoffSurface: 'grass',
      sunElevation: 30,
      sunAzimuth: 0,
      fog: 0,
      trees: 0,
      barrier: 0,
    },
  };
  return new Track(def);
}

describe('TvDirector', () => {
  it('keeps the camera finite and off the road over several laps', () => {
    const track = ovalTrack();
    const director = new TvDirector(track);
    expect(director.spots.length).toBeGreaterThanOrEqual(5);
    for (const spot of director.spots) {
      const beyond = Math.abs(track.project(spot.x, spot.z).lateral) - track.wallOffset;
      expect(beyond).toBeGreaterThan(3.4);
      expect(beyond).toBeLessThan(12.5);
      expect(spot.y).toBeGreaterThanOrEqual(2.5);
      expect(spot.y).toBeLessThanOrEqual(8);
    }
    expect(new Set(director.spots.map((spot) => spot.side)).size).toBe(2);

    const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 5000);
    const target = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    const n = track.samples.length;
    const dt = 1 / 60;
    const forcedCutAt = 50;
    let s = 0;
    let finite = true;
    let offRoad = Infinity;
    let lowInside = 0;
    let fovMin = Infinity;
    let fovMax = -Infinity;
    let lastShot = '';
    let lastCut = 0;
    let shortestShot = Infinity;
    const kinds = new Set<string>();
    for (let frame = 0; frame < 95 * 60; frame++) {
      const t = frame * dt;
      // Laps at 60 m/s, a stop, then faster.
      const speed = t < 25 ? 60 : t < 31 ? 0 : 75;
      s = (s + speed * dt) % track.length;
      const u = (s / track.length) * n;
      const a = track.samples[Math.floor(u) % n]!;
      const b = track.samples[(Math.floor(u) + 1) % n]!;
      const f = u - Math.floor(u);
      target.set(a.x + (b.x - a.x) * f, 0.5, a.z + (b.z - a.z) * f);
      velocity.set(a.tx * speed, 0, a.tz * speed);
      if (frame === forcedCutAt * 60) director.cut();
      director.update(dt, target, velocity, camera);

      const p = camera.position;
      const q = camera.quaternion;
      finite &&= [p.x, p.y, p.z, q.x, q.y, q.z, q.w, camera.fov].every(Number.isFinite);
      const lateral = Math.abs(track.project(p.x, p.z).lateral);
      offRoad = Math.min(offRoad, lateral - track.halfWidth);
      if (p.y < 10 && lateral < track.wallOffset) lowInside++;
      fovMin = Math.min(fovMin, camera.fov);
      fovMax = Math.max(fovMax, camera.fov);
      const shot = `${director.shotKind}:${director.currentSpot}`;
      kinds.add(director.shotKind);
      if (shot !== lastShot) {
        if (frame > 0 && frame !== forcedCutAt * 60) {
          shortestShot = Math.min(shortestShot, t - lastCut);
        }
        lastShot = shot;
        lastCut = t;
      }
    }
    expect(finite).toBe(true);
    expect(offRoad).toBeGreaterThan(0);
    expect(lowInside).toBe(0);
    expect(fovMin).toBeGreaterThanOrEqual(8);
    expect(fovMax).toBeLessThanOrEqual(60);
    expect(shortestShot).toBeGreaterThanOrEqual(2.5 - 1e-9);
    expect(kinds).toEqual(new Set(['trackside', 'helicopter']));
  });
});
