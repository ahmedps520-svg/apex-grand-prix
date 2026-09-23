import { DRAG_STRIP } from '../content/testGround';

/**
 * Times standing-start runs on the drag strip: 0–100 and 0–200 km/h, then 400 m and 1 km with
 * trap speeds. A run arms when the car stands still on the start line and starts when it moves;
 * crossing times are interpolated between frames so the frame rate doesn't matter.
 */

export type DragResult =
  | { kind: 'speed'; kmh: number; time: number }
  | { kind: 'distance'; metres: number; time: number; trapKmh: number };

type State = 'idle' | 'armed' | 'running';

const SPEED_MARKS = [100, 200];
const DISTANCE_MARKS = [400, DRAG_STRIP.length];

export class DragTimer {
  state: State = 'idle';
  private time = 0;
  private lastSpeed = 0;
  private lastDistance = 0;
  private speedIndex = 0;
  private distanceIndex = 0;

  /**
   * Call every frame with the car's position and forward speed (m/s). Returns the marks passed
   * this frame (usually none).
   */
  update(dt: number, x: number, z: number, speed: number): DragResult[] {
    const results: DragResult[] = [];
    const onStrip = Math.abs(x - DRAG_STRIP.x) < DRAG_STRIP.halfWidth + 4;
    const distance = DRAG_STRIP.zStart - z;
    const kmh = speed * 3.6;

    if (this.state !== 'running') {
      const onStartLine = onStrip && distance > -12 && distance < 1;
      this.state = onStartLine && Math.abs(speed) < 0.3 ? 'armed' : this.state;
      if (!onStartLine) this.state = 'idle';
      if (this.state === 'armed' && speed > 0.3) {
        this.state = 'running';
        // The car started moving a moment before it passed 0.3 m/s: count from standstill.
        const accel = (speed - this.lastSpeed / 3.6) / dt;
        this.time = accel > 0 ? Math.min(speed / accel, 0.5) : 0;
        this.speedIndex = 0;
        this.distanceIndex = 0;
      }
    } else if (!onStrip || speed < -0.5 || distance > DRAG_STRIP.length + 400) {
      this.state = 'idle';
    } else {
      const t0 = this.time;
      this.time += dt;
      const lerpTime = (from: number, to: number, mark: number) =>
        t0 + (to === from ? dt : ((mark - from) / (to - from)) * dt);
      while (this.speedIndex < SPEED_MARKS.length) {
        const mark = SPEED_MARKS[this.speedIndex]!;
        if (kmh < mark) break;
        results.push({ kind: 'speed', kmh: mark, time: lerpTime(this.lastSpeed, kmh, mark) });
        this.speedIndex++;
      }
      while (this.distanceIndex < DISTANCE_MARKS.length) {
        const mark = DISTANCE_MARKS[this.distanceIndex]!;
        if (distance < mark) break;
        results.push({
          kind: 'distance',
          metres: mark,
          time: lerpTime(this.lastDistance, distance, mark),
          trapKmh: kmh,
        });
        this.distanceIndex++;
      }
      if (this.distanceIndex >= DISTANCE_MARKS.length) this.state = 'idle';
    }
    this.lastSpeed = kmh;
    this.lastDistance = distance;
    return results;
  }
}

export function formatDragResult(r: DragResult, units: 'metric' | 'imperial'): string {
  const speed = (kmh: number) =>
    units === 'metric' ? `${Math.round(kmh)} km/h` : `${Math.round(kmh / 1.609344)} mph`;
  if (r.kind === 'speed') return `0–${r.kmh} km/h in ${r.time.toFixed(2)} s`;
  const label = r.metres >= 1000 ? `${r.metres / 1000} km` : `${r.metres} m`;
  return `${label} in ${r.time.toFixed(2)} s at ${speed(r.trapKmh)}`;
}
