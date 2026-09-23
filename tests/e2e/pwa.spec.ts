import { expect, test } from '@playwright/test';

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: Array<{ src: string; sizes: string; purpose?: string }>;
}

test('has a valid web app manifest and icons', async ({ page, request }) => {
  await page.goto('/?renderer=webgl');
  const href = await page.getAttribute('link[rel="manifest"]', 'href');
  expect(href).toBeTruthy();
  const manifestUrl = new URL(href!, page.url()).href;
  const manifest = (await (await request.get(manifestUrl)).json()) as Manifest;
  expect(manifest.name).toBe('APEX GRAND PRIX');
  expect(manifest.start_url).toBe('./');
  expect(['fullscreen', 'standalone']).toContain(manifest.display);
  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
  for (const icon of manifest.icons) {
    const response = await request.get(new URL(icon.src, manifestUrl).href);
    expect(response.ok(), icon.src).toBe(true);
    expect(response.headers()['content-type']).toContain('image/png');
  }
  const touchIcon = await page.getAttribute('link[rel="apple-touch-icon"]', 'href');
  expect((await request.get(new URL(touchIcon!, page.url()).href)).ok()).toBe(true);
});

test('works offline after the first visit', async ({ page, context }) => {
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  // Wait until the service worker has installed (precached the build) and activated.
  await page.waitForFunction(
    async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration?.active) return false;
      const keys = await caches.keys();
      return keys.some((k) => k.startsWith('apex-gp-'));
    },
    null,
    { timeout: 60_000 },
  );

  await context.setOffline(true);
  try {
    await page.reload();
    await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__apex!.frames)).toBeGreaterThan(2);
  } finally {
    await context.setOffline(false);
  }
});
