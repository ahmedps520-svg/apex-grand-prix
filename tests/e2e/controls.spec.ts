import { expect, test, type Page } from '@playwright/test';

/** Round 2 controls: telemetry, quick menu, manual gears, teleports and wheel setup. */

async function boot(page: Page, query = '?renderer=webgl&drive'): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  return errors;
}

const debug = (page: Page) =>
  page.evaluate(() => ({ ...window.__apex!, menu: { ...window.__apex!.menu } }));

test('F3 toggles the telemetry panel with live per-wheel data', async ({ page }) => {
  const errors = await boot(page);
  const panel = page.locator('.telemetry');
  await expect(panel).toBeHidden();
  await page.keyboard.press('F3');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('FL');
  await expect(panel).toContainText('Load kN');
  await page.keyboard.down('KeyW');
  await expect(panel).toContainText(/Throttle in/);
  await expect.poll(async () => (await debug(page)).speed, { timeout: 30_000 }).toBeGreaterThan(3);
  await page.keyboard.up('KeyW');
  await page.keyboard.press('F3');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('quick menu changes traction control and remembers it after a reload', async ({ page }) => {
  const errors = await boot(page);
  await page.keyboard.press('Tab'); // opens the menu on its first item
  await expect.poll(async () => (await debug(page)).menu.visible).toBe(true);
  expect((await debug(page)).menu.label).toBe('Traction control');
  expect((await debug(page)).menu.value).toBe('High');
  await page.keyboard.press('BracketLeft');
  await expect.poll(async () => (await debug(page)).menu.value).toBe('Low');
  await expect.poll(async () => (await debug(page)).tcLevel).toBe(1);

  await page.reload();
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 60_000 });
  await expect.poll(async () => (await debug(page)).tcLevel).toBe(1);
  expect(errors).toEqual([]);
});

test('manual gearbox: E and Q change gear, Q at a standstill selects reverse', async ({ page }) => {
  const errors = await boot(page);
  // Tab opens the menu, Tab Tab moves to "Gearbox", ] switches it to manual.
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await debug(page)).menu.label).toBe('Gearbox');
  await page.keyboard.press('BracketRight');
  await expect.poll(async () => (await debug(page)).manualGearbox).toBe(true);
  expect((await debug(page)).gear).toBe(1);
  await page.keyboard.press('KeyE');
  await expect.poll(async () => (await debug(page)).gear).toBe(2);
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => (await debug(page)).gear).toBe(1);
  await page.keyboard.press('KeyQ');
  await expect.poll(async () => (await debug(page)).gear).toBe(-1);
  expect(errors).toEqual([]);
});

test('number keys teleport to the drag strip and the skidpad', async ({ page }) => {
  const errors = await boot(page);
  await page.keyboard.press('Digit2');
  await expect.poll(async () => (await debug(page)).x, { timeout: 10_000 }).toBeLessThan(-100);
  await page.keyboard.press('Digit3');
  await expect.poll(async () => (await debug(page)).z, { timeout: 10_000 }).toBeLessThan(-400);
  await page.keyboard.press('Digit1');
  await expect
    .poll(async () => Math.abs((await debug(page)).x), { timeout: 10_000 })
    .toBeLessThan(1);
  expect(errors).toEqual([]);
});

test('a steering wheel opens the setup wizard, which calibrates it', async ({ page }) => {
  // A simulated G29: steering on axis 0, pedals on axes 2 and 5 resting at +1.
  await page.addInitScript(() => {
    const wheel = {
      id: 'G29 Driving Force Racing Wheel (Vendor: 046d Product: c24f)',
      index: 0,
      connected: true,
      mapping: '',
      timestamp: 1,
      axes: [0, 0, 1, 0, 0, 1, 0, 0, 0, 1.2857],
      buttons: Array.from({ length: 24 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { __wheel: typeof wheel }).__wheel = wheel;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [wheel], configurable: true });
  });
  const errors = await boot(page);
  const setup = page.locator('.wheel-setup');
  await expect(setup).toBeVisible();
  await expect(setup).toContainText('Centre the wheel');

  const setAxis = (axis: number, value: number) =>
    page.evaluate(
      ([a, v]) => {
        (window as unknown as { __wheel: { axes: number[] } }).__wheel.axes[a!] = v!;
      },
      [axis, value],
    );
  const detected = page.locator('.ws-detected');
  const next = () => page.getByRole('button', { name: 'Next' }).click();
  /** Moves an axis, waits until the wizard has seen it, then lets it go back. */
  const sweep = async (axis: number, to: number, rest: number) => {
    await setAxis(axis, to);
    await expect(detected).toContainText(`Axis ${axis}`);
    await setAxis(axis, rest);
    await page.waitForTimeout(250); // a few frames at the rest position
  };
  await page.waitForTimeout(250);
  await next(); // centre
  await sweep(0, -1, 0);
  await next(); // left
  await sweep(0, 1, 0);
  await next(); // right
  await sweep(2, -1, 1);
  await next(); // throttle
  await sweep(5, -1, 1);
  await next(); // brake
  await page.getByRole('button', { name: 'Skip' }).click(); // no clutch
  // Skip all the button bindings.
  while (await page.getByRole('button', { name: 'Skip' }).isVisible()) {
    await page.getByRole('button', { name: 'Skip' }).click();
  }
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(setup).toContainText('Wheel settings');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(setup).toBeHidden();

  // Now the wheel drives: half throttle on axis 2 moves the car, steering reaches the car.
  await setAxis(2, 0);
  await expect.poll(async () => (await debug(page)).speed, { timeout: 30_000 }).toBeGreaterThan(2);
  const saved = await page.evaluate(() => localStorage.getItem('apex-gp.settings') ?? '');
  expect(saved).toContain('G29 Driving Force Racing Wheel');
  expect(errors).toEqual([]);
});
