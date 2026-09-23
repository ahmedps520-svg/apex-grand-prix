import { defineConfig } from 'vitest/config';

/** Slow tools that run the simulation offline: `npx vitest run -c tools/vitest.config.ts`. */
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
    environment: 'node',
    testTimeout: 3_600_000,
  },
});
