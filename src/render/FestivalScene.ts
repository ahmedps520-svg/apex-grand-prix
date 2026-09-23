import * as THREE from 'three/webgpu';
import type { Checkpoint, FestivalEvent } from '../content/city/events';

/**
 * The festival's furniture in the open world: speed-camera gantries, drift-zone gates, jump
 * ramps with their danger signs, race start arches, and the glowing ring at the checkpoint to
 * head for during a race.
 */
export class FestivalScene {
  readonly root = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly ring: THREE.Mesh;
  private ringKey = '';
  private spin = 0;

  constructor(events: readonly FestivalEvent[]) {
    const steel = this.material(
      new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.45, metalness: 0.7 }),
    );
    const dark = this.material(new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.9 }));
    const yellow = this.material(
      new THREE.MeshStandardMaterial({
        color: 0xf2c218,
        roughness: 0.6,
        emissive: 0xf2c218,
        emissiveIntensity: 0.3,
      }),
    );
    const black = this.material(
      new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }),
    );
    const cyan = this.material(
      new THREE.MeshStandardMaterial({
        color: 0x37d4ff,
        emissive: 0x37d4ff,
        emissiveIntensity: 0.6,
        roughness: 0.5,
      }),
    );
    const red = this.material(
      new THREE.MeshStandardMaterial({
        color: 0xff3b2f,
        emissive: 0xff3b2f,
        emissiveIntensity: 0.35,
        roughness: 0.5,
      }),
    );
    const white = this.material(
      new THREE.MeshStandardMaterial({ color: 0xf2f4f8, roughness: 0.6 }),
    );
    const post = this.geometry(new THREE.CylinderGeometry(0.12, 0.14, 1, 10));
    const cube = this.geometry(new THREE.BoxGeometry(1, 1, 1));

    const place = (
      mesh: THREE.Object3D,
      e: FestivalEvent,
      along: number,
      across: number,
      y: number,
    ) => {
      mesh.position.set(
        e.x + e.tx * along - e.tz * across,
        e.y + y,
        e.z + e.tz * along + e.tx * across,
      );
      mesh.rotation.y = e.yaw;
    };
    const posts = (
      e: FestivalEvent,
      along: number,
      height: number,
      half: number,
      mat: THREE.Material,
    ) => {
      for (const side of [-1, 1]) {
        const p = new THREE.Mesh(post, mat);
        p.scale.set(1, height, 1);
        place(p, e, along, side * half, height / 2);
        p.castShadow = true;
        this.root.add(p);
      }
    };
    const bar = (
      e: FestivalEvent,
      along: number,
      y: number,
      width: number,
      h: number,
      d: number,
      mat: THREE.Material,
    ) => {
      const b = new THREE.Mesh(cube, mat);
      b.scale.set(width, h, d);
      place(b, e, along, 0, y);
      b.castShadow = true;
      this.root.add(b);
      return b;
    };

    for (const e of events) {
      const half = e.halfWidth + 0.6;
      if (e.kind === 'camera') {
        // A gantry: two posts, a crossbar, the camera box in the middle, a sign on the near post.
        posts(e, 0, 5.6, half, steel);
        bar(e, 0, 5.4, half * 2 + 0.3, 0.28, 0.28, steel);
        const cam = new THREE.Mesh(cube, dark);
        cam.scale.set(0.45, 0.35, 0.5);
        place(cam, e, 0, 0, 4.95);
        this.root.add(cam);
        const sign = new THREE.Mesh(cube, yellow);
        sign.scale.set(0.8, 0.8, 0.06);
        place(sign, e, -0.1, half, 3.2);
        this.root.add(sign);
      } else if (e.kind === 'drift') {
        // Gates at the zone's start and end: posts with a cyan banner.
        const zone = e.zone!;
        for (const s of [0, zone.s1 - zone.s0]) {
          posts(e, s, 4.2, half, steel);
          bar(e, s, 3.6, half * 2 + 0.3, 1, 0.06, cyan);
        }
      } else if (e.kind === 'jump') {
        // The ramp: a wedge along the direction of travel, a yellow lip, and the danger sign.
        const ramp = e.ramp!;
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.lineTo(ramp.length, 0);
        shape.lineTo(ramp.length, ramp.rise);
        shape.closePath();
        const wedge = this.geometry(
          new THREE.ExtrudeGeometry(shape, { depth: ramp.width, bevelEnabled: false }),
        );
        // Shape x → along, shape y → up, extrusion → across (centred).
        const w = new THREE.Mesh(wedge, dark);
        w.rotation.order = 'YXZ';
        w.rotation.y = e.yaw + Math.PI / 2;
        w.position.set(e.x - e.tz * (-ramp.width / 2), e.y + 0.01, e.z + e.tx * (-ramp.width / 2));
        w.castShadow = true;
        w.receiveShadow = true;
        this.root.add(w);
        bar(e, ramp.length - 0.15, ramp.rise + 0.03, ramp.width, 0.06, 0.3, yellow);
        // The danger sign beside the foot: a post and a diamond board.
        const sp = new THREE.Mesh(post, steel);
        sp.scale.set(0.8, 2.4, 0.8);
        place(sp, e, -2, ramp.width / 2 + 1.2, 1.2);
        this.root.add(sp);
        const board = new THREE.Mesh(cube, yellow);
        board.scale.set(0.95, 0.95, 0.05);
        place(board, e, -2, ramp.width / 2 + 1.2, 2.9);
        board.rotation.z = Math.PI / 4;
        this.root.add(board);
        const border = new THREE.Mesh(cube, black);
        border.scale.set(1.1, 1.1, 0.03);
        place(border, e, -2.02, ramp.width / 2 + 1.2, 2.9);
        border.rotation.z = Math.PI / 4;
        this.root.add(border);
      } else {
        // A race: the start arch (red pillars, white beam) and a flag pole at the finish.
        posts(e, 0, 6, half, red);
        bar(e, 0, 5.8, half * 2 + 0.4, 0.5, 0.5, white);
        const finish = e.checkpoints[e.checkpoints.length - 1];
        if (finish) {
          const pole = new THREE.Mesh(post, steel);
          pole.scale.set(0.8, 5, 0.8);
          pole.position.set(finish.x - e.tz * half, finish.y + 2.5, finish.z + e.tx * half);
          this.root.add(pole);
          const flag = new THREE.Mesh(cube, red);
          flag.scale.set(1.4, 0.8, 0.04);
          flag.position.set(
            finish.x - e.tz * (half - 0.8),
            finish.y + 4.5,
            finish.z + e.tx * (half - 0.8),
          );
          flag.rotation.y = e.yaw;
          this.root.add(flag);
        }
      }
    }

    // The next checkpoint's ring, moved as the race goes on.
    this.ring = new THREE.Mesh(
      this.geometry(new THREE.TorusGeometry(6, 0.35, 10, 36)),
      this.material(
        new THREE.MeshStandardMaterial({
          color: 0xffd166,
          emissive: 0xffd166,
          emissiveIntensity: 0.9,
          transparent: true,
          opacity: 0.85,
          side: THREE.DoubleSide,
        }),
      ),
    );
    this.ring.visible = false;
    this.root.add(this.ring);
  }

  /** Shows the ring at the checkpoint to head for (null hides it). */
  setNextCheckpoint(cp: Checkpoint | null, dt: number): void {
    const key = cp ? `${cp.x},${cp.z}` : '';
    if (key !== this.ringKey) {
      this.ringKey = key;
      this.ring.visible = cp !== null;
      if (cp) this.ring.position.set(cp.x, cp.y + 4, cp.z);
    }
    if (cp) {
      this.spin += dt * 0.8;
      this.ring.rotation.y = this.spin;
    }
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }

  private geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.push(g);
    return g;
  }

  private material<T extends THREE.Material>(m: T): T {
    this.materials.push(m);
    return m;
  }
}
