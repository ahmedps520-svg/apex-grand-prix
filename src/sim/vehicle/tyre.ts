import type { TyreSpec } from './spec';

/**
 * Round 1 tyre: Pacejka "Magic Formula" curves for pure slip, combined with normalised slip
 * (the resultant slip is scaled by each direction's peak slip, which gives an elliptical grip
 * envelope), plus simple load sensitivity. Round 2 replaces this with the fuller model
 * (relaxation length, camber, combined-slip weighting, temperature).
 */

/** Magic Formula shape: sin(C·atan(Bx − E(Bx − atan Bx))), normalised to a peak of 1. */
export function magicFormula(x: number, b: number, c: number, e: number): number {
  const bx = b * x;
  return Math.sin(c * Math.atan(bx - e * (bx - Math.atan(bx))));
}

/** Slip at which the Magic Formula curve peaks (found numerically). */
export function peakSlip(b: number, c: number, e: number): number {
  let best = 0;
  let bestX = 0;
  for (let x = 0.0005; x < 1.5; x += 0.0005) {
    const y = magicFormula(x, b, c, e);
    if (y > best) {
      best = y;
      bestX = x;
    }
  }
  return bestX;
}

export interface TyreOutput {
  /** Longitudinal force along the wheel heading (+ = forwards). */
  fx: number;
  /** Lateral force along the wheel's right axis (+ = right). */
  fy: number;
  /** ∂fx/∂κ, used for the implicit wheel-spin integration. */
  dfxdk: number;
  /** Peak longitudinal force available at this load (for clamping). */
  fxMax: number;
  /** Combined slip relative to the peak: < 1 gripping, ≥ 1 sliding. */
  slip: number;
}

export const tyreOutput = (): TyreOutput => ({ fx: 0, fy: 0, dfxdk: 0, fxMax: 0, slip: 0 });

export class TyreModel {
  readonly kappaPeak: number;
  readonly alphaPeak: number;

  constructor(
    readonly spec: TyreSpec,
    /** Load at which the friction coefficients apply (usually the static corner load). */
    readonly referenceLoad: number,
  ) {
    this.kappaPeak = peakSlip(spec.bX, spec.cX, spec.eX);
    this.alphaPeak = peakSlip(spec.bY, spec.cY, spec.eY);
  }

  /**
   * @param kappa slip ratio (+ = wheel spinning faster than the road)
   * @param alpha slip angle in radians (+ = contact patch sliding to the right)
   * @param load normal load in newtons
   * @param grip surface grip multiplier
   */
  compute(kappa: number, alpha: number, load: number, grip: number, out: TyreOutput): TyreOutput {
    if (load <= 0) {
      out.fx = 0;
      out.fy = 0;
      out.dfxdk = 0;
      out.fxMax = 0;
      out.slip = 0;
      return out;
    }
    const s = this.spec;
    const loadFactor = this.loadFactor(load);
    const dx = s.muX * grip * loadFactor * load;
    const dy = s.muY * grip * loadFactor * load;

    out.fx = this.fx(kappa, alpha, dx);
    out.fy = this.fy(kappa, alpha, dy);
    const h = 1e-3;
    out.dfxdk = (this.fx(kappa + h, alpha, dx) - this.fx(kappa - h, alpha, dx)) / (2 * h);
    out.fxMax = dx;
    const kn = kappa / this.kappaPeak;
    const an = alpha / this.alphaPeak;
    out.slip = Math.sqrt(kn * kn + an * an);
    return out;
  }

  /** Friction falls as load rises above the reference load (load sensitivity). */
  private loadFactor(load: number): number {
    const f = 1 - this.spec.loadSensitivity * (load / this.referenceLoad - 1);
    return f < 0.6 ? 0.6 : f > 1.15 ? 1.15 : f;
  }

  private fx(kappa: number, alpha: number, peak: number): number {
    const kn = kappa / this.kappaPeak;
    const an = alpha / this.alphaPeak;
    const rho = Math.sqrt(kn * kn + an * an);
    if (rho < 1e-9) {
      // Linear region at zero slip: slope B·C·D.
      return peak * this.spec.bX * this.spec.cX * kappa;
    }
    const s = this.spec;
    return (peak * magicFormula(rho * this.kappaPeak, s.bX, s.cX, s.eX) * kn) / rho;
  }

  private fy(kappa: number, alpha: number, peak: number): number {
    const kn = kappa / this.kappaPeak;
    const an = alpha / this.alphaPeak;
    const rho = Math.sqrt(kn * kn + an * an);
    if (rho < 1e-9) return -peak * this.spec.bY * this.spec.cY * alpha;
    const s = this.spec;
    // The lateral force opposes the direction the contact patch slides in.
    return -(peak * magicFormula(rho * this.alphaPeak, s.bY, s.cY, s.eY) * an) / rho;
  }
}
