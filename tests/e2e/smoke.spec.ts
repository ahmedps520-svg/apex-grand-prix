import { expect, test, type Page } from '@playwright/test';
import { decodePng, imageStats } from './png';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function waitUntilReady(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
}

const variants = [
  { name: 'automatic renderer choice', query: '' },
  { name: 'forced WebGL2', query: '?renderer=webgl' },
];

for (const variant of variants) {
  test(`boots, renders and drives (${variant.name})`, async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto(`/${variant.query}`);
    await waitUntilReady(page);

    const backend = await page.evaluate(() => window.__apex!.backend);
    expect(['WebGPU', 'WebGL2']).toContain(backend);
    if (variant.query) expect(backend).toBe('WebGL2');

    // Hide the help card and performance overlay so the check looks at the 3D view.
    await page.keyboard.press('KeyH');
    await page.keyboard.press('Backquote');
    await page.waitForTimeout(1500);
    const stats = imageStats(decodePng(await page.screenshot()));
    expect(stats.luminanceStdDev, 'the frame should not be blank').toBeGreaterThan(12);
    expect(stats.distinctColors, 'the frame should have real detail').toBeGreaterThan(150);

    const stepsBefore = await page.evaluate(() => window.__apex!.simSteps);
    await page.keyboard.down('KeyW');
    await expect
      .poll(() => page.evaluate(() => window.__apex!.speed), { timeout: 45_000 })
      .toBeGreaterThan(5);
    await page.keyboard.up('KeyW');
    const stepsAfter = await page.evaluate(() => window.__apex!.simSteps);
    expect(stepsAfter).toBeGreaterThan(stepsBefore);
    expect(errors).toEqual([]);
  });
}

test('keyboard reset puts the car back on the start line', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/?renderer=webgl');
  await waitUntilReady(page);
  await page.keyboard.down('KeyW');
  await expect
    .poll(() => page.evaluate(() => window.__apex!.speed), { timeout: 45_000 })
    .toBeGreaterThan(3);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('KeyR');
  await expect
    .poll(() => page.evaluate(() => Math.abs(window.__apex!.speed)), { timeout: 20_000 })
    .toBeLessThan(0.1);
  expect(errors).toEqual([]);
});
