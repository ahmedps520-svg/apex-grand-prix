import * as THREE from 'three/webgpu';
import { reflective } from './Effects';
import {
  Fn,
  If,
  abs,
  dot,
  float,
  fwidth,
  hue,
  int,
  length,
  max,
  min,
  mix,
  normalLocal,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  sign,
  smoothstep,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  numberColours,
  type Livery,
  type LiveryFinish,
  type LiveryPattern,
} from '../content/livery';

type FloatNode = THREE.Node<'float'>;
type Vec2Node = THREE.Node<'vec2'>;

/**
 * Where a livery's features sit on one body style, in the car frame (x right, y up, z towards
 * the tail, metres from the centre of gravity). Patterns are computed from the position on the
 * body, so any mesh painted with the material picks them up.
 */
export interface LiveryLayout {
  /** Distances from the centre of gravity to the nose (−z) and the tail (+z). */
  front: number;
  rear: number;
  /** Shoulder line (y) of the side split; raked boundaries pivot around this height. */
  waist: number;
  /** Twin stripes: half the gap between them, and the width of each. */
  stripeGap: number;
  stripeWidth: number;
  /** Where the halves meet, where the chevron's tip is and where the two hoops are (z). */
  split: number;
  chevron: number;
  hoops: readonly [number, number];
  /** Hoop and chevron band width. */
  band: number;
  /**
   * Number on both sides of the car: centre (z, y), the height of the flat-ish panel it sits on,
   * and the |x| range of the surfaces it may paint.
   */
  door: { z: number; y: number; height: number; minX: number; maxX: number };
  /** Number on top (roof or nose): centre z, height of that surface and the room available. */
  top: { z: number; y: number; size: number };
}

const PATTERN_ID: Record<LiveryPattern, number> = {
  solid: 0,
  stripes: 1,
  halves: 2,
  chevron: 3,
  fade: 4,
  hoops: 5,
  sides: 6,
  number: 7,
};

/** Paint response per finish: base roughness and metalness, clear coat, and pearl shimmer. */
const FINISHES: Record<
  LiveryFinish,
  {
    roughness: number;
    metalness: number;
    clearcoat: number;
    clearcoatRoughness: number;
    pearl: number;
  }
> = {
  gloss: { roughness: 0.36, metalness: 0.02, clearcoat: 0.6, clearcoatRoughness: 0.08, pearl: 0 },
  matte: { roughness: 0.74, metalness: 0, clearcoat: 0, clearcoatRoughness: 0.6, pearl: 0 },
  metallic: {
    roughness: 0.3,
    metalness: 0.62,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    pearl: 0,
  },
  pearl: { roughness: 0.3, metalness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, pearl: 1 },
};

/** Boundaries lean back by this much per metre of height, like a speed line. */
const RAKE = 0.55;
/** The chevron's arms sweep back this much per metre across the car. */
const SWEEP = 0.9;
/** Half the width of an accent pinstripe. */
const PIN = 0.017;
/** The side split's shoulder line climbs this much per metre towards the tail. */
const WEDGE = 0.03;

const DIGITS_WIDTH = 256;
const DIGITS_HEIGHT = 128;
const DIGITS_FONT_SIZE = 100;
/** Bold numerals from the system fonts, which are always available. */
const DIGITS_FONT =
  `italic 900 ${DIGITS_FONT_SIZE}px 'Arial Black', 'Helvetica Neue', Arial, ` +
  "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Signed distance (negative inside) from `q` to a rounded box with half-size `half`. */
function roundedBox(q: Vec2Node, half: Vec2Node, radius: FloatNode): FloatNode {
  const d = abs(q).sub(half).add(radius);
  return length(max(d, 0))
    .add(min(max(d.x, d.y), 0))
    .sub(radius);
}

/** Box-filtered coverage of a line of half-width `half` at distance `d`, `aa` wide pixels. */
function lineCoverage(d: FloatNode, half: number, aa: FloatNode): FloatNode {
  const lo = max(d.sub(aa.mul(0.5)), -half);
  const hi = min(d.add(aa.mul(0.5)), half);
  return saturate(hi.sub(lo).div(aa));
}

/** Box-filtered coverage of the inside (negative side) of a signed distance. */
function inside(sd: FloatNode): FloatNode {
  const aa = max(fwidth(sd), 1e-4);
  return saturate(sd.negate().div(aa).add(0.5));
}

/**
 * The car paint: a `MeshPhysicalNodeMaterial` (WebGPU and WebGL2) whose colour is worked out
 * per pixel from the position on the body, so patterns need no UVs. The race number is a canvas
 * texture of the digits, projected sideways onto both doors and downwards onto the roof or nose,
 * on a roundel or number panel. Colours, the number, the finish, the pattern and the layout
 * are all uniforms: changing a livery never recompiles the shader, and every car shares one
 * shader program.
 */
export class LiveryMaterial {
  readonly material = new THREE.MeshPhysicalNodeMaterial();
  private readonly canvas = document.createElement('canvas');
  private readonly digits = new THREE.CanvasTexture(this.canvas);
  private number = -1;
  private readonly u = {
    primary: uniform(new THREE.Color()),
    secondary: uniform(new THREE.Color()),
    accent: uniform(new THREE.Color()),
    fill: uniform(new THREE.Color()),
    ring: uniform(new THREE.Color()),
    ink: uniform(new THREE.Color()),
    pattern: uniform(0, 'int'),
    roughness: uniform(0.4),
    metalness: uniform(0),
    clearcoat: uniform(0),
    clearcoatRoughness: uniform(0.1),
    pearl: uniform(0),
    // Layout.
    front: uniform(2),
    rear: uniform(2),
    waist: uniform(0),
    stripeGap: uniform(0.05),
    stripeWidth: uniform(0.2),
    split: uniform(0),
    chevron: uniform(-1),
    hoop1: uniform(-1),
    hoop2: uniform(1),
    band: uniform(0.3),
    doorZ: uniform(0),
    doorY: uniform(0),
    doorMinX: uniform(0.8),
    doorMaxX: uniform(1),
    // Number decals: panel half-size and corner radius, half-height of the digits, ring width.
    doorPanel: uniform(new THREE.Vector2(0.15, 0.15)),
    doorCorner: uniform(0.15),
    doorDigits: uniform(0.1),
    doorRing: uniform(0.01),
    topZ: uniform(0),
    topY: uniform(1),
    topPanel: uniform(new THREE.Vector2(0.2, 0.2)),
    topCorner: uniform(0.2),
    topDigits: uniform(0.12),
    topRing: uniform(0.012),
  };
  private layout: LiveryLayout;
  private panels = false;

  constructor(layout: LiveryLayout, livery: Livery) {
    this.layout = layout;
    this.canvas.width = DIGITS_WIDTH;
    this.canvas.height = DIGITS_HEIGHT;
    this.digits.colorSpace = THREE.NoColorSpace;
    this.digits.anisotropy = 4;
    this.buildNodes();
    this.setLayout(layout);
    this.set(livery);
    // Screen-space reflections: a clear coat mirrors the cars and the scenery beside it, a
    // matte finish barely does.
    const u = this.u;
    reflective(
      this.material,
      u.clearcoat.mul(0.3).add(u.metalness.mul(0.25)).add(0.06),
      mix(u.roughness, u.clearcoatRoughness, u.clearcoat),
    );
  }

  /** Moves the livery's features to fit a body style. */
  setLayout(layout: LiveryLayout): void {
    const u = this.u;
    this.layout = layout;
    u.front.value = layout.front;
    u.rear.value = layout.rear;
    u.waist.value = layout.waist;
    u.stripeGap.value = layout.stripeGap;
    u.stripeWidth.value = layout.stripeWidth;
    u.split.value = layout.split;
    u.chevron.value = layout.chevron;
    u.hoop1.value = layout.hoops[0];
    u.hoop2.value = layout.hoops[1];
    u.band.value = layout.band;
    u.doorZ.value = layout.door.z;
    u.doorY.value = layout.door.y;
    u.doorMinX.value = layout.door.minX;
    u.doorMaxX.value = layout.door.maxX;
    u.topZ.value = layout.top.z;
    u.topY.value = layout.top.y;
    this.sizeNumbers();
  }

  /** Applies a livery; only uniforms and the number texture change. */
  set(livery: Livery): void {
    const u = this.u;
    u.primary.value.setHex(livery.primary);
    u.secondary.value.setHex(livery.secondary);
    u.accent.value.setHex(livery.accent);
    const decal = numberColours(livery);
    u.fill.value.setHex(decal.fill);
    u.ring.value.setHex(decal.ring);
    u.ink.value.setHex(decal.ink);
    u.pattern.value = PATTERN_ID[livery.pattern];
    const finish = FINISHES[livery.finish];
    u.roughness.value = finish.roughness;
    u.metalness.value = finish.metalness;
    u.clearcoat.value = finish.clearcoat;
    u.clearcoatRoughness.value = finish.clearcoatRoughness;
    u.pearl.value = finish.pearl;
    this.panels = livery.pattern === 'number';
    this.sizeNumbers();
    if (livery.number !== this.number) {
      this.number = livery.number;
      this.drawNumber(livery.number);
    }
  }

  /** Changes only the primary colour. */
  setPrimary(hex: number): void {
    this.u.primary.value.setHex(hex);
  }

  dispose(): void {
    this.material.dispose();
    this.digits.dispose();
  }

  /**
   * Small roundels for most patterns; the number-panel pattern gets wide boards on the doors and
   * a bigger roundel on top.
   */
  private sizeNumbers(): void {
    const { layout, panels, u } = this;
    const h = layout.door.height;
    if (panels) {
      u.doorPanel.value.set(h * 0.82, h * 0.44);
      u.doorCorner.value = h * 0.12;
      u.doorDigits.value = h * 0.36;
      u.doorRing.value = h * 0.05;
    } else {
      const r = h * 0.44;
      u.doorPanel.value.set(r, r);
      u.doorCorner.value = r;
      u.doorDigits.value = r * 0.7;
      u.doorRing.value = r * 0.1;
    }
    const r = layout.top.size * (panels ? 0.5 : 0.4);
    u.topPanel.value.set(r, r);
    u.topCorner.value = r;
    u.topDigits.value = r * 0.7;
    u.topRing.value = r * 0.1;
  }

  /** White digits on black: the texture is a coverage mask. */
  private drawNumber(n: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const text = String(n);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, DIGITS_WIDTH, DIGITS_HEIGHT);
    ctx.font = DIGITS_FONT;
    const m = ctx.measureText(text);
    // An outline in the same colour makes any system font heavy enough to read at a distance.
    const stroke = DIGITS_FONT_SIZE * 0.1;
    const width = m.actualBoundingBoxLeft + m.actualBoundingBoxRight + stroke;
    const height = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + stroke;
    // The digits fill 80 % of the height, condensed if needed to fit a roundel.
    const sy = (DIGITS_HEIGHT * 0.8) / Math.max(height, 1);
    const sx = Math.min(sy, (DIGITS_WIDTH * 0.62) / Math.max(width, 1));
    const cx = (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const cy = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.setTransform(sx, 0, 0, sy, DIGITS_WIDTH / 2 - cx * sx, DIGITS_HEIGHT / 2 + cy * sy);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = stroke;
    ctx.lineJoin = 'round';
    ctx.fillText(text, 0, 0);
    ctx.strokeText(text, 0, 0);
    this.digits.needsUpdate = true;
  }

  private buildNodes(): void {
    const u = this.u;
    const p = positionLocal;

    /** x: signed distance (m) into the secondary colour; y: blend for the fade. */
    const pattern = Fn(() => {
      // Terms used by several branches are variables set before them: a node first built
      // inside one branch would be undefined in the others.
      const ax = abs(p.x).toVar();
      const up = p.y.sub(u.waist).toVar();
      const sd = float(-1).toVar();
      const fade = float(0).toVar();
      const is = (pattern: LiveryPattern) => u.pattern.equal(int(PATTERN_ID[pattern]));
      If(is('stripes'), () => {
        const half = u.stripeWidth.mul(0.5);
        sd.assign(half.sub(abs(ax.sub(u.stripeGap.add(half)))));
      })
        .ElseIf(is('halves'), () => {
          sd.assign(p.z.sub(u.split).sub(up.mul(RAKE)).div(Math.hypot(1, RAKE)));
        })
        .ElseIf(is('chevron'), () => {
          const start = u.chevron.add(ax.mul(SWEEP)).add(up.mul(RAKE));
          const half = u.band.mul(0.5);
          sd.assign(half.sub(abs(p.z.sub(start).sub(half))).div(Math.hypot(1, SWEEP, RAKE)));
        })
        .ElseIf(is('fade'), () => {
          const length = u.front.add(u.rear);
          const z = p.z.sub(up.mul(RAKE));
          fade.assign(smoothstep(u.split.sub(length.mul(0.32)), u.split.add(length.mul(0.18)), z));
        })
        .ElseIf(is('hoops'), () => {
          const half = u.band.mul(0.5);
          sd.assign(max(half.sub(abs(p.z.sub(u.hoop1))), half.sub(abs(p.z.sub(u.hoop2)))));
        })
        .ElseIf(is('sides'), () => {
          sd.assign(u.waist.add(p.z.sub(u.doorZ).mul(WEDGE)).sub(p.y));
        });
      return vec2(sd, fade);
    });

    const pat = pattern();
    const sd = pat.x;
    // Derivatives only in uniform control flow (WGSL requires it): after the branches.
    const aa = max(fwidth(sd), 1e-4);
    const secondary = max(saturate(sd.div(aa).add(0.5)), pat.y);
    const pin = lineCoverage(abs(sd), PIN, aa);
    const base = mix(u.primary, u.secondary, secondary);
    const painted = mix(base, u.accent, pin);

    // Pearl: the colour slides round the hue wheel and brightens at glancing angles.
    const glancing = pow(float(1).sub(saturate(dot(normalView, positionViewDirection))), 3);
    const shimmer = mix(hue(painted, 0.9), vec3(0.9, 0.95, 1), 0.25);
    const paint = mix(painted, shimmer, glancing.mul(u.pearl).mul(0.55));

    // The number on each side: projected along x, reading from front to back on either side.
    const ax = abs(p.x);
    const side = sign(p.x);
    const doorQ = vec2(p.z.sub(u.doorZ).mul(side).negate(), p.y.sub(u.doorY));
    const doorFacing = smoothstep(0.2, 0.4, abs(normalLocal.x))
      .mul(step(u.doorMinX, ax))
      .mul(step(ax, u.doorMaxX));
    const doorSd = roundedBox(doorQ, u.doorPanel, u.doorCorner);
    const doorFill = inside(doorSd).mul(doorFacing);
    const doorRing = doorFill.mul(saturate(doorSd.add(u.doorRing).div(max(fwidth(doorSd), 1e-4))));
    const doorUv = doorQ.div(vec2(u.doorDigits.mul(4), u.doorDigits.mul(2))).add(0.5);
    const doorInk = texture(this.digits, doorUv).r.mul(doorFill);

    // The number on top: projected down, reading from behind the car (as the chase camera sees it).
    const topQ = vec2(p.x, p.z.sub(u.topZ).negate());
    const topFacing = smoothstep(0.55, 0.75, normalLocal.y).mul(step(u.topY.sub(0.04), p.y));
    const topSd = roundedBox(topQ, u.topPanel, u.topCorner);
    const topFill = inside(topSd).mul(topFacing);
    const topRing = topFill.mul(saturate(topSd.add(u.topRing).div(max(fwidth(topSd), 1e-4))));
    const topUv = topQ.div(vec2(u.topDigits.mul(4), u.topDigits.mul(2))).add(0.5);
    const topInk = texture(this.digits, topUv).r.mul(topFill);

    const fill = max(doorFill, topFill);
    const withPanel = mix(paint, u.fill, fill);
    const withRing = mix(withPanel, u.ring, max(doorRing, topRing));
    const colour = mix(withRing, u.ink, max(doorInk, topInk));

    const m = this.material;
    m.colorNode = colour;
    m.roughnessNode = u.roughness;
    // Numbers are decals: never metallic.
    m.metalnessNode = u.metalness.mul(float(1).sub(fill));
    m.clearcoatNode = u.clearcoat;
    m.clearcoatRoughnessNode = u.clearcoatRoughness;
  }
}
