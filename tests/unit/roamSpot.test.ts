import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRoamSpot, saveRoamSpot, type RoamSpot } from '../../src/app/records';

const fakeStorage = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
  };
};

const spot: RoamSpot = {
  x: 12.5,
  z: -300.25,
  y: 0.5,
  yaw: 1.2,
  carId: 'gt-falco',
  time: 'dusk',
  weather: 'rain',
  handling: 'arcade',
};

describe('the free roam spot', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips through storage and repairs bad data', () => {
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadRoamSpot()).toBeNull();
    saveRoamSpot(spot);
    expect(loadRoamSpot()).toEqual(spot);
    localStorage.setItem('apex-gp.roam', JSON.stringify({ ...spot, x: 'no' }));
    expect(loadRoamSpot()).toBeNull();
    localStorage.setItem('apex-gp.roam', '{not json');
    expect(loadRoamSpot()).toBeNull();
    saveRoamSpot(spot);
    saveRoamSpot(null);
    expect(loadRoamSpot()).toBeNull();
  });

  it('is nothing without storage, and saving never throws', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(loadRoamSpot()).toBeNull();
    expect(() => saveRoamSpot(spot)).not.toThrow();
  });
});
