# APEX GRAND PRIX

A browser racing game built with TypeScript, Vite and three.js. It renders with WebGPU and falls back to WebGL2 automatically. The physics runs in a Web Worker at 400 Hz, and the game installs as a PWA.

**Play:** https://ahmedps520-svg.github.io/apex-grand-prix/

The game is built in small rounds. [PLAN.md](PLAN.md) has the architecture, the roadmap and a progress log.

## Status

**Round 2: Handling.** The GT test car with F1 25-style handling on a proving ground with a handling loop, a 1 km drag strip (with timing) and a 60 m skidpad. Manual (paddle) or automatic gears, ABS and traction control at Off / Low / High, trigger curves, a telemetry panel, steering wheel support with a setup wizard, and a code-generated engine sound. Keyboard, DualSense/Xbox controllers and steering wheels; installable on iPad (Share → Add to Home Screen) and playable offline after the first visit.

| Action | Keyboard | Controller |
|---|---|---|
| Throttle / brake (hold brake to reverse in auto) | W / S or ↑ / ↓ | R2 / L2 (RT / LT) |
| Steer | A / D or ← / → | Left stick |
| Shift up / down | E / Q | R1 / L1 (RB / LB) |
| Handbrake | Space | ✕ (A) |
| Camera | C | ○ (B) |
| Reset car | R | △ (Y) |
| Quick menu: TC, ABS, gearbox, curves, steering, resolution, volume, location | Tab / Shift+Tab to choose, [ / ] to change | D-pad |
| Telemetry panel | F3 | Touchpad click, or L3 + R3 |
| Handling loop / drag strip / skidpad | 1 / 2 / 3 | Quick menu → Location |
| Steering wheel setup | K | — |
| Performance overlay | \` | Create (View) |
| Sound on / off | M | Quick menu → Volume |
| km/h ↔ mph | U | — |
| Help | H | Options (Menu) |

Steering wheels (Logitech G29/G923 class and others) are detected when connected and set up with a wizard: turn and press each control once, pick the paddles and buttons, then adjust rotation, dead zone, linearity and pedal curves. Wheel steering is 1:1 with the car's steering wheel.

URL options:
- `?renderer=webgl` forces WebGL2.
- `?renderer=webgpu` retries WebGPU after an automatic fallback.
- `?cam=orbit` shows a camera circling the car.

## Development

Requires Node 22+.

```bash
npm ci
npm run dev          # local dev server
npm run check        # typecheck, lint, formatting, unit tests, build, size budget
npm run build && npm run e2e   # browser tests against the production build
```

In a container with a pre-installed Chromium, point the browser tests at it with `PW_CHROMIUM_PATH=/path/to/chromium npm run e2e`.

Project layout: `src/sim` is the simulation (runs in the worker; no DOM or three.js), `src/render` the three.js scene, `src/input` controls, `src/ui` overlays, `src/app` wiring, `src/pwa` the service worker. Tests live in `tests/unit` (Vitest) and `tests/e2e` (Playwright).

All names in the game (cars, teams, tracks) are fictional.
