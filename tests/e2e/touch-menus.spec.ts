import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });

/** On a touch screen the menus can be walked with taps alone: in through the tiles, back out. */
test('goes through the menus and back with taps on a touch screen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');

  await page
    .locator('[data-nav]', { hasText: /^Start$/ })
    .first()
    .tap();
  await expect.poll(screen).toBe('main');
  // No way back from the main menu: no Back button there.
  await expect(page.locator('[data-touch-back]')).toHaveCount(0);

  await page
    .locator('.mn-tile', { hasText: /Free Roam/ })
    .first()
    .tap();
  await expect.poll(screen).toBe('roamSetup');
  const back = page.locator('[data-touch-back]');
  await expect(back).toHaveText(/Back/);
  await back.tap();
  await expect.poll(screen).toBe('main');

  await page
    .locator('.mn-tile', { hasText: /Quick race/i })
    .first()
    .tap();
  await expect.poll(screen).toBe('trackSelect');
  await page
    .locator('[data-nav]', { hasText: /Merriford Park/ })
    .first()
    .tap();
  await expect.poll(screen).toBe('carSelect');
  // The footer's Back prompt is a tap too.
  await page.locator('.menu-prompt.tappable', { hasText: /Back/ }).first().tap();
  await expect.poll(screen).toBe('trackSelect');
  await page.locator('[data-touch-back]').tap();
  await expect.poll(screen).toBe('main');
  expect(errors).toEqual([]);
});
