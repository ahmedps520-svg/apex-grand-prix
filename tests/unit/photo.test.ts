import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import {
  PHOTO_MIN_CLEARANCE,
  PhotoCamera,
  defaultPhotoSettings,
  idlePhotoInput,
  type PhotoCameraInput,
} from '../../src/render/PhotoMode';

const DT = 1 / 60;

function input(patch: Partial<PhotoCameraInput>): PhotoCameraInput {
  return { ...idlePhotoInput(), ...patch };
}

function expectFinite(camera: THREE.PerspectiveCamera): void {
  for (const v of [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.fov]) {
    expect(Number.isFinite(v)).toBe(true);
  }
}

describe('photo camera', () => {
  it('never goes below the ground, whatever the controls do', () => {
    const photo = new PhotoCamera(defaultPhotoSettings());
    const car = new THREE.Vector3(10, 0.46, -20);
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 2 - 1;
    };
    for (let i = 0; i < 4000; i++) {
      // Mostly pushing down and in, with random everything else.
      const controls = input({
        orbitX: random(),
        orbitY: i % 3 === 0 ? -1 : random(),
        moveX: random(),
        moveY: i % 2 === 0 ? -1 : random(),
        zoom: i % 5 === 0 ? 1 : random(),
        roll: random(),
      });
      photo.update(DT, controls, car);
      expect(photo.camera.position.y).toBeGreaterThanOrEqual(PHOTO_MIN_CLEARANCE - 1e-9);
    }
    photo.orbitBy(0, -100);
    photo.moveBy(0, -100);
    photo.zoomBy(0.001);
    expect(photo.camera.position.y).toBeGreaterThanOrEqual(PHOTO_MIN_CLEARANCE - 1e-9);
    expectFinite(photo.camera);
  });

  it('keeps its distance from the focus point while orbiting', () => {
    const photo = new PhotoCamera(defaultPhotoSettings());
    const car = new THREE.Vector3(-3, 0.46, 8);
    photo.update(DT, idlePhotoInput(), car);
    const distance = photo.camera.position.distanceTo(photo.focus);
    expect(distance).toBeCloseTo(photo.distance, 6);
    for (let i = 0; i < 600; i++) {
      photo.update(DT, input({ orbitX: 1, orbitY: i < 300 ? 0.4 : -0.4 }), car);
      expect(photo.camera.position.distanceTo(photo.focus)).toBeCloseTo(distance, 6);
      // It looks at the focus point.
      const forward = photo.camera.getWorldDirection(new THREE.Vector3());
      const toFocus = photo.focus.clone().sub(photo.camera.position).normalize();
      expect(forward.dot(toFocus)).toBeCloseTo(1, 6);
    }
  });

  it('starts from the game camera: same position, direction and field of view', () => {
    const game = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 3200);
    const car = new THREE.Vector3(5, 0.46, 5);
    game.position.set(5, 2.3, 11);
    game.lookAt(5, 1.2, 2);
    game.updateMatrixWorld();
    const settings = defaultPhotoSettings();
    const photo = new PhotoCamera(settings);
    photo.reset(game, car);
    expect(photo.camera.position.distanceTo(game.position)).toBeLessThan(1e-6);
    const a = photo.camera.getWorldDirection(new THREE.Vector3());
    const b = game.getWorldDirection(new THREE.Vector3());
    expect(a.dot(b)).toBeCloseTo(1, 6);
    expect(settings.fov).toBe(62);
    expect(settings.roll).toBeCloseTo(0, 6);
  });

  it('never turns NaN, even from NaN input or targets', () => {
    const photo = new PhotoCamera(defaultPhotoSettings());
    const car = new THREE.Vector3(0, 0.5, 0);
    photo.update(DT, idlePhotoInput(), car);
    photo.update(NaN, input({ orbitX: NaN, zoom: Infinity, moveY: -Infinity }), car);
    photo.update(DT, idlePhotoInput(), new THREE.Vector3(NaN, 0, 0));
    photo.lens.fov = NaN;
    photo.orbitBy(NaN, Infinity);
    photo.zoomBy(NaN);
    expectFinite(photo.camera);
    expect(photo.camera.fov).toBeGreaterThanOrEqual(10);
    expect(photo.camera.fov).toBeLessThanOrEqual(100);
  });
});
