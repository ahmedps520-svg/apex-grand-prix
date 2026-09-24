import * as THREE from 'three/webgpu';

/**
 * The police helicopter: circles above the player at four stars and up, its searchlight on
 * the car after dark. A body, a tail boom, spinning rotor discs, skids and a beacon; it comes
 * down from high up when called and climbs away when the pursuit ends.
 */

const ORBIT_RADIUS = 38;
const HEIGHT = 42;
const ARRIVE_FROM = 130;
const ORBIT_RATE = 0.42;
const LEAVE_TIME = 4;

export class Helicopter {
  readonly root = new THREE.Group();
  private readonly craft = new THREE.Group();
  private readonly rotor: THREE.Mesh;
  private readonly tailRotor: THREE.Mesh;
  private readonly beacon: THREE.Mesh;
  private readonly light: THREE.SpotLight;
  private readonly target = new THREE.Object3D();
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private angle = 0;
  private active = false;
  private climb = ARRIVE_FROM;
  private leaving = 0;
  private time = 0;

  constructor() {
    const mat = (options: THREE.MeshStandardMaterialParameters) => {
      const m = new THREE.MeshStandardMaterial(options);
      this.materials.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T): T => {
      this.geometries.push(g);
      return g;
    };
    const paint = mat({ color: 0x1d2a44, roughness: 0.5, metalness: 0.2 });
    const glass = mat({ color: 0x9fc7ff, roughness: 0.15, metalness: 0.4 });
    const dark = mat({ color: 0x15171c, roughness: 0.7 });
    const blade = mat({ color: 0x0c0d10, roughness: 0.9, transparent: true, opacity: 0.35 });

    const body = new THREE.Mesh(geo(new THREE.BoxGeometry(2.2, 1.7, 4.6)), paint);
    body.position.y = 1.2;
    const nose = new THREE.Mesh(geo(new THREE.BoxGeometry(1.9, 1.2, 1.6)), glass);
    nose.position.set(0, 1.3, -3);
    const boom = new THREE.Mesh(geo(new THREE.BoxGeometry(0.55, 0.55, 5.4)), paint);
    boom.position.set(0, 1.5, 4.7);
    const fin = new THREE.Mesh(geo(new THREE.BoxGeometry(0.14, 1.6, 1.1)), paint);
    fin.position.set(0, 2.3, 7.1);
    const mast = new THREE.Mesh(geo(new THREE.BoxGeometry(0.3, 0.7, 0.3)), dark);
    mast.position.y = 2.35;
    this.rotor = new THREE.Mesh(geo(new THREE.CylinderGeometry(5.4, 5.4, 0.06, 24)), blade);
    this.rotor.position.y = 2.75;
    this.tailRotor = new THREE.Mesh(geo(new THREE.CylinderGeometry(1, 1, 0.05, 16)), blade);
    this.tailRotor.rotation.z = Math.PI / 2;
    this.tailRotor.position.set(0.4, 2.2, 7.3);
    const skidGeo = geo(new THREE.BoxGeometry(0.12, 0.12, 3.6));
    const skidL = new THREE.Mesh(skidGeo, dark);
    skidL.position.set(-0.9, 0.06, 0);
    const skidR = new THREE.Mesh(skidGeo, dark);
    skidR.position.set(0.9, 0.06, 0);
    this.beacon = new THREE.Mesh(
      geo(new THREE.SphereGeometry(0.16, 8, 6)),
      mat({ color: 0xff2020, emissive: 0xff2020, emissiveIntensity: 2 }),
    );
    this.beacon.position.set(0, 2.05, 6.9);
    // The searchlight, hung under the nose, pointing at the car.
    this.light = new THREE.SpotLight(0xfff1c0, 0, 160, 0.3, 0.5, 1.3);
    this.light.position.set(0, 0.5, -1.6);
    this.light.castShadow = false;
    this.light.target = this.target;
    this.craft.add(
      body,
      nose,
      boom,
      fin,
      mast,
      this.rotor,
      this.tailRotor,
      skidL,
      skidR,
      this.beacon,
      this.light,
    );
    for (const child of this.craft.children) {
      if (child instanceof THREE.Mesh) child.castShadow = true;
    }
    this.root.add(this.craft, this.target);
    this.root.visible = false;
  }

  /**
   * Called every frame with the car's position: circles it while `on` (arriving from high
   * up), climbs away and hides when not; the searchlight comes up with `night` (0 … 1).
   */
  update(dt: number, x: number, y: number, z: number, on: boolean, night: number): void {
    this.time += dt;
    if (on && !this.active) {
      this.active = true;
      this.leaving = 0;
      if (!this.root.visible) this.climb = ARRIVE_FROM;
      this.root.visible = true;
    } else if (!on && this.active) {
      this.active = false;
      this.leaving = LEAVE_TIME;
    }
    if (!this.root.visible) return;
    if (this.active) {
      this.climb += (0 - this.climb) * Math.min(dt * 0.9, 1);
    } else {
      this.leaving -= dt;
      this.climb += 30 * dt;
      if (this.leaving <= 0) {
        this.root.visible = false;
        return;
      }
    }
    this.angle += dt * ORBIT_RATE;
    const cx = x + Math.cos(this.angle) * ORBIT_RADIUS;
    const cz = z + Math.sin(this.angle) * ORBIT_RADIUS;
    const cy = y + HEIGHT + this.climb;
    this.craft.position.set(cx, cy, cz);
    // Nose along the orbit, banked in a little, bobbing slightly.
    const tx = -Math.sin(this.angle);
    const tz = Math.cos(this.angle);
    this.craft.rotation.set(0.08, Math.atan2(-tx, -tz), 0.18, 'YXZ');
    this.craft.position.y += Math.sin(this.time * 1.7) * 0.4;
    this.rotor.rotation.y += dt * 28;
    this.tailRotor.rotation.x += dt * 44;
    const beaconMat = this.beacon.material as THREE.MeshStandardMaterial;
    beaconMat.emissiveIntensity = Math.sin(this.time * 6) > 0.2 ? 2.5 : 0.2;
    this.target.position.set(x, y, z);
    this.light.intensity = this.active ? 700 * Math.max(0, Math.min(night, 1)) : 0;
  }

  /** Out of the sky at once (a new session). */
  reset(): void {
    this.active = false;
    this.leaving = 0;
    this.climb = ARRIVE_FROM;
    this.root.visible = false;
  }

  dispose(): void {
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
  }
}
