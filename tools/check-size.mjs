// Fails if the build is bigger than the download budget (gzipped code + styles + markup).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 1.5 * 1024 * 1024;
const DIST = new URL('../dist/', import.meta.url).pathname;
const COUNTED = /\.(js|css|html|webmanifest)$/;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

let files;
try {
  files = walk(DIST).filter((f) => COUNTED.test(f));
} catch {
  console.error('dist/ not found: run `npm run build` first.');
  process.exit(1);
}

let total = 0;
const rows = files.map((file) => {
  const gz = gzipSync(readFileSync(file), { level: 9 }).length;
  total += gz;
  return [relative(DIST, file), gz];
});
rows.sort((a, b) => b[1] - a[1]);
for (const [name, size] of rows) console.log(`${(size / 1024).toFixed(1).padStart(8)} KB  ${name}`);
console.log(
  `${(total / 1024).toFixed(1).padStart(8)} KB  total (budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB)`,
);
if (total > BUDGET_BYTES) {
  console.error('Build exceeds the download budget.');
  process.exit(1);
}
