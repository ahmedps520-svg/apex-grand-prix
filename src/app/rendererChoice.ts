/**
 * Decides whether to try WebGPU or go straight to WebGL2.
 *   ?renderer=webgl   forces WebGL2
 *   ?renderer=webgpu  tries WebGPU again (and forgets an earlier automatic fallback)
 * If WebGPU dies right after start-up on a device, we remember that and use WebGL2 next time.
 */

const KEY = 'apex-gp.renderer-fallback';

export interface RendererChoice {
  forceWebGL: boolean;
  /** Why WebGL2 was forced, if it was. */
  reason: 'url' | 'fallback' | null;
}

export function chooseRenderer(params: URLSearchParams): RendererChoice {
  const requested = params.get('renderer');
  if (requested === 'webgl') return { forceWebGL: true, reason: 'url' };
  if (requested === 'webgpu') {
    forgetFallback();
    return { forceWebGL: false, reason: null };
  }
  try {
    if (localStorage.getItem(KEY) === 'webgl') return { forceWebGL: true, reason: 'fallback' };
  } catch {
    // Storage unavailable: just try WebGPU.
  }
  return { forceWebGL: false, reason: null };
}

export function rememberFallback(): boolean {
  try {
    localStorage.setItem(KEY, 'webgl');
    return true;
  } catch {
    return false;
  }
}

function forgetFallback(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}
