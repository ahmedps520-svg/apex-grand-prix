import { expect, test } from '@playwright/test';

/** From the title screen to a running race with only the keyboard, then pause and resume. */
test('starts a quick race from the menus and pauses it', async ({ page }) => {
  // The menus render their 3D backdrop at a frame or two a second in software GL: the walk to
  // a race takes a while on CI.
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');

  await page.keyboard.press('Enter');
  await expect.poll(screen).toBe('main');
  await page.keyboard.press('Enter'); // Quick Race (focused first)
  await expect.poll(screen).toBe('trackSelect');
  await page.keyboard.press('Enter'); // first circuit
  await expect.poll(screen).toBe('carSelect');
  await page.keyboard.press('Enter'); // the selected car
  await expect.poll(screen).toBe('raceSetup');
  await page.keyboard.press('Enter'); // Start race
  await expect.poll(screen, { timeout: 30_000 }).toBe('');
  await expect.poll(() => page.evaluate(() => window.__apex!.mode)).toBe('race');
  expect(await page.evaluate(() => window.__apex!.cars)).toBeGreaterThan(1);
  await expect
    .poll(() => page.evaluate(() => window.__apex!.race?.phase ?? ''), { timeout: 60_000 })
    .toBe('racing');

  await page.keyboard.press('Escape');
  await expect.poll(screen).toBe('pause');
  // An Enter that lands while the screen is still coming in can be lost: the focus is checked first.
  const focused = () =>
    page.evaluate(() => document.querySelector('.nav-focus')?.textContent?.trim() ?? '');
  await expect.poll(focused).toMatch(/Resume/);
  await page.keyboard.press('Enter'); // Resume
  await expect.poll(screen).toBe('');
  expect(errors).toEqual([]);
});
