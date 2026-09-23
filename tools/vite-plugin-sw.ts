import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Writes `sw.js` into the build output after everything else is written. The service worker
 * precaches every emitted file (except source maps), so the game works offline after the first
 * visit. The cache version is a hash of all file names and contents, so any change to the build
 * produces a new service worker, which the app surfaces as "new version available".
 */
export function serviceWorkerPlugin(templatePath: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'apex-service-worker',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    closeBundle() {
      const outDir = resolve(config.root, config.build.outDir);
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => !f.endsWith('.map') && f !== 'sw.js' && !f.endsWith('.DS_Store'))
        .sort();
      const hash = createHash('sha256');
      for (const f of files) {
        hash.update(f);
        hash.update(readFileSync(join(outDir, f)));
      }
      const version = hash.digest('hex').slice(0, 12);
      const urls = ['./', ...files.map((f) => `./${f}`)];
      const source = readFileSync(templatePath, 'utf8')
        .replace('__APEX_VERSION__', JSON.stringify(version))
        .replace('__APEX_PRECACHE__', JSON.stringify(urls));
      writeFileSync(join(outDir, 'sw.js'), source);
    },
  };
}
