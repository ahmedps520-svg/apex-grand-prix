import { expect, test, type Locator } from '@playwright/test';

test.use({ hasTouch: true });

/**
 * Taps into the next screen. A slow machine can lose a tap that lands while a screen is still
 * coming in, as a finger would; a tap that didn't move the screen on is repeated, up to three.
 */
async function tapInto(
  locator: Locator,
  expected: string,
  screen: () => Promise<string>,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await locator.tap();
    try {
      await expect.poll(screen, { timeout: 8000 }).toBe(expected);
      return;
    } catch {
      // Once more.
    }
  }
  await expect.poll(screen).toBe(expected);
}

/** On a touch screen the menus can be walked with taps alone: in through the tiles, back out. */
test('goes through the menus and back with taps on a touch screen', async ({ page }) => {
  // The menus render their 3D backdrop at a frame or two a second in software GL, and every
  // tap waits for a couple of frames before it lands: nine screens take a while on CI.
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');

  await tapInto(page.locator('[data-nav]', { hasText: /^Start$/ }).first(), 'main', screen);
  // No way back from the main menu: no Back button there.
  await expect(page.locator('[data-touch-back]')).toHaveCount(0);

  await tapInto(page.locator('.mn-tile', { hasText: /Free Roam/ }).first(), 'roamSetup', screen);
  const back = page.locator('[data-touch-back]');
  await expect(back).toHaveText(/Back/);
  // The festival board opens from the roam setup and comes back to it.
  await tapInto(page.locator('[data-nav]', { hasText: /Festival board/ }).first(), 'board', screen);
  await expect(page.locator('.mn-board-group h3', { hasText: /Races/ })).toHaveCount(1);
  await back.tap();
  await expect.poll(screen).toBe('roamSetup');
  await back.tap();
  await expect.poll(screen).toBe('main');

  await tapInto(
    page.locator('.mn-tile', { hasText: /Quick race/i }).first(),
    'trackSelect',
    screen,
  );
  await tapInto(
    page.locator('[data-nav]', { hasText: /Merriford Park/ }).first(),
    'carSelect',
    screen,
  );
  // The footer's Back prompt is a tap too.
  await page.locator('.menu-prompt.tappable', { hasText: /Back/ }).first().tap();
  await expect.poll(screen).toBe('trackSelect');
  await page.locator('[data-touch-back]').tap();
  await expect.poll(screen).toBe('main');
  expect(errors).toEqual([]);
});
