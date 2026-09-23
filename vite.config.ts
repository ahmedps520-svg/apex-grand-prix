import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { serviceWorkerPlugin } from './tools/vite-plugin-sw.ts';
import { threeWebGpuCompat } from './tools/vite-plugin-three-compat.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

function gitSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  // Relative base so the same build works on GitHub Pages (/apex-grand-prix/) and locally.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version}+${gitSha()}`),
  },
  resolve: {
    // three.js addons import bare 'three'; point it at the WebGPU build so the classic
    // WebGLRenderer isn't bundled as well (three.js's own WebGPU examples map it the same way).
    alias: [{ find: /^three$/, replacement: 'three/webgpu' }],
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
  },
  worker: {
    format: 'es',
  },
  server: {
    host: true,
  },
  // Serve three.js through the plugin pipeline in dev too, so the compat patch applies there.
  optimizeDeps: {
    exclude: ['three'],
  },
  plugins: [threeWebGpuCompat(), serviceWorkerPlugin('src/pwa/sw-template.js')],
});
