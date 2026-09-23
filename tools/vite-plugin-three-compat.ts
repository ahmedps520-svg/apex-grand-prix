import type { Plugin } from 'vite';

/**
 * Compatibility patch for three.js r186's WebGPU backend.
 *
 * three.js fills every GPUTextureViewDescriptor with `swizzle: 'rgba'` (an identity swizzle it
 * never changes). Browsers that don't know the member ignore it, but some Chromium builds ship
 * an older draft of the feature where `swizzle` has a different type, and there creating any
 * texture view throws, so nothing renders. Dropping the identity swizzle changes nothing
 * visually and avoids that failure. The build fails if the pattern disappears (e.g. after a
 * three.js upgrade) so the patch is re-checked rather than silently skipped.
 */
export function threeWebGpuCompat(): Plugin {
  const pattern = /this\.swizzle = 'rgba';/g;
  return {
    name: 'apex-three-webgpu-compat',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]three[\\/]build[\\/]three\.webgpu(\.nodes)?\.js$/.test(id)) return null;
      const matches = code.match(pattern)?.length ?? 0;
      if (matches === 0) {
        this.error(
          'three.js WebGPU compat patch no longer applies: re-check texture view swizzle ' +
            'handling in tools/vite-plugin-three-compat.ts after upgrading three.js.',
        );
      }
      return { code: code.replace(pattern, 'this.swizzle = undefined;'), map: null };
    },
  };
}
