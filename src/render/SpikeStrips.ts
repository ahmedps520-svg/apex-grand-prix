import * as THREE from 'three/webgpu';

/**
 * Spike strips the police lay across the road ahead of a pursuit: a dark rubber bar with a row
 * of steel spikes, one mesh group per strip, matched to the sim's list by their coordinates.
 */
export class SpikeStrips {
  readonly root = new THREE.Group();
  private readonly shown = new Map<string, THREE.Group>();
  private readonly rubber = new THREE.MeshStandardMaterial({ color: 0x1c1c1e, roughness: 0.9 });
  private readonly stripe = new THREE.MeshStandardMaterial({
    color: 0xf2c218,
    roughness: 0.6,
    emissive: 0xf2c218,
    emissiveIntensity: 0.25,
  });
  private readonly steel = new THREE.MeshStandardMaterial({
    color: 0xc8ccd2,
    roughness: 0.3,
    metalness: 0.9,
  });
  private readonly spike = new THREE.ConeGeometry(0.025, 0.14, 5);
  private readonly cap = new THREE.BoxGeometry(0.18, 0.052, 0.12);

  /** Shows exactly `strips` ([x1, z1, x2, z2] each); `heightAt` gives the road height. */
  update(strips: readonly number[][], heightAt: (x: number, z: number) => number): void {
    const keep = new Set<string>();
    for (const strip of strips) {
      const key = strip.join(',');
      keep.add(key);
      if (this.shown.has(key) || strip.length < 4) continue;
      const [x1, z1, x2, z2] = strip as [number, number, number, number];
      const length = Math.hypot(x2 - x1, z2 - z1);
      if (length < 0.5) continue;
      const group = new THREE.Group();
      const bar = new THREE.Mesh(new THREE.BoxGeometry(length, 0.05, 0.32), this.rubber);
      bar.position.y = 0.025;
      bar.receiveShadow = true;
      group.add(bar);
      // Yellow warning caps every metre, with the spikes between them.
      const spikes = Math.max(2, Math.floor(length / 0.22));
      const rows = new THREE.InstancedMesh(this.spike, this.steel, spikes);
      const m = new THREE.Matrix4();
      for (let i = 0; i < spikes; i++) {
        m.makeTranslation(-length / 2 + (i + 0.5) * (length / spikes), 0.12, 0);
        rows.setMatrixAt(i, m);
      }
      rows.castShadow = true;
      group.add(rows);
      const caps = Math.max(2, Math.floor(length));
      const capMesh = new THREE.InstancedMesh(this.cap, this.stripe, caps);
      for (let i = 0; i < caps; i++) {
        m.makeTranslation(-length / 2 + (i + 0.5) * (length / caps), 0.051, 0.1);
        capMesh.setMatrixAt(i, m);
      }
      group.add(capMesh);
      const cx = (x1 + x2) / 2;
      const cz = (z1 + z2) / 2;
      group.position.set(cx, heightAt(cx, cz) + 0.01, cz);
      group.rotation.y = Math.atan2(-(z2 - z1), x2 - x1);
      this.root.add(group);
      this.shown.set(key, group);
    }
    for (const [key, group] of this.shown) {
      if (keep.has(key)) continue;
      this.remove(group);
      this.shown.delete(key);
    }
  }

  clear(): void {
    for (const group of this.shown.values()) this.remove(group);
    this.shown.clear();
  }

  dispose(): void {
    this.clear();
    this.rubber.dispose();
    this.stripe.dispose();
    this.steel.dispose();
    this.spike.dispose();
    this.cap.dispose();
  }

  private remove(group: THREE.Group): void {
    group.removeFromParent();
    group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry !== this.spike && mesh.geometry !== this.cap) {
        mesh.geometry.dispose();
      }
    });
  }
}
