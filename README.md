# APEX GRAND PRIX

A browser racing game built with TypeScript, Vite and three.js. It renders with WebGPU and falls back to WebGL2 automatically. The physics runs in a Web Worker at 400 Hz, and the game installs as a PWA.

**Play:** https://ahmedps520-svg.github.io/apex-grand-prix/

[PLAN.md](PLAN.md) has the architecture, the roadmap and a progress log.

## The game

- **Quick Race:** pick a circuit and a car, 1–11 AI opponents, laps, difficulty and grid slot. Standing start with five red lights, positions, lap and sector timing, results.
- **Championship:** a season of 3 to 6 races with points for the top ten (25-18-15-12-10-8-6-4-2-1); the grid lines up in championship order and a season in progress is saved.
- **Time Trial:** hot laps with sector splits against your best and the stored track record, chasing a ghost of your best lap.
- **Free Drive:** the proving ground with a handling loop, a timed 1 km drag strip and a 60 m skidpad.
- **Circuits:** eight fictional tracks, from a 2.5 km club circuit to a 5.5 km high-speed autodrome, a street circuit, a roval and a desert finale, with kerbs, gravel or grass run-off, barriers, grandstands and working start lights.
- **Replays:** watch the race again from TV cameras, a chase camera or onboard, at 0.25× to 4×, following any car. Between races, the menus show an AI race from the TV cameras.
- **Cars:** 30 cars in six classes (GT, Formula, Prototype, Touring sedans, Street and all-wheel-drive SUVs), each with its own power, weight, grip and aero.
- **Grids:** race everyone in your car, a mixed field from your class, or two classes at once (the faster class starts in front).
- **Liveries:** design your own (pattern, three colours, race number, gloss, matte, metallic or pearl finish) or pick a preset; every rival gets its own look.
- **Weather and time of day:** morning to dusk, clear to heavy rain. Rain darkens and wets the track, cuts grip for you and the AI, and throws up spray.
- **Damage:** off, light or full. Crashes cost downforce, power or steering alignment, shown on the HUD and called out by the race engineer.
- **Photo mode:** from the pause menu: free camera, depth of field, exposure, filters, and save the shot as a PNG.
- **Handling:** a 400 Hz physics model with Pacejka tyres, limited-slip diff, ABS/TC Off/Low/High, manual paddles or automatic gears.
- **Controls:** keyboard, DualSense/Xbox controllers (with rumble on Chrome/Edge) and steering wheels (setup wizard, 1:1 steering). Menus work with a controller, keyboard, mouse or touch; buttons and keys can be rebound.
- **Installable:** add it to the home screen (iPad: Share → Add to Home Screen); it works offline after the first visit.

| Action | Keyboard | Controller |
|---|---|---|
| Throttle / brake (hold brake to reverse in auto) | W / S or ↑ / ↓ | R2 / L2 (RT / LT) |
| Steer | A / D or ← / → | Left stick |
| Shift up / down | E / Q | R1 / L1 (RB / LB) |
| Handbrake | Space | ✕ (A) |
| Pause menu | Esc or P | Options (Menu) |
| Camera | C | ○ (B) |
| Reset car | R | △ (Y) |
| Quick menu: TC, ABS, gearbox, curves, steering, volume | Tab / Shift+Tab, then [ / ] | D-pad |
| Telemetry panel | F3 | Touchpad click, or L3 + R3 |
| Performance overlay | \` | Create (View) |
| Steering wheel setup | K | Settings → Wheel |

In menus: arrows / D-pad / left stick move, Enter / ✕ select, Esc / ○ back, Q / E or L1 / R1 switch tabs.

URL options:
- `?renderer=webgl` forces WebGL2.
- `?renderer=webgpu` retries WebGPU after an automatic fallback.
- `?drive` skips the menus and starts free driving (used by the browser tests).
- `?autopilot` lets the AI drive your car in races (for demos and tests).

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
