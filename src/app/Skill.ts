import type { CarRenderState } from '../render/interpolate';
import { invRotateV, type Vec3 } from '../shared/math';
import { FLAG_HAZARDS } from '../shared/protocol';

/**
 * Arcade skill points: drifts, near misses with the traffic, sustained speed, air time and
 * smashed props each score, chained into a combo whose multiplier grows while the events keep
 * coming and is lost in a crash. Runs on the main thread from the render states.
 */

export type SkillKind = 'drift' | 'nearMiss' | 'speed' | 'air' | 'smash' | 'race' | 'crash';

export interface SkillEvent {
  kind: SkillKind;
  points: number;
  label: string;
}

/** Rear slip angle (rad) and speed (m/s) that count as a drift; it ends after this long straight. */
const DRIFT_SLIP = 0.12;
const DRIFT_MIN_SPEED = 8;
const DRIFT_END = 0.6;
const DRIFT_MIN_POINTS = 15;
const DRIFT_RATE = 15;
/** A near miss: another car this close in the player's frame, at this closing speed. */
const NEAR_MISS_X = 2.6;
const NEAR_MISS_Z = 4.5;
const NEAR_MISS_SPEED = 10;
const NEAR_MISS_MIN_SPEED = 12;
const NEAR_MISS_AGAIN = 3;
/** Speed points: over this (m/s), every so many seconds. */
const SPEED_OVER = 44;
const SPEED_EVERY = 4;
const AIR_MIN = 0.5;
/** The chain lapses this long after the last event; a crash is this much felt acceleration. */
const CHAIN_TIME = 4;
const CRASH_ACCEL = 26;
const CRASH_AGAIN = 2;

export class Skill {
  score = 0;
  combo = 0;
  multiplier = 1;
  private readonly events: SkillEvent[] = [];
  private time = 0;
  private chain = 0;
  private driftPoints = 0;
  private drifting = false;
  private driftOff = 0;
  private air = 0;
  private speedFor = 0;
  private crashAt = -Infinity;
  private readonly nearMissAt = new Map<number, number>();
  private readonly local: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly delta: Vec3 = { x: 0, y: 0, z: 0 };

  update(dt: number, player: CarRenderState, cars: readonly CarRenderState[], count: number): void {
    this.time += dt;
    // A crash loses the chain.
    if (
      Math.hypot(player.accelLong, player.accelLat) > CRASH_ACCEL &&
      this.time - this.crashAt > CRASH_AGAIN
    ) {
      this.crashAt = this.time;
      if (this.combo > 0 || this.drifting)
        this.events.push({ kind: 'crash', points: 0, label: 'CRASH' });
      this.combo = 0;
      this.multiplier = 1;
      this.chain = 0;
      this.driftPoints = 0;
      this.drifting = false;
    }
    const speed = Math.abs(player.speed);
    const wheels = player.wheels;
    // Drifts: the rear sliding at speed, scored by speed and angle, banked when it ends.
    const rear = (Math.abs(wheels[2]?.slipAngle ?? 0) + Math.abs(wheels[3]?.slipAngle ?? 0)) / 2;
    const grounded = wheels.every((w) => w.contact);
    if (rear > DRIFT_SLIP && speed > DRIFT_MIN_SPEED && grounded) {
      this.drifting = true;
      this.driftOff = 0;
      this.driftPoints += speed * rear * dt * DRIFT_RATE;
    } else if (this.drifting) {
      this.driftOff += dt;
      if (this.driftOff > DRIFT_END) {
        this.drifting = false;
        if (this.driftPoints >= DRIFT_MIN_POINTS) this.award('drift', this.driftPoints, 'DRIFT');
        this.driftPoints = 0;
      }
    }
    // Near misses: another car passing close by, fast, without touching (its hazards would be on).
    if (speed > NEAR_MISS_MIN_SPEED) {
      for (let i = 1; i < count; i++) {
        const other = cars[i];
        if (!other || (other.flags & FLAG_HAZARDS) !== 0) continue;
        const d = this.delta;
        d.x = other.pos.x - player.pos.x;
        d.y = other.pos.y - player.pos.y;
        d.z = other.pos.z - player.pos.z;
        if (Math.abs(d.x) > 8 || Math.abs(d.z) > 8 || Math.abs(d.y) > 3) continue;
        const local = invRotateV(this.local, player.rot, d);
        if (Math.abs(local.x) > NEAR_MISS_X || Math.abs(local.z) > NEAR_MISS_Z) continue;
        const closing = Math.hypot(player.vel.x - other.vel.x, player.vel.z - other.vel.z);
        if (closing < NEAR_MISS_SPEED) continue;
        if (this.time - (this.nearMissAt.get(i) ?? -Infinity) < NEAR_MISS_AGAIN) continue;
        this.nearMissAt.set(i, this.time);
        this.award('nearMiss', 100 + speed * 2, 'NEAR MISS');
      }
    }
    // Speed: keeping it up pays every few seconds.
    if (speed > SPEED_OVER) {
      this.speedFor += dt;
      if (this.speedFor >= SPEED_EVERY) {
        this.speedFor = 0;
        this.award('speed', 80, 'SPEED');
      }
    } else {
      this.speedFor = 0;
    }
    // Air: all four wheels off the ground for a while.
    if (!wheels.some((w) => w.contact)) {
      this.air += dt;
    } else {
      if (this.air > AIR_MIN) this.award('air', this.air * 150, 'AIR');
      this.air = 0;
    }
    // The chain lapses quietly.
    this.chain += dt;
    if (this.chain > CHAIN_TIME && this.combo > 0) {
      this.combo = 0;
      this.multiplier = 1;
    }
  }

  /** Scores an event (the base points times the multiplier) and extends the chain. */
  award(kind: SkillKind, base: number, label: string): void {
    const points = Math.round(base * this.multiplier);
    this.score += points;
    this.combo++;
    this.multiplier = 1 + Math.min(this.combo, 8) * 0.25;
    this.chain = 0;
    this.events.push({ kind, points, label });
  }

  /** The events since the last call (for the HUD's pop-ups). */
  take(): SkillEvent[] {
    return this.events.splice(0);
  }
}
