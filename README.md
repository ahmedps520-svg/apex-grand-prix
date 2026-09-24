# APEX GRAND PRIX

A browser racing game built with TypeScript, Vite and three.js. It renders with WebGPU and falls back to WebGL2 automatically. The physics runs in a Web Worker at 400 Hz, and the game installs as a PWA.

**Play:** https://ahmedps520-svg.github.io/apex-grand-prix/

[PLAN.md](PLAN.md) has the architecture, the roadmap and a progress log.

## The game

Starts with a short studio and logo intro (any button skips it), then a title screen that circles your car on the grid while generated synthwave music plays. The menus are tiles and bars, not paragraphs, with sounds and a light rumble when you select.

- **Quick Race:** pick a circuit and a car, 1–11 AI opponents, laps, difficulty and grid slot. A flyover of the circuit leads into the grid; standing start with five red lights, positions, lap and sector timing; the top three take the podium under confetti before the results.
- **Championship:** a season of 3 to 6 races with points for the top ten (25-18-15-12-10-8-6-4-2-1); the grid lines up in championship order and a season in progress is saved.
- **Time Trial:** hot laps with sector splits against your best and the stored track record, chasing a ghost of your best lap.
- **Free Roam:** an open world streamed around you as you drive: a downtown grid of avenues and towers, an elevated orbital highway with on/off ramps at four interchanges, suburbs, an industrial port on the sea, a mountain road winding up the ridge, and the club circuit joined to the roads. Day, night or any weather (the day's clock can run on the circuits too, from the race and time trial setups: a race that starts in golden hour finishes under the stars, with every car's headlights on after dark); a speed-limit sign on the HUD and a road minimap; headlights, indicators, hazards and a horn. Traffic shares the roads: everyday cars that keep to their lanes and the limits, follow the car ahead, obey the signals (real cycles), stop signs and give-way rules, indicate before turning, show brake lights, and put their hazards on when you hit them (which hurts your car). The police patrol among the traffic: speed past one, run a red light or crash into traffic in its sight and your heat rises (up to five stars); units give chase with sirens and lights, line up a PIT on your rear quarter, box you in, and from three stars park roadblocks across the road ahead, with spike strips from four. Break their line of sight for long enough and you get away; stop beside them and you are busted and pay the fine. From four stars a helicopter circles overhead with a searchlight after dark and keeps you in sight wherever you drive, except under the orbital's deck. Traffic near a siren slows and pulls over to the right until it has passed. Pedestrians walk the pavements downtown (on tablets and desktops), cross at the junctions when the lights or a gap allow, and leap clear of anything bearing down on them; the traffic stops for anyone in the road. Lean on the horn behind a car and it pulls over; anyone crossing hurries, and anyone at the kerb waits. The nearest cars are heard: traffic, police and rivals have engine notes that fade with distance and sit left or right of you. After dark the headlights come on by themselves. The day can run (a day in 24 minutes or in an hour, or the time chosen stands still): the sun crosses the sky, golden hour turns to dusk and night, the lamps and the windows come on and the headlights with them (the traffic's too), dawn puts them out, and the HUD shows the time; at night the stars come out and a moon hangs opposite the sun. The weather can move too (on by default in free roam, a choice on the circuits): every few minutes the sky steps a rung from clear towards heavy rain or back, the change coming in over most of a minute, the road's grip and the rivals' pace following it, with a word as rain comes in or eases off. The first drive gives a few hints (lights, the festival map, the police, the races), once. Crashes deform your car for real: a node-and-beam soft body under the shell crumples the ends and keeps the crumple, a bent chassis pulls the steering, a crushed corner wrecks that suspension and can burst the tyre, the engine and aero suffer, and the bumpers, bonnet, doors and wing come off and lie where they fall; traffic takes simpler dents. R (△) resets and repairs. Events follow in later pushes.
- **Arcade handling** (a Handling choice in every mode's setup; Sim stays the default): more grip and less drag, slides that keep most of their grip so a drift is something you steer rather than a spin (the rear sliding damps the yaw and the steering holds the drift), a nitro tank you burn with the boost button and refill by waiting, and a lighter car in the air that the stick pitches and yaws. Skill points score drifts, near misses with the traffic, sustained speed, air time and smashed festival cones (on the junction corners of the city), chained into a multiplier that a crash loses. The AI in an arcade race drives the same physics, and rubber-bands to you: rivals behind push on and rivals ahead ease off, within limits, so the race stays close.
- **The festival** (free roam): events stand on the roads and show on the minimap: speed cameras that register your speed as you pass, drift zones that bank a drift's points when you leave them, jump ramps behind danger signs that measure the flight from the lip, and point-to-point races (and laps of the orbital and the circuit) through checkpoints against the clock, with gold, silver and bronze times, and against rivals: drive up to a race's arch and a field of street racers lines up on the grid past it; cross the line and you are put on your own slot at the back for a standing start: the camera sweeps over the field (any press skips it), then the count. Win and the confetti falls while the camera circles your car. They brake for the corners, take the inside, move over for the traffic (or pass it), give each other room, and keep the race close whether you are ahead or behind; the HUD shows your position and time with the field in order under it (names and gaps), and the flag brings up the results with everyone's time and your position (a win pays 1000 skill points in arcade). Your bests are kept in the browser. Pause → Festival map shows the whole city with every event and start, how many events you have a result in and your medals, and fast-travels you to any of them. Free Roam remembers where you left the car (and the car, the time on the clock and the weather): the setup screen offers Continue where you left off. The proving ground (handling loop, timed 1 km drag strip, 60 m skidpad) is still there under Free Roam → Proving ground.
- **Driving school:** offered on the first visit and always in the menu. Throttle, braking, staying on track, the racing line, braking zones, DRS and ERS, each a button prompt and a progress bar rather than a paragraph, in a junior formula car on the club circuit.
- **Circuits:** eight fictional tracks, from a 2.5 km club circuit to a 5.5 km high-speed autodrome, a street circuit, a roval and a desert finale, with kerbs, gravel or grass run-off, barriers, grandstands and working start lights.
- **Replays:** watch the race again from TV cameras, a chase camera or onboard, at 0.25× to 4×, following any car. Between races, the menus show an AI race from the TV cameras.
- **Cars:** 30 cars in six classes (GT, Formula, Prototype, Touring sedans, Street and all-wheel-drive SUVs), each with its own power, weight, grip and aero.
- **Grids:** race everyone in your car, a mixed field from your class, or two classes at once (the faster class starts in front).
- **Liveries:** design your own (pattern, three colours, race number, gloss, matte, metallic or pearl finish) or pick a preset; every rival gets its own look.
- **Weather and time of day:** morning to night, clear to heavy rain. Rain darkens and wets the track, cuts grip for you and the AI, and throws up spray.
- **Damage:** off, light or full. Crashes cost downforce, power or steering alignment, shown on the HUD and called out by the race engineer.
- **Photo mode:** from the pause menu: free camera, depth of field, exposure, filters, and save the shot as a PNG.
- **Handling:** a 400 Hz physics model with Pacejka tyres, limited-slip diff, ABS/TC Off/Low/High, manual paddles or automatic gears. Formula and Prototype cars have DRS (open it in the zones when you are within a second of the car ahead) and an ERS boost that recharges under braking; the AI uses both.
- **Controls:** keyboard, DualSense/Xbox controllers (with rumble on Chrome/Edge) and steering wheels (setup wizard, 1:1 steering). Menus work with a controller, keyboard, mouse or touch; buttons and keys can be rebound. On an iPad or phone: on-screen pedals and paddles, and steering by dragging on the left half of the screen or by tilting the device (Settings → Controls; iPadOS asks for motion access on the first tap); in free roam a row at the top left works the lights, the indicators, the hazards, the horn and the festival map, and CAM and RESET sit beside the pause button in every mode, with MENU ▲ ▼ under them for the quick menu (TC, ABS, gearbox and the rest).
- **Installable:** add it to the home screen (iPad: Share → Add to Home Screen); it works offline after the first visit.

| Action | Keyboard | Controller |
|---|---|---|
| Throttle / brake (hold brake to reverse in auto) | W / S or ↑ / ↓ | R2 / L2 (RT / LT) |
| Steer | A / D or ← / → | Left stick |
| Shift up / down | E / Q | R1 / L1 (RB / LB) |
| Handbrake | Space | ✕ (A) |
| DRS / ERS boost (arcade: hold for nitro) | F / B | □ (X) / L3 |
| Headlights / hazards (free roam) | L / X | D-pad up / down |
| Indicators (free roam) | , / . | D-pad left / right |
| Horn (free roam) | N | R3 |
| Pause menu | Esc or P | Options (Menu) |
| Camera | C | ○ (B) |
| Reset car (free roam: repairs it too) | R | △ (Y) |
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
- `?cinematics` plays the race flyover and podium in automated browsers, which skip them otherwise.

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
