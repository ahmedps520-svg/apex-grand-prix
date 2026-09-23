import { expect, test, type Page } from '@playwright/test';

/**
 * Controller-only play: a mocked DualSense (standard mapping) drives the menus from the title
 * screen into a race, pauses it and quits, without touching the keyboard or mouse.
 */

// Standard mapping: 0 ✕, 1 ○, 9 Options, 12–15 D-pad up / down / left / right.
const CROSS = 0;
const OPTIONS = 9;
const DPAD_UP = 12;

async function installPad(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const buttons = Array.from({ length: 17 }, () => ({
      pressed: false,
      touched: false,
      value: 0,
    }));
    const pad = {
      id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
      index: 0,
      connected: true,
      mapping: 'standard',
      timestamp: 0,
      axes: [0, 0, 0, 0],
      buttons,
      vibrationActuator: null,
    };
    const w = window as unknown as { __pad: (i: number, down: boolean) => void };
    w.__pad = (i, down) => {
      buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 };
      pad.timestamp = performance.now();
    };
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad], configurable: true });
    window.addEventListener('load', () => {
      window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: pad }));
    });
  });
}

/**
 * Presses a button for one rendered frame, then lets go (holding it longer at a headless
 * frame rate would count as a held button and auto-repeat).
 */
async function press(page: Page, button: number): Promise<void> {
  const frames = () => page.evaluate(() => window.__apex!.frames);
  const settle = async (count: number) => {
    const start = await frames();
    await expect.poll(frames, { timeout: 30_000 }).toBeGreaterThanOrEqual(start + count);
  };
  await page.evaluate(
    (i) => (window as unknown as { __pad: (i: number, d: boolean) => void }).__pad(i, true),
    button,
  );
  await settle(1);
  await page.evaluate(
    (i) => (window as unknown as { __pad: (i: number, d: boolean) => void }).__pad(i, false),
    button,
  );
  await settle(1);
}

test('plays from the title screen to a race and back with only a controller', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await installPad(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 90_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');

  await press(page, CROSS);
  await expect.poll(screen).toBe('main');
  await press(page, CROSS); // Quick Race (focused first)
  await expect.poll(screen).toBe('trackSelect');
  await press(page, CROSS); // first circuit
  await expect.poll(screen).toBe('carSelect');
  await press(page, CROSS); // the selected car
  await expect.poll(screen).toBe('raceSetup');
  await press(page, CROSS); // Start race (focused first)
  await expect.poll(screen, { timeout: 60_000 }).toBe('');
  await expect.poll(() => page.evaluate(() => window.__apex!.mode)).toBe('race');

  await press(page, OPTIONS);
  await expect.poll(screen).toBe('pause');
  // The pause menu wraps: up from Resume is the last item, Quit to main menu.
  await press(page, DPAD_UP);
  await press(page, CROSS);
  await expect.poll(screen, { timeout: 60_000 }).toBe('main');
  expect(errors).toEqual([]);
});

test('a quick controller tap between two frames still counts', async ({ page }) => {
  await installPad(page);
  await page.setViewportSize({ width: 640, height: 360 });
  await page.goto('/?renderer=webgl');
  await page.waitForFunction(() => window.__apex?.ready === true, null, { timeout: 90_000 });
  const screen = () => page.evaluate(() => window.__apex!.screen);
  await expect.poll(screen).toBe('title');
  // A 30 ms tap: far shorter than a frame in a headless browser.
  await page.evaluate(() => {
    const pad = (window as unknown as { __pad: (i: number, d: boolean) => void }).__pad;
    pad(0, true);
    setTimeout(() => pad(0, false), 30);
  });
  await expect.poll(screen).toBe('main');
});
