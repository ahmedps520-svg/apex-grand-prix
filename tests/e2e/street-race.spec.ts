import { expect, test } from '@playwright/test';

/**
 * Free roam: fast-travel to a festival race, watch the field line up, cross the line into the
 * countdown, and see the race under way on the HUD with the standings.
 */
test('lines up and starts a street race from the festival map', async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 90_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  const phase = () => page.evaluate(() => window.__apex!.roamRace?.phase ?? '');
  await expect.poll(screen).toBe('title');
  await page.keyboard.press('Enter');
  await expect.poll(screen).toBe('main');
  await page.getByRole('button', { name: /Free Roam/ }).click();
  await expect.poll(screen).toBe('roamSetup');
  await page.keyboard.press('Enter'); // Drive
  await expect.poll(screen, { timeout: 120_000 }).toBe('');
  await expect.poll(() => page.evaluate(() => window.__apex!.mode)).toBe('roam');

  // Fast travel to a race: the rivals line up past the line.
  await page.keyboard.press('Escape');
  await expect.poll(screen).toBe('pause');
  await page.getByRole('button', { name: /Festival map/ }).click();
  await expect.poll(screen).toBe('map');
  await page.getByRole('button', { name: /Race: Downtown Dash/ }).click();
  await expect.poll(screen, { timeout: 30_000 }).toBe('');
  await expect.poll(phase, { timeout: 30_000 }).toBe('grid');
  expect(await page.evaluate(() => window.__apex!.roamRace?.count)).toBeGreaterThanOrEqual(3);

  // Over the line: onto the grid, the sweep, then the count and the race.
  await page.keyboard.down('w');
  await expect.poll(phase, { timeout: 60_000 }).toBe('countdown');
  await page.keyboard.up('w');
  await expect
    .poll(() => page.evaluate(() => window.__apex!.roamRace?.placed ?? false), {
      timeout: 30_000,
    })
    .toBe(true);
  await expect(page.locator('.fest')).toContainText(/GET READY|Standing start/);
  await expect.poll(phase, { timeout: 60_000 }).toBe('racing');
  await page.keyboard.down('w');
  await expect(page.locator('.fest')).toContainText(/P[1-9] · /, { timeout: 30_000 });
  await expect(page.locator('.fest-standings')).toContainText('You');
  await expect
    .poll(() => page.evaluate(() => window.__apex!.roamRace?.progress ?? 0), { timeout: 30_000 })
    .toBeGreaterThan(30);
  await page.keyboard.up('w');
  expect(errors).toEqual([]);
});
