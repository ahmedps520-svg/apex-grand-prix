# APEX GRAND PRIX

A browser racing game built with TypeScript, Vite and three.js. It renders with WebGPU and falls back to WebGL2 automatically. The physics runs in a Web Worker at 400 Hz, and the game installs as a PWA.

**Play:** https://ahmedps520-svg.github.io/apex-grand-prix/

The game is built in small rounds. [PLAN.md](PLAN.md) has the architecture, the roadmap and a progress log.

## Status

**Round 1: Foundations.** Drive a GT-style test car on a proving ground. Keyboard, DualSense/Xbox controllers, installable on iPad (Share → Add to Home Screen) and playable offline after the first visit.

| Action | Keyboard | Controller |
|---|---|---|
| Throttle / brake (hold brake to reverse) | W / S or ↑ / ↓ | R2 / L2 (RT / LT) |
| Steer | A / D or ← / → | Left stick |
| Handbrake | Space | ✕ (A) |
| Camera | C | ○ (B) |
| Reset car | R | △ (Y) |
| Performance overlay | F3 or \` | Create (View) |
| Resolution scale | [ / ] | D-pad ↑ / ↓ |
| km/h ↔ mph | U | — |
| Help | H | Options (Menu) |

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
