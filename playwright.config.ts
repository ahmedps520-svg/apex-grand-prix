import { defineConfig, devices } from '@playwright/test';

// In the Claude Code container Chromium is pre-installed; point PW_CHROMIUM_PATH at it
// (e.g. /opt/pw-browsers/chromium). CI uses Playwright's own download.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 960, height: 540 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Serves the production build (run `npm run build` first).
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 960, height: 540 },
        launchOptions: {
          executablePath,
          // Software WebGL in headless mode. WebGPU isn't exposed without extra flags, so the
          // default URL exercises the automatic WebGL2 fallback.
          args: [
            '--use-angle=swiftshader',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      },
    },
  ],
});
