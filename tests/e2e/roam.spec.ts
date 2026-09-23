import { expect, test } from '@playwright/test';

/** Free roam: from the menus into the open world, drive off, with the lights on. */
test('drives into the open world from the menus', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 90_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');
  await page.keyboard.press('Enter');
  await expect.poll(screen).toBe('main');
  await page.getByRole('button', { name: /Free Roam/ }).click();
  await expect.poll(screen).toBe('roamSetup');
  await page.keyboard.press('Enter'); // Drive (focused first)
  await expect.poll(screen, { timeout: 120_000 }).toBe('');
  await expect.poll(() => page.evaluate(() => window.__apex!.mode)).toBe('roam');

  // Headlights and hazards on, then drive off down the avenue.
  await page.keyboard.press('l');
  await page.keyboard.press('x');
  await page.keyboard.down('w');
  await expect
    .poll(() => page.evaluate(() => window.__apex!.speed), { timeout: 30_000 })
    .toBeGreaterThan(5);
  await page.keyboard.up('w');
  expect(errors).toEqual([]);
});
