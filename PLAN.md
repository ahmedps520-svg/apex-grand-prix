# APEX GRAND PRIX: Master Plan

> **Status:** Rounds 1–2 and Pushes 3–6 merged. **Change of approach (your call after Round 2):** no more small rounds with a checklist each; the game is now built toward a complete, publishable release in large pushes, following the vision in order of impact: menus, circuits, game modes and AI first, then more cars and circuits, liveries, weather, touch controls and the rest. See the progress log (§10).
> This plan changes as we go. I update it at the end of every round with status, decisions and what we learned.

**TL;DR**
- A browser racing game built with TypeScript, Vite and three.js. It renders with WebGPU and falls back to WebGL2 automatically. Physics runs in a Web Worker at 400 Hz. It installs as a PWA and is hosted on GitHub Pages.
- We build it in **24 small rounds**. Every round ends with a playable build at a public URL, automated checks, and a checklist for you to test on PC and iPad.
- The physics can be excellent. The visuals can be polished, but not "AAA art", because there are no artists and no licensed models. Some parts of the vision don't work in browsers as written: real-time ray tracing, rumble on iPad and steering-wheel force feedback. §2 explains each one and what we'll do instead.

---

## 0. Starting point

At the start of Round 0 the repository `ahmedps520-svg/apex-grand-prix` was **empty**: no commits, no branches, no files. `PLAN.md` was the first commit. Now:
- `main` holds the released game and deploys to GitHub Pages: `https://ahmedps520-svg.github.io/apex-grand-prix/`.
- Each round is built on `claude/eloquent-hypatia-2dn5u6` and merged into `main` through one pull request.

---

## 1. How we work

**The round loop** (agreed after Round 0)
1. **Start of round:** I post a short plan for the round (what I'll build and the acceptance checks), then build it without waiting. I apply your feedback from the last round first: bugs, then handling feel, then priorities.
2. I build only that round's scope and keep everything from earlier rounds working.
3. I open **one pull request per round** into `main`. CI runs the automated checks on it. Once they pass, I merge it myself, and `main` deploys to GitHub Pages automatically.
4. **End of round:** I post what works, what's broken or rough, the deployed link and the test checklist.
5. You test and reply with bugs before the next round. If a round turns out bigger than expected, I split it instead of cutting corners.

**Definition of done (every round)**
- All of the round's acceptance checks pass. Automated checks run in CI; you do the manual ones.
- The build is deployed and the browser console shows no errors.
- It works in Chrome/Edge on PC and Safari on iPad. Every new screen can be used with a controller alone.
- New settings have sensible defaults, are saved, and are included in save export and import.
- The standing checks below still pass.

**Standing checks.** These form a regression suite that grows over time.

| # | Check | From round |
|---|---|---|
| S1 | The game starts with no console errors: in headless Chromium in CI, and on your Chrome/Edge and iPad | 1 |
| S2 | Physics fuzz test: long runs with random inputs never produce NaN values or "explosions" | 1 |
| S3 | Every car's physics benchmark numbers stay inside its class targets (§5.4) | 2 |
| S4 | A simulated controller walks the whole menu tree: no dead ends, focus always visible, Back always works | 3 |
| S5 | Save files from every earlier round still load (a test save from each round is kept) | 3 |
| S6 | Entering and leaving a session 10 times returns memory use (JS heap and GPU resources) to its starting level | 4 |
| S7 | Benchmark results are no more than 5 % worse than the previous round | 11 |

**What I can and can't check myself.** I work in a cloud container with no real GPU, controller, wheel or iPad. I can check game logic and physics numbers, and I can render in headless Chromium: WebGL2 in software, and WebGPU too if its software adapter works there. I **can't** feel the handling or the rumble, and I can't measure frame rates on your devices. So your feedback is how we tune the game. Every round includes tools that make your reports precise: a performance overlay, telemetry, a controller tester, and from Round 11 a built-in benchmark whose results you can copy and paste to me.

---

## 2. Reality check: the vision vs. what browsers can do

| Vision item | Browser reality (September 2026) | What we'll do |
|---|---|---|
| WebGPU renderer with WebGL2 fallback | Chrome and Edge ship WebGPU on Windows and macOS. Safari has it from version 26, which includes iPadOS 26. iPads that can't run iPadOS 26 only have WebGL2. | three.js `WebGPURenderer` uses WebGPU when available and switches to its WebGL2 backend automatically. A setting can force WebGL2. |
| Real-time ray-traced reflections and AO via compute shaders | No browser API gives access to ray-tracing hardware. Ray tracing in compute shaders works, but it's far too slow for a 20-car scene at 60 fps on an iPad. | Screen-space reflections (SSR) and GTAO ambient occlusion, which work on both backends, plus reflection probes and cheaper tricks for wet roads. Real path tracing only in photo mode. |
| Path-traced photo mode | Possible as a progressive render that takes seconds to a minute per image. The mature library for this (three-gpu-pathtracer) only supports WebGL2. | Photo mode opens a separate WebGL2 canvas with a converted copy of the scene. Experimental, and planned for a late round. |
| Compute-shader effects | WebGPU only. | GPU particles and clustered lights (hundreds of lights, e.g. floodlights) on WebGPU. Simpler versions on WebGL2: particles computed on the CPU, lighting pre-computed. |
| 120+ fps on PC | Browsers never render faster than the display's refresh rate. There is no uncapped mode. | 120+ fps needs a 120 or 144 Hz monitor. We aim for the refresh rate, helped by dynamic resolution. |
| 60 fps on iPad | By default Safari caps animation at 60 fps, even on 120 Hz iPads, and at a lower rate in Low Power Mode. Safari reloads a tab that uses too much memory, often well under 2 GB. | 60 fps is the iPad target. Strict memory budget. A battery-saver mode. |
| Physics in a worker at 400 Hz | Works. But controller input can only be read on the main thread, so inputs arrive at display rate (60 to 144 times a second). Shared memory between threads (`SharedArrayBuffer`) requires server settings GitHub Pages doesn't allow. | The main thread reads input every frame and sends it to the worker, which smooths it across its 400 Hz steps. Results come back in buffers handed between threads without copying (transferable buffers), so shared memory isn't needed. |
| Controller rumble | Chrome and Edge support two-motor rumble on common Xbox and PlayStation pads (we confirm yours in Round 3). They also support trigger rumble on Xbox controllers under Windows (Chrome 126+). Safari on the Mac supports two-motor rumble. **Safari on iPad has no controller rumble.** No browser exposes DualSense adaptive triggers or HD haptics. | Rumble is used only where the browser supports it. On iPad, the setting explains that rumble isn't available. Rumble only adds to what's on screen and in the audio; you never need it to know what's happening. |
| Steering wheels and force feedback | Wheels show up as generic controllers with their own axis layouts. The browser controller API has **no force feedback**. Chrome/Edge on desktop can talk to some wheels directly over WebHID, but only with model-specific code. iPadOS supports almost no wheels. | A setup wizard and saved profiles for wheels on PC. Force feedback over WebHID is an experimental stretch goal for one wheel family. |
| Tilt steering | Works on iPad, but only after the player taps to allow motion access, and only over HTTPS. | A permission step and a calibration step. |
| Fullscreen landscape PWA on iPad | A web app added to the Home Screen runs without Safari's toolbars. There's no install prompt (you install via Share, then Add to Home Screen). Code can't lock the screen orientation. | An install guide, a "rotate to landscape" overlay and a HUD that avoids the rounded corners and home indicator. |
| Saving to local storage | localStorage is small (about 5 MB); IndexedDB holds much more. Safari can wipe a site's data after 7 days of browsing without visiting it; Home Screen apps are effectively exempt. **The installed iPad app and the Safari tab keep separate data.** | Settings in localStorage, everything else in IndexedDB. The game asks the browser to keep its data permanently. Save export and import. |
| Leaderboards and daily challenges | A static host like GitHub Pages has no server. | Leaderboards on your own device only. Daily challenges generated from the date, so they work offline. Online features need a server, which is a separate decision. |
| Soft-body damage | True soft-body simulation (the node-and-beam method BeamNG uses) for 20 cars is far beyond a browser's budget. | What you described: meshes that dent on impact, parts that come off, and damage that affects handling. The physics collision shapes stay rigid. |

### Where I push back or want to set expectations

1. **"AAA quality".** We can build AAA-level *systems*: physics, lighting, post-processing and a polished UI. We can't produce AAA *art*, because there are no artists and no licensed car models. Cars and tracks will be generated in code: car bodies built from adjustable shapes, tracks built from curves. We'll add free CC0 textures and skies. Expect a clean look that's realistic but slightly stylised, not Gran Turismo photorealism. If you ever buy or commission car models, the game can load them as glTF files.
2. **Real-time ray-traced reflections.** Drop them. Browsers give no access to ray-tracing hardware, and doing it in software costs too much on an iPad for what it adds. In a racing game, screen-space reflections plus reflection probes get very close at a fraction of the cost. Path tracing stays, in photo mode only.
3. **Force feedback for steering wheels.** Browsers don't provide it; there's only experimental code that works with specific wheel models. It's a stretch goal, so please don't count on it.
4. **Rumble everywhere.** Not on iPad, because Safari there doesn't support controller rumble. Rumble only adds to what you see and hear.
5. **"120+ fps".** Only possible on 120/144 Hz monitors. Safari on iPad stops at 60 fps by default, which matches your target anyway.
6. **Scope.** The full list is a studio-sized game: 25 cars, 8 tracks, 8 modes, a career economy, a livery editor, split-screen and photo mode. I'll build every system in depth with one car per class first and add content later. Five cars per class is achievable with variants of a class's base design, so cars within a class will share a body family.
7. **Split-screen on iPad.** The whole world is drawn twice. Split-screen targets PC first. On iPad it will use the Low graphics preset and may drop below 60 fps on older models.
8. **Damage.** Dents, detachable parts and handling damage, as you described. It won't be BeamNG-style soft-body physics.
9. **Online features.** Proposal: leaderboards on your device only, and daily challenges that work offline. Going online is a separate decision that needs a server, cheat protection and privacy handling.
10. **Tyre data.** A full Magic Formula tyre model needs about 100 values measured from a real tyre, and fictional tyres have no such measurements. We'll use a reduced version of the Magic Formula with values tuned by hand, plus the temperature model. The tyres will reach "world-class" by tuning them together over several rounds, not by adding more formula.

**Kept as written, and I agree:** 400 Hz physics in a worker, which rumble strips and ABS/traction control need. Controller-first menus. Fictional names throughout.

### How my order differs from yours

- **Deployment and iPad testing start in Round 1**, not at the end. Surprises in Safari, WebGPU or memory should show up while the architecture can still change.
- **Settings and saves** get their framework in Round 3 and grow every round. The late round checks that everything is covered and adds accessibility; it doesn't build settings from scratch.
- **Tyre temperatures, pressures, wear and the setup screen come right after the first circuit**, before the other car classes. That way each class is tuned only once, with the full tyre model in place.
- **Engine audio comes right after the car classes (Round 8).** Sound is part of the feel: you shift by ear and hear the grip limit. A simple placeholder engine sound exists from Round 2.
- **The main graphics round comes before the new tracks and before weather.** Tracks then get dressed only once, and wet-road rendering builds on the finished materials.
- **The garage and full car line-up come before Career**, because the career needs the teams and cars.
- **Touch controls come late (Round 20)**, assuming you test the iPad with a controller (see question 7). iPad compatibility itself is checked every round.
- **Photo mode is second to last.** It's the riskiest technically and adds the least to gameplay.

---

## 3. Architecture

### 3.1 Overview

```mermaid
flowchart TB
  subgraph MAIN["Main thread"]
    INPUT["input/<br/>keyboard · gamepads · wheels · touch · tilt<br/>action map · rumble mixer"]
    APP["app/<br/>state machine · game modes · session control"]
    CLIENT["SimClient<br/>worker proxy · snapshot interpolation"]
    STORE["store<br/>reactive signals"]
    UI["ui/<br/>Preact menus · HUD · focus engine"]
    RENDER["render/<br/>three.js WebGPU or WebGL2"]
    AUDIO["audio/<br/>Web Audio · AudioWorklets"]
    SAVE["save/<br/>localStorage · IndexedDB"]
  end
  subgraph WORKER["Sim worker, fixed 400 Hz"]
    SIM["sim/<br/>vehicles · tyres · drivetrain · aero<br/>collisions · AI · race director<br/>weather and wetness · replay recorder"]
  end
  INPUT -->|"driving inputs, every frame"| CLIENT
  INPUT -->|"menu actions"| UI
  CLIENT -->|"tick + inputs + commands"| SIM
  SIM -->|"snapshots + events + haptics, transferable buffers"| CLIENT
  CLIENT -->|"interpolated car states + events"| RENDER
  CLIENT -->|"rpm, load, slip, surfaces, impacts"| AUDIO
  CLIENT -->|"haptic channels"| INPUT
  CLIENT -->|"race state at 10 Hz"| STORE
  STORE --> UI
  UI -->|"intents"| APP
  APP -->|"session config + commands"| CLIENT
  APP -->|"save / export"| SAVE
  SAVE -->|"load / import"| APP
  STORE -->|"settings"| RENDER
  STORE -->|"settings"| AUDIO
  STORE -->|"settings"| INPUT
```

### 3.2 Threads, timing and the frame loop

```mermaid
sequenceDiagram
  participant F as Main thread (each display frame)
  participant W as Sim worker
  F->>F: poll gamepads, keys, touch → InputFrame
  F->>W: tick(target time, InputFrame, commands, recycled buffers)
  Note over W: run fixed 2.5 ms steps until caught up<br/>(about 7 steps at 60 fps, about 3 at 144 fps)
  W-->>F: snapshot(previous + current state, alpha), events, haptics
  F->>F: interpolate → render, audio, HUD, rumble
```

- **The worker owns the simulation.** The main thread sets the pace. Every display frame it sends the target time and the latest inputs. The worker advances in fixed 2.5 ms steps, then sends back the last two states. There's a limit on how many steps it runs to catch up, so one slow frame can't snowball into more and more slow frames. The renderer blends between the two states, so motion is smooth at any refresh rate and the physics doesn't depend on frame rate.
- Pausing, hidden tabs and slow frames are all handled in one place, the sim clock. When the tab is hidden the browser stops sending frames, so the simulation pauses by itself.
- **Input delay** is about one display frame plus at most one 2.5 ms physics step. A later optimisation: draw as soon as the worker's reply arrives if it arrives quickly enough. That wins back most of that frame.
- **Why 400 Hz:** rumble-strip ridges at racing speed shake the car 50 to 150 times per second. ABS and traction control need fast control loops. Bump stops are very stiff springs, which need small steps to stay stable. Twenty cars at 400 Hz means 8,000 car-steps per second. Our budget (§6) allows about 30 µs for each, which is plenty for this model in JavaScript.
- **Why no shared memory:** `SharedArrayBuffer` needs two HTTP headers (COOP/COEP) that GitHub Pages can't send. Snapshots are small, about 5 to 10 KB per frame for 20 cars. A pool of buffers is handed back and forth between the threads without copying.

### 3.3 Folder and module layout

```
apex-grand-prix/
├─ index.html
├─ public/                 static files served as-is (icons, manifest images)
├─ assets/                 source textures and skies (CC0) → compressed to KTX2 at build time
├─ src/
│  ├─ main.ts              boot: detect features → start renderer → start app
│  ├─ app/                 app state machine, reactive store, session control, game modes, services
│  ├─ sim/                 runs in the worker: pure TypeScript, no DOM, no three.js
│  │  ├─ worker.ts         message loop + fixed-step clock
│  │  ├─ world.ts          cars, track, weather, time; the step order (§5.1)
│  │  ├─ vehicle/          chassis, suspension, tyre/, drivetrain/, brakes, aero, hybrid (ERS/DRS), damage
│  │  ├─ track/            track compiler (physics data), surface queries, spatial index, wetness grid
│  │  ├─ collision/        shapes, contact detection, impulse solver
│  │  ├─ assists/          ABS, traction control, stability, auto gears, braking and steering aids
│  │  ├─ ai/               racing line, driver model, racecraft, strategy
│  │  ├─ race/             timing, scoring, track limits, flags, penalties, pit lane, safety car
│  │  └─ replay/           snapshot recorder
│  ├─ render/              renderer host, quality presets, post-processing, cameras,
│  │                       car and track visuals, effects, photo mode
│  ├─ input/               devices, action map and bindings, filters, rumble mixer
│  ├─ audio/               audio context and mixer, engine worklet, sound effects, radio, music
│  ├─ ui/                  Preact screens, HUD, focus engine, button prompts, theme
│  ├─ save/                storage adapters, schemas and migrations, export/import
│  ├─ content/             data only: classes, cars, tracks, teams, drivers, championships
│  ├─ procgen/             car body generator, track mesh builder, scenery, procedural textures
│  └─ shared/              math, message types, units, seeded random numbers, constants
├─ tools/                  Node scripts: track validation, racing-line precompute, texture compression
├─ tests/
│  ├─ unit/                Vitest
│  ├─ bench/               physics benchmarks, run headless in Node
│  └─ e2e/                 Playwright (headless Chromium, simulated gamepads and touch)
└─ .github/workflows/      ci.yml, deploy.yml
```

A lint rule stops `sim/` from importing DOM, three.js or UI code. That keeps the simulation identical in the worker and in the Node tests.

### 3.4 Messages between the main thread and the worker

| Direction | Message | Contents | When |
|---|---|---|---|
| main → sim | `init` | Browser capabilities, settings the physics needs | Once |
| main → sim | `loadSession` | Track, cars, grid, rules, weather seed | Each session |
| main → sim | `tick` | Target time, one InputFrame per human player, recycled buffers | Every frame |
| main → sim | `command` | Pause/resume, restart, reset car, assists, pit requests, fast-forward | When needed |
| sim → main | `snapshot` | For each car: position, speed, wheel states, rpm, gear, pedals, lights, damage. The last two steps plus a blend factor (alpha) | Every tick |
| sim → main | `events` | Impacts (point and force), detached parts, lap and sector times, flags, penalties, pit events, surface changes | Grouped per tick |
| sim → main | `haptics` | Rumble strengths per player, plus the rumble-strip ridge frequency | Every tick |
| sim → main | `raceState` | Positions, gaps, tyres, fuel, ERS, flags for the HUD | 10 Hz |
| sim → main | `replayChunk` | Compact recorded frames | About 1 Hz, and at session end |

### 3.5 Who talks to whom

- **Only the worker changes the simulation.** The main thread sends requests and commands, never direct changes.
- **`render/`, `audio/` and `ui/` never call each other.** They read from `SimClient` or the store and send requests to `app/`.
- **Only `app/` writes saves.** When a setting changes, the store notifies whoever uses it. The renderer applies quality settings, input applies dead zones, and the worker gets assist settings through a `command`.
- **Replays and ghosts play through the same blending code as live cars.** The renderer and audio don't know whether a car is live, a ghost or a replay.
- **Split-screen** is one simulation with two human input streams, drawn to two viewports with two HUDs.

### 3.6 Save system

- **Settings** go in localStorage as JSON with a version number. They're small and load instantly at start-up, so the game never flashes wrong settings.
- **Everything else** goes in IndexedDB: profile, career, championships, setups, liveries, ghosts and replays. Every record has a version number. Each migration (from version N to N+1) is tested in CI against sample saves from every round.
- **When saving happens:** only at safe moments, such as menu changes, the end of a session or an explicit save. Never while you're driving.
- **Export and import:** export downloads one `.apexsave` file (JSON, with binary data base64-encoded, plus a checksum). Import checks the file, upgrades it to the current version, shows a preview, then merges or replaces your data.
- The game calls `navigator.storage.persist()` to ask the browser to keep its data. On iPad, the Home Screen app and the Safari tab have **separate storage**; use export/import to move saves between them.

### 3.7 Content pipeline

- **Cars:** each car is a data file with physics specs and visual parameters. At load time a car-body generator builds the meshes: detail levels (LODs), texture coordinates laid out for liveries, and separate detachable parts. Liveries are painted into a texture at runtime.
- **Tracks:** each track is a data file. It holds the centre-line control points with elevation, width and banking, plus markers for kerbs, run-off, walls, pit lane, sectors, DRS zones, grandstands and the scenery theme. The track compiler runs in the sim worker to build the physics data, and in a separate build worker to build the meshes. Both use the same compiled data, so physics, visuals, AI racing lines, TV camera positions and the mini-map always agree. Racing lines and camera positions are precomputed at build time.
- **Textures and skies:** CC0 sources (Poly Haven, ambientCG) if you approve, compressed to KTX2 so they use less GPU memory. Everything else is procedural. `ATTRIBUTION.md` lists every third-party asset.
- **Names:** all classes, teams, cars, drivers, sponsors and tracks are fictional. The game itself avoids protected series names such as "F1", "GT3", "TCR" and "Super Formula". This plan uses them only as descriptions.

---

## 4. Key technology choices and trade-offs

| Area | Choice | Why | Trade-offs and alternatives |
|---|---|---|---|
| Language and build | TypeScript (strict), Vite, npm | Fast rebuilds, handles workers and WASM well, produces a static build for Pages | None worth noting |
| Rendering | three.js r186 (version pinned), `WebGPURenderer` with materials written in TSL (three.js's shader language); automatic WebGL2 backend | One set of shaders for both backends. Ready-made effects: GTAO, SSR, temporal anti-aliasing (TRAA), resolution upscaling (TAAU, FSR 1), bloom, motion blur, lens flare, depth of field, screen-space GI | The WebGL2 backend is slower and has no compute shaders. three.js changes its API between releases, so we pin the version and upgrade deliberately between rounds. Safari has the newest WebGPU implementation, so a "force WebGL2" setting stays available. |
| Physics | Our own vehicle dynamics and collisions, pure TypeScript, in a module Web Worker at 400 Hz | Full control of tyres, suspension and drivetrain. The track surface is calculated directly from its definition, which gives exact kerb shapes without firing rays at meshes. No 2 MB WASM download. | More code to write and test; Node test benches reduce that risk. Fallback: the Rapier physics engine (WASM) for collisions if multi-car pile-ups or rollovers turn out unstable. |
| Worker communication | `postMessage` with pools of transferable `Float32Array` buffers | Works on GitHub Pages | Shared memory would save one copy, but needs HTTP headers Pages can't send |
| UI | HTML overlay built with Preact and signals, CSS animations | Quick to build, sharp text, easy text scaling and colour-blind themes, accessible | The HUD must stay cheap: values that change every frame are written straight to the page, bypassing Preact |
| Input | Gamepad API read every frame on the main thread, plus keyboard, mouse, touch and device tilt, all through one action-map layer | The same system drives menus and cars, with rebinding | Inputs arrive at display rate and are smoothed for the 400 Hz physics |
| Audio | Web Audio with engine sounds synthesised in AudioWorklets | No licensed recordings needed. Reacts instantly to rpm and load | Synthesised engines can sound great, but not like studio recordings. The engine can mix in recorded samples later if you get legal ones |
| Storage | localStorage and IndexedDB, with export/import | Works offline, no server | Safari can delete data; the iPad app's storage is separate from the Safari tab's |
| PWA | Web app manifest and a service worker (vite-plugin-pwa/Workbox, or a small hand-written one) | Installable, works offline | iPad has no install prompt. The cached game needs a "new version available" prompt to update |
| Hosting | GitHub Pages, deployed by GitHub Actions | Free, HTTPS (needed for tilt and the PWA), a public URL for your iPad | Static files only: no server features and no custom HTTP headers |
| Tests | Vitest for unit tests and physics benchmarks in Node; Playwright for headless Chromium tests with simulated gamepads and touch | Runs in CI on every push | Can't test real GPUs, iPads or controllers; that's what your manual checklist covers |

---

## 5. Physics design (the core)

### 5.1 One simulation step (2.5 ms)

For each car:
1. **Driver input:** your smoothed input, or the AI controller's. Then the assists (ABS, traction control, stability, auto gears, braking aid) turn it into commands for steering, throttle, brake and gearbox.
2. **Contact:** check the track at several points on each tyre's contact patch. Each check returns height, surface angle, surface type, kerb shape and wetness.
3. **Suspension:** spring (optionally stiffening with travel), damper with separate settings for compression and rebound at low and high speeds, bump stop, anti-roll bar. These give the load on each wheel.
4. **Tyres:** calculate how much each tyre slides sideways and spins or locks. Real tyres take a short distance to build grip, and the model includes that delay. The Pacejka formula then gives each tyre's forces and its self-centring torque. It accounts for load, camber, temperature, pressure, wear, surface grip and water.
5. **Driveline:** engine, clutch, gearbox, differentials and wheels are solved together with a more stable (implicit) method in smaller sub-steps, because this is the stiffest part of the car.
6. **Aero:** drag and front and rear downforce, which change with ride height, pitch, DRS and damage. Also the effect of cars ahead: slipstream and turbulent air.
7. **Motion:** move and rotate the car body by its forces.
8. **Collisions:** car against wall, car against car, and car body against the ground (bottoming out and rollovers). A solver works out the impacts and sends events for damage, sparks, audio and rumble.
9. **Slower systems, run less often:** temperatures and wear for tyres, brakes and engine at 50 Hz. The race director times line crossings to within a fraction of a step. Weather and track wetness at 10 Hz. The replay recorder at 30 to 60 Hz. AI planning at 20 to 50 Hz; AI steering and pedals still update at 400 Hz.

### 5.2 Models and how detailed they are

- **Chassis:** a rigid body with its own mass, rotational inertia and centre of gravity height for each car.
- **Suspension:** each corner is found by checking the track below the wheel, sampling several points so kerb edges feel right. It has springs, dampers with separate compression and rebound settings, bump stops and anti-roll bars. It also has static camber and toe, camber that changes with travel, ride height and rake (nose-down angle).
- **Tyres:** a reduced version of the Pacejka Magic Formula (the MF 5.2 family). It covers pure and combined sliding, grip that changes with load, extra grip from camber, and self-centring torque for steering feel and force feedback. It also models how a tyre builds grip over a short rolling distance. Temperature is tracked in three zones across the tread plus the tyre's core. Pressure follows temperature. Wear and compounds are included.
- **Driveline:** torque curves, turbo lag, rev limiter, engine braking and clutch. Sequential or automatic gearboxes with shift times. Open, limited-slip, viscous and torque-splitting all-wheel-drive differentials.
- **Brakes:** strength, front/rear bias, temperature and fade (iron and carbon behave differently), ABS.
- **Aero:** drag, and front and rear downforce that change with ride height and pitch (ground effect). DRS, slipstream, turbulent air behind other cars, and downforce lost to damage.
- **Hybrid:** a battery, electric-motor deploy and recharging (MGU-K), deploy modes and per-lap energy limits. The feeder class has an "overtake boost" instead.
- **Surfaces:** asphalt, with extra grip on the rubbered-in line. Also painted lines, raised ribbed kerbs, grass, gravel, sand, concrete and pit lane. Each surface has its own wetness and standing water.
- **Damage:** each part has a health value. Damage affects aero, suspension alignment, steering, engine, gearbox and tyres.

### 5.3 Known numerical problems and how we handle them

- **Instability at low speed.** The tyre slip formula divides by speed, and a wheel's spin reacts very sharply to force. So we use the grip-build-up model above, integrate wheel spin with a more stable method in smaller steps, and give standing still its own model. Benchmarks check it: a car parked on a slope must not creep, and a car rolling to a stop must not jitter.
- **Kerb and bump-stop impacts.** We sample several contact points and smooth the result over the contact patch. Bump stops are integrated with a speed limit. Tested at 300 km/h over kerbs.
- **Pile-ups.** The collision solver repeats its passes and starts each step from the previous step's result. If a value ever becomes NaN, a hard guard resets that car to its last valid state. It's logged and treated as a bug.
- **Repeatability.** The same build in the same browser gives identical results, which the tests depend on. Replays store car states, not just inputs, so they still play correctly in other browsers and after updates.

### 5.4 Class targets (benchmark ranges)

| Class (described by its real-world model; in-game names are fictional) | Mass | Power | 0–100 km/h | Top speed | Peak lateral grip | Character |
|---|---|---|---|---|---|---|
| Formula (modern hybrid single-seater) | ~800 kg | ~750 kW incl. ERS | 2.4–2.9 s | 330–350 km/h | 4.5–5.5 g at high speed | Huge downforce, ground effect, DRS/ERS, carbon brakes, nervous at low speed |
| Feeder (Super Formula-style) | ~680 kg | ~420 kW + overtake boost | 2.8–3.3 s | 290–310 km/h | 3.0–3.8 g | Lighter aero, no hybrid, very agile |
| GT (GT3-style) | ~1300 kg | ~410 kW | 3.0–3.6 s | 270–295 km/h | 1.8–2.2 g (1.40–1.65 g on a 60 m skidpad) | Stable, heavy braking, forgiving, class balancing |
| Touring (sedan, TCR-style) | ~1250 kg | ~250 kW | 4.6–5.4 s | 235–255 km/h | 1.25–1.45 g | Front-wheel drive (plus a rear-drive variant), hops over kerbs |
| SUV (performance SUV) | ~2100 kg | ~450 kW | 3.8–4.6 s | 260–290 km/h | 0.95–1.15 g | All-wheel drive, high centre of gravity, 4–7° of body lean at 0.8 g, can roll over |

A **physics test bench** in Node runs these checks for every car on every push: straight-line acceleration, top speed, braking from 200 to 0 km/h, a constant-radius skidpad, a step steer, a slalom, parking on a slope and rolling to a stop.

---

## 6. Performance budgets and quality presets

| Budget | iPad (60 fps) | PC (120 fps) |
|---|---|---|
| Time per frame | 16.6 ms | 8.3 ms |
| Main-thread JavaScript per frame | ≤ 5 ms | ≤ 3 ms |
| Sim worker, 20 cars at 400 Hz | ≤ 30 % of one CPU core | ≤ 15 % |
| JavaScript + GPU memory | ≤ 1 GB | ≤ 2 GB |
| Draw calls | ≤ 800 | ≤ 2500 |
| Download before the main menu | ≤ 3 MB (gzipped) | Same |
| Download per track | ≤ 10 MB | Same |

| Preset | Low | Medium | High | Ultra |
|---|---|---|---|---|
| For | Older iPads / WebGL2 | Recent iPads (default) | Good PC (default) | High-end PC |
| Internal resolution | 60–85 %, dynamic | 70–100 %, dynamic, upscaled | 100 % (dynamic optional) | 100–150 % |
| Anti-aliasing | FXAA | TRAA (temporal) | TRAA | TRAA |
| Shadows | 1 cascade, 1024 px | 2 × 2048 px | 3 × 2048 px | 4 × 4096 px |
| Ambient occlusion | Off | GTAO at half resolution | GTAO | GTAO + screen-space GI |
| Reflections | Sky reflection map | + reflection probes | Screen-space reflections | Higher-quality screen-space reflections |
| Post-processing | Tone mapping, light bloom | + full bloom, lens flare | + motion blur (optional), heat haze | Everything |

Dynamic resolution uses the GPU's own frame timings when the browser provides them (WebGPU timestamp queries). Otherwise it uses a cautious rule based on frame times. The lower internal resolution is upscaled with TAAU or FSR 1.

---

## 7. Roadmap: 24 rounds

| # | Round | What you can play at the end |
|---|---|---|
| 1 | Foundations | A test car on a test ground at a public URL; installable as a PWA |
| 2 | Vehicle dynamics core | A GT car that handles properly |
| 3 | Controller-first UI, settings, saves, rumble | The whole menu flow with a controller only |
| 4 | Track builder, kerbs, surfaces | Time trial on the first circuit |
| 5 | Tyre life, brakes, car setup | Long runs with tyre temperatures and wear; setup screen |
| 6 | Open-wheel classes | Formula and Feeder cars with DRS/ERS |
| 7 | Closed-wheel classes | Touring and SUV; all 5 classes drivable |
| 8 | Audio I | Engines, tyres, kerbs |
| 9 | AI and Quick Race | Race against 19 AI cars |
| 10 | Race rules and pit stops | Full races with flags, penalties, safety car and strategy |
| 11 | Graphics II | Presets, post-processing, dynamic resolution, benchmark |
| 12 | Track pack I | Street, temple and mountain circuits |
| 13 | Weather and time of day | Rain, a drying racing line, night racing (desert circuit) |
| 14 | Effects, cameras, replays, ghosts | TV-style replays, racing ghost laps |
| 15 | Damage | Dents, detachable parts, handling damage |
| 16 | Weekends and championships | Practice, qualifying, sprint and race; custom championships |
| 17 | Garage, roster, liveries | 25 cars and a livery editor |
| 18 | Career | Career over several seasons |
| 19 | Split-screen, drift, dailies | Local 2-player, drift events, daily challenges |
| 20 | Touch, tilt and wheels | Touch-only racing on iPad; steering wheels on PC |
| 21 | Track pack II | 8 circuits in total |
| 22 | Audio II, HUD, accessibility | Pit radio, crowd, HUD editor, colour-blind modes |
| 23 | Photo mode | Path-traced screenshots |
| 24 | Performance and v1.0 | Loading on demand, long stability tests, release |

---

### Round 1: Foundations (a car on a test ground, deployed)
**Goal:** prove the whole architecture works on your real devices.
- Project set-up: Vite, TypeScript in strict mode, three.js r186, lint and formatting, Vitest, Playwright. A GitHub Actions workflow for CI and one that deploys to GitHub Pages. PWA: manifest, icons, service worker, and a "new version available" message.
- Renderer: WebGPU with automatic WebGL2 fallback (`?renderer=webgl` forces WebGL2), window resizing, a resolution-scale setting. A performance overlay showing fps, frame time, backend, draw calls and resolution.
- Sim worker: the fixed 400 Hz loop with its catch-up limit, pausing when the tab is hidden, and the buffer pool. The main thread blends between states. The overlay shows physics steps per second and per frame.
- A simple car that still follows real physics: rigid body, four raycast suspension corners with springs and dampers, a simple tyre, basic engine and brakes, placeholder mesh.
- A flat asphalt test ground with a painted loop and cones. A chase camera.
- Input: keyboard (WASD or arrow keys, Space for the handbrake) and gamepads using the browser's standard button layout.

**Automated checks**
- CI passes: type check, lint, unit tests, build and browser tests.
- Timing: across 60 s of simulated uneven frames (4 to 100 ms each), the simulation runs exactly 400 steps per second, give or take one step. Blending never goes past the newest state.
- A 10-minute random-input run in Node produces no NaN or infinite values, and no speed above 150 m/s.
- In headless Chromium the page loads without console errors, the canvas isn't blank, and the car moves under scripted input.
- The first download is ≤ 1.5 MB gzipped.

**Your checks**
1. On PC in Chrome or Edge: the overlay says WebGPU, and motion is smooth at your monitor's refresh rate.
2. On iPad in Safari: the game loads, shows WebGPU (iPadOS 26) or WebGL2, runs at 60 fps, and a controller drives the car.
3. Add to Home Screen: the game opens fullscreen without Safari's toolbars, and still works in airplane mode after the first load.
4. Switch to another app for 30 s and come back: the car doesn't jump and the physics doesn't blow up.

### Round 2: Vehicle dynamics core (one GT car that drives well)
- Chassis with realistic mass, rotational inertia and centre of gravity height. Suspension at each corner: springs (linear or stiffening), dampers with separate compression and rebound settings, bump stops, anti-roll bars, static camber and toe, and camber that changes with travel.
- Tyres: the reduced Pacejka Magic Formula. Pure and combined slip, grip that varies with load, extra grip from camber, the grip build-up delay, a separate model for very low speed and standing still, and tyre sidewall stiffness.
- Wheels and driveline: wheel spin integrated with the stable method and smaller steps. Engine torque map by rpm and throttle, idle, rev limiter and engine braking. Automatic clutch, sequential gearbox with shift time, limited-slip differential (preload plus separate locking on power and off power), brakes with bias, handbrake.
- Aero, first version: drag plus fixed front and rear downforce.
- Assists, first version: ABS, traction control, auto gears, and a steering aid for pad and keyboard that reduces steering with speed and limits how fast it can change. A telemetry overlay: load, slide angle, wheel spin or lock and grip used for each wheel, plus a g-g plot of cornering against braking and acceleration. A live tuning panel (developer only). A placeholder engine tone and tyre-squeal noise.
- The test ground grows: a skidpad circle, a 1 km straight, a braking zone, a slalom and a slope.

**Automated checks** (physics benchmarks for the GT car)
- 0–100 km/h in 3.0–3.6 s. 0–200 km/h in 9–11.5 s. Top speed 270–295 km/h.
- Braking from 200 to 0 km/h with ABS on: 80–100 m.
- Skidpad with a 60 m radius: 1.40–1.65 g. The default setup understeers slightly, so it's stable.
- Parked on a 15 % slope with the handbrake on: creeps less than 1 cm in 10 s. Rolling to a stop from 30 km/h ends at rest with no jitter.
- The results don't change with uneven frame rates. One hour of random input produces no NaN.

**Your checks:** rate the handling from 1 to 10 with notes: understeer on corner entry? Sudden oversteer? Too floaty? Try it with traction control and ABS off, and with both keyboard and controller.

### Round 3: Controller-first UI, settings, saves and rumble
- UI framework: Preact with signals, the theme, animated screen transitions and a screen stack.
- Focus engine: the D-pad and stick move to the nearest item in that direction. Pop-up windows keep focus inside. The focused item is highlighted, holding a direction repeats it, LB/RB switch tabs, and triggers move sliders fast. Mouse, touch and keyboard work on the same items.
- Button prompts switch automatically between Xbox, PlayStation, generic, keyboard and touch icons, depending on the device you used last. You can also pick one manually.
- Screens: title, main menu, quick-drive setup, pause and a controller tester that shows raw axes and buttons. Settings, first version:
  - Controls: button rebinding, dead zones (inner and outer), linearity, sensitivity, steering filter
  - Rumble: on/off, strength, test
  - Assists and units
  - Graphics: resolution scale, FPS counter
  - Master volume
- Saves, first version: settings with version numbers and migrations, export/import to a file, reset to defaults.
- Rumble mixer, first version: separate channels for wheelspin, lock-ups, gear shifts, engine rpm near the limiter, going off track and impacts. A strength slider. It turns on only where the browser supports it. On iPad the setting says "not supported by this browser".

**Automated checks:** unit tests for focus movement in grid, list and tab layouts, for saving and loading bindings, for settings migration from version 1 to 2, and for export → import giving identical data. A browser test with a simulated gamepad walks every menu screen using only pad input: no dead ends, focus always visible, Back always works. It then changes a dead zone and reloads the page, and the value is still there.

**Your checks:** use only a controller (no mouse, keyboard or touch), on PC and on iPad. Go from start-up to driving, pause, change settings, rebind a button and go back. Check that button icons switch between Xbox, PlayStation and keyboard. On PC, feel rumble for lock-ups, wheelspin and shifts. On iPad, the rumble setting should explain that rumble isn't supported.

### Round 4: Track builder, kerbs and surfaces, first circuit, time trial
- A track file format and a compiler that turns it into the road (with elevation and banking), raised kerbs (with shapes and ridge patterns) and run-off areas (grass, gravel, tarmac). It also builds walls and tyre barriers, pit lane and pit wall, start gantry and simple grandstands. A spatial index makes surface lookups fast.
- Physics: surfaces calculated directly from the track definition. Several contact points per tyre, so kerb edges bump properly. Each surface has its own grip, rolling resistance and bumpiness. Gravel drags the car down and slows it. Cars collide with walls.
- Rumble: a rhythmic kerb pattern (ridge spacing × speed), plus a channel for surface types.
- Timing: start/finish line, 3 sectors, and lap validity (the lap is invalid if all four wheels go past the white line). Lap and sector times on the HUD.
- First circuit: **"Greywater Park"** (working title), a classic tree-lined circuit of about 4.6 km where it often rains. It stays dry until Round 13.
- Visual baseline: realistic (PBR) materials, sun with shadows that stay sharp near the camera, sky, HDR lighting with tone mapping, and fog.
- Time trial, first version: pick a car and track, and best laps are saved. A loading screen.

**Automated checks:**
- Compiler: the loop is closed, the road mesh has no gaps or overlaps, surfaces all face the right way, and the pit lane joins the track.
- Surface lookups identify test points correctly. Kerb heights match the definition.
- Wall test: at 100 km/h and a 30° angle, the car doesn't pass through the wall and slides along it.
- A scripted driver that follows the centre line completes a valid lap and its time is recorded. A scripted driver that cuts a corner gets the lap invalidated.
- Standing memory check S6 starts here.

**Your checks:** kerbs feel, sound and rumble rhythmically. Gravel slows you, grass is slippery and walls stop you. Cutting a corner invalidates the lap. Your best lap survives a reload. 60 fps on iPad.

### Round 5: Tyre life, brakes and car setup
- Tyre temperature model:
  - Three surface zones (inner, middle, outer) plus the core. Tyres heat up from sliding and flexing, and cool in the airflow and on the track.
  - Each compound has a temperature window where it grips best. Pressure rises with temperature.
  - Tyres wear with sliding, and grip drops as they wear.
  - Compounds: soft, medium and hard. Intermediate and wet tyres come in Round 13.
- Brake temperatures and fade (iron and carbon brakes), plus a brake-cooling setting.
- A car setup screen that works well with a controller: wings, ride height, springs, dampers, anti-roll bars, camber, toe, differential, brake bias and pressure, tyre pressures, gear ratios and final drive. Save and load setups per car and track. Every option is explained.
- Telemetry, second version: a panel with tyre temperatures, pressures and wear, and a graph of lap times dropping as tyres wear.

**Automated checks:**
- Cold medium tyres reach their window within 1–2 laps of scripted driving. Continuous sliding overheats the surface and cuts peak grip by the amount the model predicts.
- Wear per lap stays within each compound's targets; for example, softs wear about twice as fast as mediums.
- Setup changes do what they should on the test bench:
  - Stiffer front anti-roll bar → more understeer.
  - More rear wing → lower top speed and more rear grip.
  - Higher pressure → temperatures and contact patch change as modelled.
  - Brake bias moved rearward → rear wheels lock first.

**Your checks:** tyres feel cold out of the pits, then come in. Pushing too hard overheats them. Try three setup changes and see if each does what its description says.

### Round 6: Open-wheel classes (Formula and Feeder)
- Aero, second version: downforce that changes with ride height and pitch (ground effect), a shifting aero balance, and drag. DRS that the driver opens, in DRS zones. ERS: a battery, electric deploy and recharging, deploy modes and a per-lap limit. An overtake boost for the Feeder car. Carbon brakes.
- The Formula car (hybrid, about 800 kg) and the Feeder car (about 680 kg, no hybrid).
- Car body generator, first version: open-wheel and GT bodies replace the placeholders. Parts are separate (wings, bodywork, wheels) so liveries and damage can use them later.
- Car selection screen, first version (tabs per class, specs). Bonnet and cockpit cameras, first version.

**Automated checks:**
- The Formula and Feeder cars stay within their class targets in §5.4.
- DRS adds 10–16 km/h by the end of a 1 km straight.
- ERS never uses more than its per-lap energy limit.
- The GT car's benchmark results are unchanged.

**Your checks:** the Formula car feels planted at speed but nervous at low speed over bumps and kerbs, and is clearly faster than the Feeder. DRS and ERS are obvious on the HUD.

### Round 7: Closed-wheel classes (Touring and SUV)
- Front-wheel, rear-wheel and all-wheel drive, with a centre differential that splits torque or uses a viscous coupling. Torque steer on front-wheel drive. A high chassis that can roll over. Reset-to-track. Default assists per class.
- A Touring sedan (front-wheel drive, TCR-style), a rear-wheel-drive Touring variant (later the drift car) and a performance SUV (all-wheel drive).
- Body generator: sedan and SUV bodies.

**Automated checks:**
- The Touring and SUV cars stay within their class targets in §5.4.
- At a steady 0.8 g the SUV leans 4–7°, compared with less than 1.5° for the GT car.
- In a sudden-swerve (J-turn) test at high speed, the SUV lifts onto two wheels with stability control off and stays upright with it on.

**Your checks:** the SUV leans and pushes wide in corners. The front-drive sedan understeers under power and hops over kerbs. The rear-drive sedan can drift. No class should feel like the same car with different numbers.

### Round 8: Audio I (engines, tyres, kerbs)
- Audio set-up: sound starts after your first input, it suspends and resumes properly, and it's configured correctly for iPad. A mixer with master, engine, effects, music and voice channels, each with a slider.
- Engine sound synthesised in an AudioWorklet. It models each cylinder firing (count and firing order), exhaust and intake resonance, a tone that changes with load, the limiter, pops on lift-off, turbo spool, whistle and blow-off, and the shift cut. One preset per class:
  - Formula: hybrid V6
  - Feeder: turbo 4-cylinder
  - GT: V8
  - Touring: turbo 4-cylinder
  - SUV: twin-turbo V8

  Each car sounds different from inside and outside.
- Tyre squeal and scrub driven by sliding. Kerb rumble driven by ridge frequency. Gravel and grass noise. Wind. AI cars fade with distance and shift pitch as they pass (Doppler), and cars further away use simpler sound.

**Automated checks:** the player's engine sound uses at most 15 % of each audio processing block on desktop. Unit tests check how car values map to sound settings. No audio objects are left behind after 10 session restarts.

**Your checks:** the 5 classes sound clearly different. You can shift by ear. Squeal starts right at the grip limit. Kerbs sound rhythmic. On iPad, sound starts after the first touch or button press and follows your mute and volume. The sliders work.

### Round 9: AI drivers, car-to-car contact and Quick Race
- Racing line: the smoothest line around the track plus a speed plan for each car, based on that car's grip and power. Worked out when the track loads and then cached.
- AI drivers use the same physics and controls as you: steering that follows a path, throttle and brake from the speed plan with correction when the tyres slide, and gear changes. Each driver has skill settings: pace, consistency, aggression and racecraft. They make mistakes (lock-ups, running wide). They overtake by picking a line and braking late, defend with a single move, and know when a car is alongside.
- Car-to-car collisions: each car is made of several boxes, and a solver resolves contacts step by step. Slipstream and turbulent air behind cars.
- Quick Race: grid, standing start with lights, a chosen number of laps, a timing tower with gaps, results and a difficulty setting.

**Automated checks:**
- 10-lap races with 20 AI cars, run headless over many random starts:
  - At least 95 % of cars finish.
  - No car stays stuck for more than 5 s.
  - The number of contacts stays under a set limit.
- The best AI is within 1.5 % of the benchmark's best possible lap. Lap times get slower steadily as skill goes down.
- 20 cars use at most 30 % of one CPU core at 400 Hz, measured in Node.

**Your checks:** AI cars brake at believable points, fight for position but mostly race clean, and make occasional mistakes. Easy is winnable and hard is hard. The iPad keeps 60 fps with a full grid.

### Round 10: Race rules, pit stops and strategy
- Race director:
  - Flags: green, yellow and double yellow per sector, blue, white, black-and-white, black and chequered. Marshal posts wave animated flags, and the HUD shows them.
  - Penalties: warnings for exceeding track limits turn into time penalties. Jump starts are detected. Penalties for causing collisions can be switched off. Drive-through and time penalties.
- Safety car and virtual safety car: what triggers them, the safety car's own driving, the field bunching up, no overtaking, and the restart.
- Pit lane: speed limiter, entry and exit lines, pit boxes, and crew stops for tyres and fuel. Stop times follow a model, and unsafe releases are checked. Fuel use, and its weight affects the car.
- DRS race rules: detection points, DRS allowed only within 1 s of the car ahead, from lap 3, and not under the safety car.
- AI strategy: planned stops that react to tyre wear and safety cars.
- Race settings: laps, tyre wear and fuel multipliers, mandatory stop, penalty strictness, safety car and flags on or off.

**Automated checks** (scripted scenarios):
- Cutting a corner repeatedly gives warnings, then a 5 s penalty.
- A car stopped in a sector brings out double yellows there.
- A heavy crash brings out the safety car:
  - The field bunches up within 2 laps.
  - No one overtakes before the line.
  - The restart is clean.
- A Formula tyre stop takes 2–4 s stationary, and a pit stop costs 18–25 s overall.
- DRS works only within 1 s at a detection point.
- The AI carries out a one-stop strategy.

**Your checks:** a 15-lap race with a pit stop, a penalty and a safety car. Flags are clear at a glance.

### Round 11: Graphics II (materials, post-processing and scaling)
- Quality presets (Low, Medium, High, Ultra), with every option adjustable on its own:
  - Resolution scale and dynamic resolution (target fps, minimum and maximum)
  - Upscaler: TAAU, FSR 1 or simple
  - Anti-aliasing: FXAA, SMAA or TRAA
  - Shadows: cascades, size and distance
  - Ambient occlusion: off, SSAO or GTAO
  - Reflections: environment map or screen-space
  - Bloom, motion blur and lens flare
  - Texture quality, anisotropic filtering and level-of-detail bias
  - Particle and crowd density, draw distance
  - FPS counter
  - Renderer: auto, WebGPU or WebGL2
- Car paint with a clear coat and metallic flake. Glass, carbon fibre and tyres. Brake discs that glow when hot. Car lights. Reflection probes for car reflections. Detail levels (LOD) and instancing (drawing many copies of the same object at once) for scenery.
- A built-in benchmark: a 60 s AI race with a scripted camera. It reports average fps, the worst 1 % of frames, average resolution scale, and GPU time when available. You can copy the results.

**Automated checks:** a screenshot for each preset renders without errors (WebGL2 headless, WebGPU if available). Draw calls and triangle counts stay within each preset's budget. Shaders compile on both backends.

**Your checks:** run the benchmark. PC on High: at least 120 fps at your native resolution (or your refresh rate). iPad on Medium: at least 60 fps with a resolution scale of 0.7 or higher. Shadows don't shimmer. WebGL2 mode looks close to WebGPU.

### Round 12: Track pack I (street, temple, mountain)
- Three circuits (working titles):
  - **"Marisol Harbour"**, a street circuit: walls everywhere, bumps, tight corners.
  - **"Sunspire Temple"**, a high-speed circuit: long straights and fast sweeping corners for slipstream battles.
  - **"Kaltberg Ring"**, a mountain circuit: big elevation changes, blind crests, hairpins.
- Crowds, marshal posts, pit buildings, fictional sponsor boards, DRS zones and TV camera positions placed automatically. AI racing lines are checked on each track.

**Automated checks:** the compiler checks pass on every track. 20-car AI races run on each. Loading all tracks in turn three times leaves memory back at its starting level.

**Your checks:** each track has its own character and is fun. 60 fps on iPad on every track.

### Round 13: Weather, time of day and wet racing
- Time of day that changes during a session: sun, moon and stars, exposure that adapts to the light, and a speed-up setting. Headlights. Floodlights: clustered lighting on WebGPU, pre-computed lighting on WebGL2. New circuit: **"Mirage Dunes"**, a floodlit desert night track.
- Weather that changes over time from clear to overcast to light and heavy rain. Rain particles, drops on the camera in cockpit view, and wet roads that get darker, with puddles and stretched reflections. Spray thrown up behind cars reduces visibility for whoever follows.
- Wet physics:
  - A grid tracks water depth along the track. Water builds up in rain and drains away.
  - The racing line dries as cars drive over it.
  - Grip and aquaplaning depend on the tyre compound (intermediates, full wets).
  - AI drivers change their lines, braking points and tyre choices.

**Automated checks:**
- On a wet track, slicks have about 50–65 % of the grip they have in the dry, and intermediates about 75–85 % of that same dry-slick grip. Cars aquaplane above a threshold speed in deep water.
- The racing line dries measurably as cars pass.
- The AI switches tyres at the right crossover point.
- Performance stays within budget on every preset.

**Your checks:** rain changes how you drive. The racing line visibly dries. A night race at the desert track holds 60 fps on iPad on Medium.

### Round 14: Effects, cameras, replays and ghosts
- Effects: tyre smoke, skid marks, sparks, dust, gravel and grass debris, and heat haze.
- Cameras: close and far chase, bonnet, cockpit for each class, a camera above the cockpit (T-cam), TV cameras and a helicopter. A subtle camera shake you can turn off.
- Replays: a recorder that stores compact states and events. A player to scrub, change speed, cut between TV cameras, fly a free camera and hide the HUD. Replays can be saved and exported.
- Time-trial ghosts: your best lap, plus rival ghost files you can import and export. Local leaderboards per track and car.

**Automated checks:** replayed car positions differ from the live race by less than 1 cm and 0.1°. A 20-car, 10-lap replay takes at most 10 MB (compressed). A ghost's lap time matches the recorded time within 1 ms. Particle counts stay within each preset's budget.

**Your checks:** replays feel like TV coverage. Racing a ghost is useful. Effects look good without dragging down fps.

### Round 15: Damage
- Settings: off, visual only or realistic.
- Visuals: the car's surface dents where it's hit, within limits for each part. Scratches, dirt and broken lights.
- Parts come off: front and rear wings, bumpers, mirrors and wheels. They become debris the physics simulates, and debris on track can cause punctures.
- Handling damage: lost downforce, bent suspension that makes the car pull to one side, an off-centre steering wheel, engine and gearbox damage, and punctures.
- A damage display on the HUD. Repairs in the pits. AI cars retire.

**Automated checks** (crash tests):
- A 60 km/h head-on hit into a wall breaks the front wing and front downforce drops by the modelled amount.
- Left-front damage makes the car pull with the wheel straight.
- Visual-only damage gives the same lap time as an undamaged car.
- With damage off, the car doesn't dent.
- A car that loses a wheel can't continue.
- Pit repairs restore everything.
- 1,000 random crashes produce no NaN.

**Your checks:** damage looks convincing, feels fair and never makes the physics blow up.

### Round 16: Race weekends, custom championships and stats
- Weekend format: practice, qualifying (a single session or three knockout sessions), sprint and main race. Sessions can be skipped or simulated. Setup can be locked after qualifying (parc fermé). Points systems.
- Custom championship builder: class, calendar, rules, weather, damage, assists and AI level. Standings tables.
- Stats and local leaderboards. An on-screen keyboard so you can type names with a controller.

**Automated checks:** a headless 4-round championship gets standings and tie-breaks right. Saving mid-weekend and resuming restores the exact state. The knockout qualifying order is tested.

**Your checks:** play a full weekend from start to finish with only a controller, and build a custom championship.

### Round 17: Garage, full car line-up and livery editor
- 25 cars, 5 per class. Each is a variant of its class design with its own character: engine position, weight distribution, power curve and aero efficiency. Cars are balanced within each class. Fictional manufacturers, teams and drivers.
- Garage: a 3D car viewer with a turntable, studio lighting and specs.
- Livery editor:
  - Base colours and finishes.
  - Layers: shapes, stripes, gradients, numbers, text and fictional sponsor decals.
  - Mirrored editing on both sides, undo and redo.
  - Works with controller, touch or mouse.
  - Liveries can be imported and exported.
- AI teams get generated liveries.

**Automated checks:** all 25 cars stay within their class targets. On the reference track, lap times within each class differ by no more than 1 % (scripted driver). Liveries save and load identically. Each car's texture memory stays within budget.

**Your checks:** make a livery with only a controller in under 5 minutes. Cars within a class feel different but equally competitive.

### Round 18: Career
- Start in the Feeder or Touring series and climb the ladder.
- Fictional teams at different performance levels.
- Contracts offered based on results and objectives.
- A research and development tree: aero, engine, chassis and reliability upgrades, each with a cost and development time.
- A budget. Rival teams develop their cars too.
- A calendar across several seasons, a news feed and multiple save slots.

**Automated checks:** a headless five-season career keeps the economy in bounds, with no runaway money and no dead ends. Upgrades change benchmark performance by the stated percentage. Contract rules are followed.

**Your checks:** play the first three races of a career. It should be clear and the progression rewarding.

### Round 19: Split-screen, drift challenge and daily challenges
- 2-player split-screen (top/bottom or side by side), joining and assigning controllers, and a separate camera, HUD, rumble and assist settings per player. Graphics quality drops automatically.
- Drift challenge for sedans and SUVs: scoring for angle, speed and line, combos and zones. Drift setups.
- Daily challenges generated from the date, working offline, with streaks and a local leaderboard.

**Automated checks:** two simulated pads control two cars independently. Drift scoring is unit tested. The daily challenge is the same for everyone on a given date and always valid.

**Your checks:** 2 players on PC get at least 60 fps in each view. 2 players on iPad on Low is playable, at 45 fps or more. Drift scoring feels fair.

### Round 20: iPad touch and tilt, steering wheels
- Touch controls:
  - An on-screen wheel or slider.
  - Tilt steering, with permission and calibration.
  - Pedals and buttons.
  - A layout editor for size, position and transparency.
- iPad: the HUD avoids the rounded corners and home indicator. A "rotate to landscape" overlay, a guide to installing the PWA, a polished update prompt, automatic graphics preset on first launch and a 30 fps battery-saver mode.
- Steering wheel setup wizard (tested against a Logitech G29/G923-class wheel): steering, throttle, brake and clutch axes, combined or separate pedals, rotation angle and soft lock, linearity and dead zones. Saved profiles per wheel.
- Experimental WebHID force feedback for one wheel family, only if you own one.
- A check that every action can be rebound.

**Automated checks:** a simulated multi-touch browser test drives a lap with on-screen controls. The layout editor saves its changes. Wheel profiles are tested with simulated wheels that have unusual axis layouts.

**Your checks:** race once with tilt and once with the on-screen wheel. The HUD stays clear of the home indicator and camera. The installed PWA works offline. If you have a wheel, set it up with the wizard and drive.

### Round 21: Track pack II (8 circuits in total)
- **"Cape Serein"**: fast coastal cliffs at sunset.
- **"Ironbay Speedbowl"**: a banked oval with an infield road course.
- **"Ferrum Docks"**: a tight industrial circuit for drift and SUV events.

All modes, weather and AI work on all three. Checks are the same as Round 12.

### Round 22: Audio II, HUD customisation and accessibility
- Pit radio calls out gaps, flags and strategy as text messages with a synthesised radio beep (decision 5). Crowd reactions, better impact and scrape sounds, and menu music generated in code.
- HUD editor: move, resize and hide elements, with presets.
- Accessibility:
  - Colour-blind modes for flags, sectors, UI and the racing line, using shapes and patterns as well as colour.
  - Text size and high contrast.
  - Reduced motion.
  - A choice of hold or toggle for buttons.
- A full check of settings: every option is saved, exported and reachable with a controller. Units: km/h or mph, °C or °F, bar or psi, litres or gallons.

**Automated checks:** every setting has a default, is saved and exported, and can be reached by the simulated pad. Colour-blind palettes pass contrast checks.

**Your checks:** play with a colour-blind mode and large text. Customise the HUD. The radio should be useful, not annoying.

### Round 23: Photo mode
- Open photo mode from pause or from a replay. It has a free camera, field of view, depth of field, exposure, filters and frames, and hides the HUD.
- A path-traced render that improves over time: a separate WebGL2 canvas running three-gpu-pathtracer on a converted copy of the scene. A sample counter and PNG export. An enhanced normal render as a fallback where path tracing isn't supported.

**Automated checks:** on a fixed scene, noise keeps falling as samples add up. The exported PNG has the right size. Memory is freed on exit.

**Your checks:** take shots on PC and iPad. The path-traced image is clearly nicer, and leaving photo mode returns you to the race intact.

### Round 24: Performance, loading on demand, polish and v1.0
- Loading on demand: each track loads only when needed, visited tracks are cached for offline use, and the next event is loaded ahead of time.
- A review of detail levels (LOD) and instancing.
- A memory-leak check with a long session.
- Loading screens.
- Final performance tuning on the Low and High presets.
- Fixing all remaining bugs, credits and attribution, and the v1.0 tag.

**Automated checks:** a 2-hour test running AI races in a loop shows no memory growth. All standing checks pass. Download sizes stay within budget.

**Your checks:** a final test on PC and iPad of everything we kept from the vision.

---

## 8. Top risks

| # | Risk | Likelihood / impact | What we do about it |
|---|---|---|---|
| 1 | **Scope and time.** The vision is studio-sized, and quality could slip to keep up. | High / high | Each round ends at a review gate with a definition of done. Systems come before content. At every round review we agree what to cut if needed. |
| 2 | **Handling feel.** I can't hold a controller, so feel can only be tuned through your feedback. | High / high | Measurable benchmarks, telemetry and a live tuning panel. Every round starts with a handling fix based on your notes. |
| 3 | **Safari and iPad surprises.** Safari's WebGPU is young. Tabs get reloaded under memory pressure. iPads slow down when hot. No rumble. Audio must be started by a tap. The PWA's storage is separate. | Medium / high | iPad testing from Round 1, a "force WebGL2" setting, a memory budget, a battery-saver mode and save export/import. |
| 4 | **Performance on iPad at 60 fps** with 20 cars, weather and effects. | Medium / high | Budgets for every round. The benchmark from Round 11. Dynamic resolution with upscaling, detail levels (LOD) and instancing. AI processing cost measured from Round 9. |
| 5 | **Physics stability.** Stiff tyres at low speed, kerb impacts, bump stops and pile-ups can make the numbers blow up. | Medium / high | Stable integration for the wheels, the grip build-up delay in the tyre model, a collision solver that repeats its passes, fuzz tests every round, and a NaN guard. |
| 6 | **Visual quality without artists.** Generated art has a ceiling. | High / medium | CC0 textures and skies, strong lighting, a consistent art direction. glTF import if you get car models. |
| 7 | **three.js keeps changing.** New releases change the API and can bring bugs. | Medium / medium | Pin version r186. Upgrade only between rounds, comparing screenshots before and after. |
| 8 | **Controllers and wheels vary.** Mappings differ, browsers report controllers differently, and wheels use unusual layouts. | Medium / medium | Use the browser's standard controller layout first, then per-device profiles, the controller tester, rebinding, and the list of your devices (question 1). |
| 9 | **Deployment permissions.** GitHub Pages has to be switched on, and my credentials may not be allowed to push workflow files. | Low / medium | You switch Pages on once. If a push is blocked, I give you the file to add in GitHub's web page. |
| 10 | **Save loss or migration bugs.** | Low / high | Version numbers on every save, migration tests using saves from every round, export/import and `storage.persist()`. |
| 11 | **Legal and IP.** | Low / medium | Fictional names only. No series trademarks or look-alike liveries or logos. CC0 assets only, credited in `ATTRIBUTION.md`. |

---

## 9. Decisions (your answers after Round 0)

You agreed with all the push-backs in §2: no real-time ray tracing, path tracing only in photo mode, no rumble on iPad, wheel force feedback as a stretch goal, stylised art generated in code.

1. **Test devices.** A recent iPad on the latest iPadOS, played with a **PlayStation DualSense** on both PC and iPad. A **steering wheel on PC** (Logitech G29/G923 class), so Round 20 includes an axis and pedal calibration wizard for it. The PC has a 144 Hz+ monitor; the GPU is unknown, so the game auto-detects and scales quality.
2. **Workflow.** `main` created. One PR per round; I merge it myself once its checks pass, so `main` always deploys. You switch GitHub Pages to "GitHub Actions".
3. **Handling reference.** F1 25 style: realistic, but fun and controllable on a DualSense.
4. **Art.** Cars and tracks generated in code, plus CC0 textures.
5. **Audio.** Engine sounds, music and radio all generated in code. The radio is text messages with a synthesised beep.
6. **Online.** Local-only.
7. **Touch.** You test the iPad with the DualSense, but touch controls must still exist before the end (Round 20).
8. **Roster and rounds.** Variants are OK. 24 rounds, kept small and solid.
9. **Language and units.** English only. Metric by default, with an imperial toggle.

---

*Not planned unless you ask for it: online multiplayer, VR, layouts for phones, Android-specific work, licensed real-world content.*

---

## 10. Progress log

### Round 1: Foundations
- **Built:**
  - Vite + TypeScript + three.js r186 project, with lint, formatting, unit and browser tests.
  - GitHub Actions: CI on every PR, and a GitHub Pages deploy whenever `main` changes.
  - An installable PWA with offline play and an update prompt.
  - WebGPU rendering with automatic WebGL2 fallback.
  - The 400 Hz physics worker, with smooth blending between steps on the main thread.
  - The test car: rigid body, raycast suspension, Magic Formula tyres, engine with auto gearbox, ABS and traction control.
  - The proving ground, with a painted loop and knock-over cones.
  - A chase camera, keyboard and DualSense/Xbox controls, HUD, performance overlay and help card.
- **Measured (Node physics bench):**
  - 0–100 km/h in 3.15 s; top speed about 290 km/h; 200→0 km/h in 87 m.
  - 1.4–1.6 g steady cornering; stable at the limit.
  - About 6 µs per physics step.
- **Learned:**
  - three.js r186 always sets a texture-view `swizzle` option. Some Chromium builds implement an older draft of that option and throw, which gives a black screen. A small build-time patch (`tools/vite-plugin-three-compat.ts`) removes it, and the build fails if the patch ever stops applying.
  - Headless Chromium's software WebGPU loses its device right after start-up, even on a bare three.js page. That's a quirk of the test environment, but it showed the game needs to handle device loss. It now falls back to WebGL2 automatically if WebGPU dies in the first 15 s, and otherwise shows a Reload button.
  - ABS and traction control must be slip *controllers* that model the wheel's effective inertia. Simple torque limits either lock the wheels or strangle launches.
  - The service worker must ignore `Vary` headers when matching cached files, otherwise offline play fails.

### Round 2: Handling (F1 25 style) and steering wheels
- **Fixed from the Round 1 review:**
  - The physics fell behind real time below 10 fps (a 100 ms catch-up cap), and the fps readout was capped the same way. The cap is now 250 ms and fps is measured from real time. Tests prove real time within 1 % at 5–20 fps.
  - Traction control cut power at every launch, even with no wheelspin: its target wheel speed didn't account for the car accelerating. ABS had the mirror-image flaw. Both now follow the car's acceleration; TC stays off on a clean dry launch.
- **Built:**
  - Tyres: carcass relaxation (grip builds over ~0.3 m of rolling), camber and camber gain, a low-speed model, and a brake hold that parks the car on a 15 % slope.
  - Driveline: clutch-pack limited-slip differential (preload plus power/coast locking), clutch pedal, manual gearbox with paddles, rev-matched downshifts and over-rev protection, and early automatic downshifts under braking.
  - Assists: ABS and TC at Off / Low / High, gearbox Auto / Manual.
  - Pad steering: stick dead zone and centre precision, smoothing and rate limits, and a speed-sensitive range that always reaches the grip limit at full stick.
  - Steering wheels: detection, a calibration wizard (steering, pedals incl. combined pedals and pedals that read 0 until moved, buttons incl. hat switches), and per-wheel settings for rotation, dead zone, linearity, pedal curves, dead zone, saturation and invert. Wheels steer 1:1.
  - Trigger curves (Linear / Progressive / Aggressive) and dead zones; an in-race quick menu (D-pad or Tab); versioned settings with migration from Round 1.
  - Telemetry panel (F3 / touchpad / L3+R3): inputs vs applied, per-wheel load, slip ratio, slip angle, grip use, camber and surface, and a g-g plot.
  - HUD: shift lights, auto/manual indicator, TC/ABS levels, refused-downshift flash.
  - Code-generated engine sound and tyre squeal.
  - Proving ground: a 1 km drag strip with boards and automatic timing (0–100, 0–200, 400 m, 1 km), a 60 m skidpad, and teleports.
- **Measured (Node physics bench, GT test car, TC/ABS High):**
  - 0–100 km/h 3.21 s, 0–200 km/h 9.41 s, top speed 291 km/h.
  - 200→0 km/h in 86 m with ABS (96 m with locked wheels).
  - 60 m skidpad: 1.46 g, understeering gently at the limit.
  - Parked on a 15 % slope with the handbrake: under 0.1 mm of creep in 10 s.
  - About 8 µs per physics step.
- **Learned:**
  - A slip controller has to follow a moving target: the right wheel speed changes as the car accelerates, so ABS and TC need the car's acceleration as a feed-forward term.
  - A pad's steering range should be the kinematic grip-limit angle plus about half the tyre's peak slip angle. Using the full peak slip angle put the limit at a quarter of the stick at high speed.
  - Cars must be placed flush with sloped ground on reset, or they flip; the Round 4 tracks need this anyway.

### Push 3: Menus, circuits, AI racing, championships and 25 cars (v0.3.0)
- **Built:**
  - Menus for controller, keyboard, mouse and touch, with animated transitions: title, main menu, track and car select, race setup, pause, results, championship, standings, settings (gameplay, controls, wheel, rumble, graphics, audio, data), rebinding of buttons and keys, a controller tester, controls and about. Button prompts match the device in use.
  - Six fictional circuits (2.5–5.5 km): Merriford Park, Port Aveline Street Circuit, Lake Vireska, Solmara International, Veltmoor Autodrome and Sunhaven Coast. Each has kerbs, gravel or grass run-off, barriers, a start gantry with working lights, grandstands, trees, and its own sun and colours. There is a minimap.
  - AI drivers that follow a computed racing line with four difficulty levels, overtake, recover from spins and reset when stuck. Car-to-car contact.
  - Race rules: grid, five red lights, lap and sector timing, positions, gaps, finish and results.
  - Game modes: Quick Race, Championship (3–6 rounds, points for the top ten, grid in championship order, saved between visits), Time Trial with track records, and Free Drive.
  - 25 cars in five classes, with computed power, weight and top speed, and 12 paint colours.
  - Controller rumble mixer (wheelspin, lock-ups, ABS, shifts, limiter, kerbs and grass, impacts).
  - Touch controls for iPad: drag or tilt steering, pedals and paddles.
  - A race engineer on the radio (the browser's speech synthesis, with subtitles).
- **AI grip calibration:** each car's racing line plans with a measured share of its estimated grip. The share is the largest with which a flat-out AI laps five circuits without leaving the road, and it is stored per car. Rerun it with `npx vitest run -c tools/vitest.config.ts` after changing a car.

### Push 4: Replays, weather, liveries, damage, photo mode and eight circuits (v0.4.0)
- **Built:**
  - **Replays:** recorded at 30 Hz for every car. Watch from the results with TV cameras (trackside cameras and a helicopter, with automatic cuts), a chase camera or onboard, at 0.25× to 4×, following any car.
  - **Menu backdrop:** an AI race on a circuit filmed by the TV cameras, in random conditions.
  - **Time-trial ghost:** the best lap on each circuit, saved in the browser.
  - **Circuits:** Dunmore Raceway (a roval) and Mirador Desert Circuit, for eight in total.
  - **Liveries:** an editor with 8 patterns, 3 colours from 24, a race number, 4 finishes and 12 presets. Rivals get random, harmonious liveries that stay the same all season. Cars now take about 17 draw calls instead of 45.
  - **Weather and time of day:**
    - Five times of day and five weathers, per race.
    - Rain wets and darkens the track, pulls the fog in, adds rain streaks and spray, and cuts grip for everyone. The AI's racing line uses the wet grip.
    - Championship rounds get random conditions.
  - **Damage:**
    - Off, Light or Full.
    - Impact energy from barriers and other cars costs downforce and adds drag, costs engine torque, and bends the steering so the car pulls.
    - Bars appear on the HUD, and the race engineer calls it out.
  - **Photo mode:** from the pause menu or a replay. Free camera, field of view, roll, depth of field, exposure, contrast, saturation, filters, vignette and grain. Saves the shot as a PNG with an optional watermark.
- **Fixed from the v0.3.0 review:**
  - **Controller menus:** gamepad buttons are polled, so a quick tap between two frames could be missed. Presses are now sampled between frames too and never lost. A new browser test plays from the title to a race and back with only a mocked DualSense.
  - **HUD:** the driving HUD no longer shows faintly behind menus.
  - **Settings screens:** they now redraw immediately after a change.

### Push 5: SUVs, sedans, mixed-class grids and real car bodies (v0.5.0)
- **From the v0.4.0 review:**
  - **SUV class:** 5 all-wheel-drive SUVs: heavy (1.8–2.4 t), a high centre of gravity and soft, long-travel suspension, so they lean and pitch.
    - The driveline now supports a front/rear torque split with a centre coupling and a limited-slip diff on each axle. Rear-drive cars behave exactly as before.
    - AI grip is calibrated for all five.
  - **Touring = sedans:** three-box saloon bodies and descriptions.
  - **Mixed-class grids:** race setup and championships offer Same car, Mixed cars from one class, or Two classes. Each car gets its own model and AI racing line, the faster class lines up in front, and rivals keep their cars all season. Results show each driver's car.
  - **Car bodies:** closed cars are no longer boxes. The shell is a side profile (nose, bonnet, deck and tail) extruded with rounded edges, and the glasshouse has a raked windscreen and rear window, a narrower top and a painted roof. Each style has its own proportions: fastback GT, low prototype, three-box sedan, coupé and upright SUV. The player's car and the AI cars use the same bodies.

### Push 6: Premium start and graphical menus (v0.6.0)
- **Intro:** a studio mark (the fictional Kestrelight Games), then the game logo with a light sweep. Any key, click, tap or controller button skips it. Only transform and opacity animate, so it stays smooth while the game loads underneath. Automated browsers and `?drive` skip it.
- **Title:** the menus' backdrop race waits on the grid while the camera slowly circles the hero car in the player's livery, with drifting points of light. Leaving the title starts the race, which the TV cameras then follow.
- **Menu music and sounds:** a synthwave loop generated in code (pads, bass, arpeggio with echo, drums) plays in the menus and fades while driving. Moving, selecting, tabs and back each have their own sound, and selections give a light controller rumble. Music and menu-sound volumes are in Settings.
- **Graphical menus:**
  - The main menu is icon tiles with 1–2 word labels, and hints appear only on focus.
  - Car select is a compact list with stat bars (power, acceleration, top speed, grip), and the car in focus is shown in 3D behind the menu.
  - Track descriptions appear only on focus.
  - Every screen change gives the camera a short zoom.
- **Loading screen:** a car silhouette with a light streak.

### Push 7: Driving school, hybrid systems and race cinematics (v0.7.0)
- **Driving school:** offered once on the first visit and always in the main menu. Seven short lessons in the junior formula car at Merriford Park: accelerate, brake, stay on track, follow the racing line (drawn on the road, red in the braking zones), brake in the red, open DRS, use the ERS boost. Each lesson is a controller, key or touch prompt with a progress bar and passes on its own; no paragraphs. Pit entry waits for pit lanes.
- **DRS and ERS:** Formula and Prototype cars carry a drag reduction system (allowed in the zones found on straights of 400 m or more, in races only within a second of the car ahead after lap 1) and a hybrid boost (90–120 kW from a battery that harvests under braking). □ / X and L3 on a controller, F and B on the keyboard; the HUD shows the DRS lamp and the battery; the AI opens DRS and boosts when it is flat out with charge to spare.
- **Race intro:** a seven-second flyover of the end of the lap into the grid under a title card (circuit, location, laps, weather); the grid waits and any button skips it.
- **Podium:** after the flag the top three stand on a podium beside the start line under confetti with a winner banner while the camera circles them; the results come up over it. Any button skips ahead.

### Push 8: Free Roam, part 1 — the open world (v0.8.0)
- **Free Drive becomes Free Roam:** a procedural open world generated from a seed and shared by the physics worker and the renderer (`src/content/city`): a downtown grid (avenues every 200 m, streets between them, towers in the core), an **elevated orbital highway** (a rounded 1.2 km square on pillars, two carriageways with a median) with **on/off ramps** at four diamond interchanges where the central avenues pass underneath, suburbs to the west, an industrial **port** to the east with warehouses, container stacks, cranes and the sea past the quay, a **mountain road** of switchbacks up a 150 m ridge (its height profile is smoothed and the grade capped at 10 %), and the **club circuit** embedded to the south with an access road. Speed limits and junction controls (signals, stop, yield) are in the map for the traffic of Push 9.
- **Physics:** a new `Surface` for the world: a height field with the roads cut into the hillside, the deck and ramps as a second level (a wheel's ray finds whichever surface is under it, so the underpasses work), buildings and big props as walls, barriers along the deck edges and the median, the quay and the map's edge. `heightAt` and `wallContact` now take the point's height, so stacked surfaces are unambiguous.
- **Rendering:** `CityScene` streams 250 m chunks around the car (ground, roads with lane markings and pavements, the deck with its slab, barriers and pillars, houses, warehouses, containers, cranes, street lights, signals, stop signs, trees), one chunk per frame, and drops them again out of reach; downtown's buildings are one instanced draw so the skyline shows from anywhere. Facades get their windows from the world position (every floor the same size on every building) and light up at night. A **detail level** (Settings → Graphics → World detail; auto picks by cores, memory and phone or tablet) sets how far the chunks reach, the shadow map and whether props are drawn; the fog closes where the streaming stops.
- **Night:** a new time of day (moonlight, a dark sky and fog); lit windows and lamp glows in the city.
- **The car's lights:** headlights (with real beams on the player's car), indicators that cancel after the turn, hazards, brake lights and a horn. Keyboard L / , / . / X / N; in free roam the D-pad works the lights and R3 is the horn (the quick menu stays on the keyboard there).
- **iPad:** tilt steering now measures how far the screen's horizontal axis dips from level (from the gravity vector, worked out from the tilt angles), so it works whether the iPad is held flat or upright, works out which way round it is turned by itself, and asks for motion access again on the first tap when the setting is restored at start-up (iOS only grants it from a tap). The tyre squeal is now a tone with harmonics and a warble over a little noise, in the 0.8–1.6 kHz band, rather than whistling noise.
- **HUD:** a speed-limit sign for the road you are on and a minimap of the roads around you.
- **Honest limits:** no traffic, police or events yet (Pushes 9–12); buildings are boxes with shader windows, not modelled facades; street lights glow but only the player's headlights cast light; the map is about 3.5 × 4.5 km, not a continent, and a phone gets two chunks of reach and no props.

### Push 9: Free Roam, part 2 — traffic (v0.9.0)
- **Lane graph** (`src/content/city/lanes.ts`, pure, shared by the worker and the renderer): every road becomes one directed lane polyline per lane and direction (right-hand traffic: on the clockwise orbital that is the *inside* carriageway, so the ramps now attach to the right side and the highway spawn faces the right way), cut at the junctions it passes; turn connectors (quadratic curves) join the lanes across each junction with lane rules (straight stays in lane, right turns from the rightmost, left turns from the innermost; a lane with no legal move may use any, and a dead end turns around); on- and off-ramps join the orbital's outer lane at merge nodes; each link knows the control at its end (signal with its axis, stop for the minor road, yield) and its speed limit. Signals cycle green → amber → all red per axis (11 + 3 + 1.5 s), each junction on its own offset, from the simulation clock — the traffic obeys the same function the renderer draws.
- **Traffic** (`src/sim/city/Traffic.ts`): kinematic everyday cars (sedans, street cars, SUVs from the existing classes, plain paints) driving the lane graph in a bubble around the player: an intelligent-driver model follows the car ahead (and the player when it is in the lane), brakes for red and late amber, stops at stop signs and waits for crossing traffic, gives way, holds a left turn for oncoming traffic, slows into turns, picks turns at random (mostly straight), indicates 35 m before a turn, shows brake lights, puts its hazards on after a crash; cars beyond the bubble respawn on a lane inside it, never in the player's face. The number of slots comes from the detail level (8 / 14 / 20). Player contacts are oriented-box collisions on the ground plane: the player's car takes the impulse (and the damage), the traffic car is shoved and stops.
- **Snapshot:** traffic slots ride after the physics cars in the same buffer layout, so the renderer, minimap (pale dots) and lights (headlights at dusk and night, indicators, hazards, brake lights) need nothing new.
- **Rendering:** signal lamps at every signalled junction, lit from the sim time (the far right-hand corner of an approach shows its signal); street-lamp glows are upright crossed quads (they were flat and invisible from the road); trees keep clear of the deck.
- **Honest limits:** no lane changes or overtaking yet, no pedestrians, traffic doesn't react to the horn, traffic–traffic collisions are avoided by following distance rather than resolved physically, and a shoved car slides sideways rather than spinning.

### Push 10: Free Roam, part 3 — police and pursuits (v0.10.0)
- **Police** (`src/sim/city/Police.ts`): a few of the traffic slots (3 / 4 / 5 by detail level) are patrol cars — the everyday saloon in white with a roof light bar. Off duty, two of them drive the lanes with the traffic. They notice the player within 170 m and in line of sight (sampled against the buildings): speeding by 20 km/h over the limit for two seconds, entering a signalled junction against the red at speed, hitting traffic (its hazard lights are the witness) or hitting a police car is an offence: heat +1 (five stars at most, one offence per 10 s) and a fine that grows with the heat.
- **Pursuit:** heat + 1 units give chase with sirens: along the lanes at up to 2.2× the limit while far away, then freely across the paved ground once within 55 m (back to the lanes when they drop behind). The first unit lines up a PIT — the rear quarter on its side, then through it; from heat 3 the others box the player in from ahead, one each side, holding just under the player's speed so the box closes. Roadblocks from heat 3: every 45 s two units park across the player's road 260 m ahead; from heat 4 a spike strip lies before them, and a wheel crossing it bursts the tyre (its grip goes with it; a reset restores the tyres). Out of sight of every unit for 14 s and you are away (a bar on the HUD shows how close); stopped within 14 m of a unit for 3.5 s and you are busted: the fine is paid and the heat cleared.
- **HUD and feedback:** a wanted widget at the top (stars, PURSUIT / GOT AWAY / BUSTED, the escape bar and the fine), notices when the heat rises or the pursuit ends, red-and-blue strobes and wig-wag headlights on the police cars, blue dots on the minimap, a siren wail whose volume follows the nearest unit with its lights on, and the strips modelled on the road.
- **Snapshot:** a siren flag per car; the police status rides with the snapshot message (heat, state, the share of the escape, fines, strips).
- **Honest limits:** the police are kinematic like the traffic (a PIT shoves rather than spins you), they stay on the lanes over the highway deck, roadblocks are two cars across the road with no barriers, there is no helicopter and no jail time, the fines have nothing to buy yet, and traffic doesn't pull over for sirens.

### Push 11: Free Roam, part 4 — soft-body damage (v0.11.0)
- **The soft body** (`src/sim/vehicle/softbody.ts`): the player's shell is a node-and-beam lattice in the body frame (3 wide × 2 high × 5 long: nose, front axle, cabin, rear axle, tail; 30 nodes, about 200 beams), each node on a spring to its rest position and on beams to its neighbours. Anchors and beams that stretch past their yield stay stretched (plastic flow at once, like sheet metal), so a crumple is permanent until a repair. The ends are soft crumple zones (soft anchors, small yields), the cabin a safety cell (stiff beams, anchors four times as stiff), so a front hit crushes the nose and leaves the rear where it was. Wall contacts press the nodes in along the wall's normal at the closing speed; collisions with traffic and police throw the nodes along the impulse. It runs at the 400 Hz step and sleeps between impacts.
- **What the crush does to the car:** the nose's and tail's crush feed the engine and aero damage; the bend of the chassis (the nose's centre against the tail's) pulls the steering, up to about 5°; the crush at each corner softens and shortens that spring, leaks its damper and leans the wheel in, and a corner crushed onto the wheel bursts the tyre; panels come off past a crush of their row: the bumpers, the bonnet, the doors and the wing.
- **Rendering:** every body mesh is bound to the lattice with trilinear weights of the cell each vertex sits in, and follows the node displacements streamed after the cars in the snapshot (recomputed only when they change); the bumpers, bonnet, doors and wing are separate meshes that detach with the car's velocity and a tumble, fall to the road and lie there. Traffic and police cars keep it simple: a dent at whichever end was hit, by the closing speed, pushed into the mesh.
- **Repair:** in free roam the reset (R / △) is the quick repair too: the car is placed back on the road with its shape, tyres, suspension and damage as new, and the panels back on.
- **Honest limits:** the lattice is coarse (30 nodes), so a dent is a smooth crumple rather than creases; the rigid body still does the handling (a crushed corner changes its spring, camber and tyre, not the geometry of the suspension); panels detach as whole pieces without hinges; debris is visual only (the car drives through it); side impacts from traffic use the impulse, not a sustained press; and there is no windscreen cracking or wheel detachment yet.

### Push 12: Arcade handling (v0.12.0)
- **The toggle:** a Handling choice (Sim / Arcade) in every mode's setup, alongside the aids; Sim is the default and races keep it unless asked. The session config carries it and every car in the session drives the same physics (the AI included), so an arcade race is fair.
- **Arcade physics** (`Car.arcadeAssist`, on top of the real model rather than a second one): 30 % more grip and 15 % less drag; a sliding tyre keeps 85 % of its peak grip instead of falling away, so a slide is something to steer; while the rear slides the yaw is damped and the steering turns the car, so a drift holds instead of spinning; a nitro tank (60 % extra torque while the boost button is held on the throttle, four seconds of burn, eighteen to refill); and in the air the car is 15 % lighter and the stick pitches and yaws it for the landing.
- **Skill points** (`src/app/Skill.ts`, on the main thread from the render states): drifts (banked when the slide ends, by speed and angle), near misses (a car passing within reach at a closing speed, without touching — its hazards would be on), holding speed (every four seconds over 160 km/h), air time and smashed cones, chained into a combo whose multiplier grows to 3× and is lost in a crash (a spike of felt acceleration) or lapses after four quiet seconds. The HUD shows the score, the chain and pop-ups per event; the nitro tank and an ARCADE badge join the HUD panel.
- **Smashables:** in arcade free roam, festival cones stand on the corners of the flat junctions, sent flying for points (the proving ground's cones score too).
- **Honest limits:** the nitro and the drift assist are tuned by feel, not from a reference; skill points don't persist or unlock anything yet; the cones are the only smashable props and they live on the ground plane (flat parts of the map only); jumps need ramps, which the festival hub push adds with its events; there is no arcade AI rubber-banding.

### Push 13: The festival (v0.13.0)
- **Events on the map** (`src/content/city/events.ts`, derived from the map so the worker, the renderer and the main thread agree): six **speed cameras** (gantries on the central avenue, the boulevard, the orbital, Dock Road, Ridge Road and Paddock Lane), four **jumps** (ramps behind danger signs on flat straights: a 12 m wedge rising 1.8 m), four **drift zones** (stretches of Ridge Road, the circuit, Dock Road and Quay Street with gates at both ends) and five **races** (Downtown Dash and Crosstown along the avenue and the boulevard, an Orbital Lap, the Ridge Climb, a Club Lap of the circuit) with checkpoints every ~200 m and a par time by the road's pace for gold, silver (par × 1.15) and bronze (× 1.35).
- **The rules** (`src/app/Festival.ts`, main thread from the render states and the sim clock): crossing a camera's line registers the speed; a race starts by crossing its start line forwards and is timed through its checkpoints (abandoned 400 m off the next one or after 20 s stopped); a drift zone tallies speed × slip while you are in it and banks on leaving; a jump measures the flight from the ramp's lip to the landing. Bests are kept per event in the browser. The event HUD (bottom centre) shows the event under way — time and checkpoint, points, metres — or the nearest event and its distance; notices report results and medals; a finished race with a medal pays 500 skill points in arcade. While an event is on, or one is within 150 m, the police let the speed go (red lights and crashes still count), so a race isn't a pursuit.
- **Ramps in the physics:** `CitySurface` carries the jumps' wedges (height and a sloped raycast plane), so the wheels climb them and the car flies off the lip.
- **Fast travel:** Pause → Festival map: an SVG map of every road with the six starts and every event as coloured markers and the car, and a list of destinations with their bests; choosing one places the car at the start or 45 m before the event facing it, as new (a `place` command in the sim).
- **Rendering:** gantries with a camera box, cyan-bannered gates, ramp wedges with a yellow lip and diamond danger signs, red start arches and a finish flag, and a spinning ring at the next checkpoint during a race; the events are diamonds on the minimap in their colours.
- **Honest limits:** races are against the clock, not rivals (AI street racers need a route-following driver, which the traffic's lane follower can grow into); events don't chain into a career or unlock anything; the map screen has no zoom; markers are drawn as simple shapes rather than modelled signage.

### Push 14: Street racers (v0.14.0)
- **Rivals for the festival's races** (`src/sim/city/Racers.ts`): a few traffic slots after the police (3 / 4 / 5 by detail level) are street racers in the street and touring classes, each with a livery. Off a race they are out of the world. When the player comes within 160 m of a race's start line, behind it, they line up on a grid past the line (two columns in the road's lanes where they fit, one on a single-lane road; the pole furthest ahead); crossing the line puts the player on its own slot at the back (a `teleport` in the sim, the camera reset behind it), holds it there through a 3.5 s countdown (the grid hold the races use), and the field goes.
- **How they drive:** kinematic like the traffic, a distance along the race's road (`FestivalEvent.route`) and a sideways offset in a band of the road (their side of a two-way road, the whole width of the circuit): the speed the corners ahead allow (from the road's curvature 0–120 m ahead at 7 m/s² of lateral grip, braking to make each), a top speed from the event's par pace scaled by each racer's skill, the inside line into a bend, a gap to the racer ahead with a move to the other lane to pass, a move around the traffic in the band (or into the oncoming lane while it is clear, on a single lane) and no faster than the car blocking them until they are past; and the rubber band: eased off 120 m ahead of the player, waiting on it beyond 260 m, flat out when behind. The player collides with them as with the traffic, but they race on (a knock takes some speed, no hazards, no police offence).
- **Positions and the finish:** the sim tracks the player's progress along the route (unwrapped on a lap) and each rival's; the position counts the rivals ahead or already home; the player's time is taken at the line, the rivals coast in and go. The status rides with the snapshot (`roamRace`: phase, countdown, time, position, progress, rivals); the festival's rules on the main thread start a race from it (no more crossing-based start), show the countdown and `P2 · 0:12.34` with the checkpoints on the event HUD, report `P1 of 4 · time · medal` at the flag (a win pays 1000 skill points in arcade), abandon it as before (400 m off the next checkpoint, 20 s stopped, a reset or a fast travel) and tell the sim (`endRace`) so the rivals stand down.
- **Tests:** `tests/unit/racers.test.ts` (slots and idleness; the grid forms past the line on the road and breaks up when the player leaves; the standing start holds the player and the field goes, stays on the road at sensible speeds, and waits when far ahead; the player's time and position at the line; standing down and forming again), the festival tests rewritten around the sim's race status (start from the countdown, checkpoints, the flag and position from the sim, no double start, abandonment telling the sim).
- **Honest limits:** the rivals are kinematic (no tyre model, no damage beyond dents, they don't collide with each other or with the traffic physically — they steer around it and slow instead), they run one fixed route per race with no alternative lines, they pass through the police, there is no race intro camera or podium, no rewards or career yet, and the traffic doesn't clear the road for them.

### Push 15: Street-race presentation (v0.15.0)
- **The grid behind a fade:** crossing a race's line no longer snaps the car onto its slot in view: the sim holds the car where it crossed for 0.35 s while the screen fades to black, puts it on the slot, and reports `placed`; the main thread fades back in (and resets the camera behind the car) on that, and the count (3 · 2 · 1) starts once it is there.
- **Names and standings:** the AI names move to `src/content/drivers.ts` (race rivals in order, street racers mixed); during a race the event HUD lists the field under the time — position, driver, and each rival's gap to you in metres (or its time once home), you highlighted — from the sim's progress figures, rebuilt only when a row changes.
- **Results card:** at the flag a card comes up for nine seconds (`src/ui/RaceCard.ts`): the race, `P2 of 4 · time · medal`, and every driver's position with their time or their gap when still on the road; hidden by a reset, a fast travel, the menus or a new race.
- **Traffic and sirens:** lane traffic within 70 m of a police car with its siren on slows to a crawl and eases 1.7 m to the right of its lane until the siren has gone, then eases back and drives on (a `pullOver` share on each vehicle, in the pose).
- **Tests:** the festival test checks the standings' order and gaps and the results at the flag; the racers test checks the hold at the line, the delayed placement and the count starting on it; a police test parks a unit with its siren on beside a traffic car and checks it stops and moves over, then eases back.
- **Honest limits:** the results card knows only what the sim knew at your flag (rivals still on the road show a gap, not a projected time); rivals have names but no faces or radio; traffic pulls over in its lane rather than onto the verge, and doesn't pull over for the player's own horn.

### Push 16: Pedestrians (v0.16.0)
- **Walkers on the pavements** (`src/sim/city/Pedestrians.ts`): 60 / 100 pedestrians by detail level (none on a phone) in a bubble of 180 m around the player on the downtown grid's pavements (streets and avenues), kinematic: a road, a distance along it, a side and a direction, at a walking pace of 1.1–1.7 m/s with a little wander across the pavement. At each junction one turns round the corner onto the crossing road's pavement, turns back, or crosses the road ahead: waiting at the kerb until, at a signalled junction, the traffic it crosses has red and its own side has just gone green (time to get over), and elsewhere until nothing is moving within 32 m of the junction; a long wait ends in a turn instead.
- **Nobody is run over:** a car (the player's, or any traffic, police or racer) whose path reaches a pedestrian within 1.6 s makes it leap sideways off the car's line at 5.5 m/s for half a second; the push eases out as it walks on. That leap is the whole of the collision: there is no impact.
- **Traffic stops for them:** anyone crossing or leaping in a car's lane ahead (on its link or the next) is a stopped leader for the traffic's following model.
- **Snapshot and rendering:** five floats each (x, y, z, yaw, state) after the cars and the soft body (`snapshotFloats(carCount, pedestrians)`); `src/render/Pedestrians.ts` draws them as one instanced figure (legs, torso, arms, in clothes coloured per person) plus an instanced head in a skin tone, bobbing and swaying while walking and lifting in a leap, matrices updated each frame from the block.
- **Tests:** `tests/unit/pedestrians.test.ts` (they fill the pavements around the player and walk at a walking pace, and ride in the snapshot; every crossing started at a signalled junction had the crossed traffic on red; a car aimed at one makes it leap off the car's line; a traffic car stops short of someone crossing in front of it).
- **Honest limits:** pedestrians live downtown only (no suburbs, port or paddock); they are boxes with a bob rather than animated characters; they don't react to the horn, look before crossing beyond the gap check, or gather at anything; the leap can look abrupt when a car is very fast; a stopped car doesn't edge forward once the crossing is empty until its following model says so.

### Push 17: Street-race cinematics and the horn (v0.17.0)
- **The sweep over the grid:** once the car is on its slot the sim holds the field 3.2 s longer (`RoamRaceStatus.intro`) while the camera flies from ahead of the field on its right, looking back along it, down to behind the car (`Game.updateGridIntro`), and the event HUD says GET READY; then the 3 · 2 · 1 with its beeps.
- **The winner's moment:** a P1 finish brings confetti and a YOU WIN banner (the podium's styles) while the camera circles the car for five seconds (any button or a tap ends it), then the driving camera comes back.
- **The horn:** the player leaning on the horn within 35 m behind a traffic car in its lane makes it slow to a crawl and ease over to the right, as for a siren, until the horn stops; a horn within 30 m hurries anyone crossing (1.9× their pace for three seconds) and holds anyone at a kerb near the junction.
- **Tests:** the festival test checks the GET READY view before the count; the racers tests check the hold (sweep plus count) and that the count waits at 3 through the sweep; a traffic test parks the player on the horn behind a car and checks it pulls over and eases back; a pedestrian test checks the hurry.
- **Honest limits:** the sweep is a straight flight, not a crane shot with a title card; the winner's moment has no podium or rival reactions; the horn moves one car at a time and never clears a queue; and the count still can't be skipped.

### Push 18: Free roam onboarding, other cars' engines, festival totals (v0.18.0)
- **Other cars' engines** (`EngineAudio.updateOthers`): three extra voices in the engine graph, one exhaust wave each (detuned a little from the player's and from each other), lowpassed and faded by distance; each frame the game picks the nearest three cars within 90 m (traffic, police, racers, race rivals) and steers a voice from each one's rpm and throttle, level falling with the inverse square past a 12 m knee and brightness muffling with distance (`otherEngineLevel`, `otherEngineCutoff` in `synth.ts`).
- **First-drive hints:** on the first free roam drive four notices come at 4, 16, 30 and 44 s (the lights and horn, the festival map, the police, the races and the reset), worded for the keyboard or a controller by the last device used; a `roamHinted` setting keeps them to once per browser (not in automated browsers).
- **Festival totals:** the map screen's subtitle reads the events with a result and the races' medals (`festivalTotals`).
- **Tests:** the other-engine curves fall and muffle with distance and stay finite on bad input, and `updateOthers` is safe without Web Audio; `festivalTotals` counts results and medals; the hints flag defaults off and repairs a bad value.
- **Honest limits:** the other voices are a single exhaust wave each (no rasp, limiter or squeal) and mono (no panning by direction); the hints are notices, not a guided drive; the totals don't count wins or a festival level.

### Push 19: Free roam on touch (v0.19.0)
- **Touch row for the city:** in free roam the on-screen controls show a row at the top left (above the steering zone, clear of the skill panel): LIGHTS, ◄ and ► indicators, ▲ hazards, and HORN held; the presses ride into the driver input with the keyboard's and the pad's (`TouchControls.take`), so an iPad can drive at night and use the horn.
- **Headlights after dark:** the player's headlights start on at dusk and at night (the switch still works either way).
- **Stereo for the other cars:** each of the other cars' engine voices goes through a stereo panner (where the browser has one), panned by the car's bearing from the focused car's heading (`bearingPan`): a car on your right sits right, one straight ahead or behind is centred, and one right beside you is centred rather than snapping to a side.
- **Tests:** the headlights come on at night and not by day; the pan follows the bearing in both headings, centres close by and stays finite on bad input.
- **Honest limits:** the touch row has no quick menu (TC, ABS, gearbox) and no camera button yet; there is no touch button for the festival map beyond the pause menu; the pan is by bearing only (no distance-based width or Doppler).

### Push 20: Touch completeness and the arcade rubber band (v0.20.0)
- **CAM and RESET on touch:** two buttons beside the pause button in every mode (`TouchControls.take` counts the taps; the input manager turns them into the `camera` and `reset` actions the keys and pads already raise), so an iPad can change camera and reset or repair the car.
- **The arcade rubber band** (`AiDriver.paceScale`, `arcadePace`, `World.rubberBand`): in an arcade race each rival's speed plan is scaled by its gap to the player in laps (0.35 per lap, between 0.9 and 1.1): rivals behind push on, rivals ahead ease off; sim races keep their honest pace, and nothing pulls before the lights go out.
- **Tests:** the band's curve and limits; an arcade race pulls the rivals by their progress and a sim race leaves them at 1.
- **Honest limits:** the touch row still has no quick menu (TC, ABS, gearbox); the band scales the whole plan rather than only the straights, so a trailing rival also corners a little quicker.

### Push 21: The police helicopter (v0.21.0)
- **Sight from above:** from four stars the police status carries `helicopter`; while it is up the player counts as seen wherever the units are, except under the orbital's deck (`Police.helicopterSees`: on the ground under a deck piece), so the only ways out of a five-star pursuit are the deck, a bust, or the heat clearing. It goes with the pursuit's end.
- **The craft** (`src/render/Helicopter.ts`): a body, glazed nose, tail boom and fin, skids, a flashing beacon and two spinning rotor discs, circling the car at 38 m out and 42 m up, arriving from high above and climbing away when the pursuit ends; a spotlight under the nose points at the car, up with the night.
- **Sound and HUD:** a rotor thump with a faint turbine whine (`MenuAudio.rotor`) while it is overhead; HELICOPTER OVERHEAD · HIDE UNDER THE ORBITAL under the stars; a notice when it arrives.
- **Tests:** the helicopter sees the player in the open and on the deck but not under it; at four stars it is up and, out of every unit's sight, the pursuit goes on with the escape bar at zero. A new browser test (`tests/e2e/street-race.spec.ts`) fast-travels to Downtown Dash, sees the field line up, crosses the line into the sweep and the count, and checks the race HUD and standings once under way.
- **Honest limits:** the searchlight casts no shadows and the helicopter has no rotor wash or downdraft; it never lands or gets in the way; the deck is the only cover (no tunnels or multi-storey car parks yet).

### Push 22: Continue where you left off (v0.22.0)
- **The spot:** free roam keeps where the car stands (position, heading, the car, the time of day, the weather and the handling) in the browser (`records.ts`: `loadRoamSpot`, `saveRoamSpot`) on pause, on quitting to the menu and every 15 s while driving, so closing the tab keeps it too.
- **Continue:** the Free Roam setup shows a Continue where you left off button (with the car and the time) when a spot is kept; it starts the session with the spot's car, day, weather and handling and puts the car there (`SessionConfig.roamSpawn`, ahead of `roamStart`).
- **MAP on touch:** the roam row gains MAP, which pauses into the festival map (a `festivalMap` action).
- **Tests:** the spot round-trips through storage, repairs bad data and is nothing without storage; a world built with `roamSpawn` puts the car exactly there.
- **Honest limits:** the spot doesn't keep the heat, the damage, a race under way or the festival event in progress; there is one spot, not a list of saves.

### Push 23: The quick menu on touch, and a skippable sweep (v0.23.0)
- **MENU ▲ ▼ on touch:** a second row under CAM and RESET raises the quick menu's `menuNext`, `menuUp` and `menuDown` actions, so TC, ABS, the gearbox, the curves, the steering and the volume can be changed on a touch screen as on a pad's D-pad.
- **Skipping the sweep:** during the sweep over a street race's grid a throttle press or a confirm sends `skipIntro`; the sim brings the count forward to 3 s at once (`Racers.skipIntro`, only once the car is on its slot) and the camera drops behind the car.
- **Tests:** the sweep skipped goes straight to the count and on to racing.
- **Review fixes** (from a code review of Pushes 21–23): the sweep skip is edge-triggered (a pedal still held from the line no longer skips the sweep on the first placed frame); a new session takes the helicopter and its rotor out of the sky; the roam row wraps onto a second line on a phone instead of running under the pause button, and the quick menu's row sits below the quick menu panel and the wanted widget; Continue reads the spot held in memory (so blocked storage still continues) and names the time of day properly; `forwardOf` / `yawOf` in `shared/math` and `darkness` in `content/conditions` replace four copies of the quaternion-to-heading formula and two of the time-to-darkness mapping.
- **Honest limits:** the quick menu's touch buttons are small on a phone; the count itself still can't be skipped.

### Push 24: A day in the city (v0.24.0)
- **The day's clock** (`src/content/conditions.ts`): the sun rises at 6:00, stands 60° high at noon, sets at 18:00 and sinks 14° under by midnight (`sunElevationAt`); each time-of-day setting is an hour on it (`hourOf`: morning in the morning, the rest in the afternoon and evening, night at midnight, the circuit's own sun in the afternoon); darkness follows the sun (`darknessAt`: golden hour 0.25, dusk 0.7, full night 6° under) and the headlights come on from dusk (`afterDark`). The city's sun crosses its sky 15° an hour on a path through its own afternoon sun (`src/content/city/day.ts`).
- **The sim keeps the time** (`World.day`): free roam starts at the chosen time of day's hour (or the kept spot's) and runs at the chosen rate (`SessionConfig.dayCycle`, real minutes per day: the setup's Still / A day in 24 minutes / A day in an hour); the snapshot carries the hour (`SnapshotMessage.clock`). When dusk falls the player's headlights and the traffic's come on, at dawn they go off, once each, so the switch still works between.
- **The city follows** (`CityScene.setClock`): the look is made for the sun's position every frame (`sceneLook` takes a sun instead of a time of day), the sky, the fog, the sun's colour and the shadows moving with it; the lamps and the windows come up with the darkness; the reflections are re-rendered as the sun moves on (every 1.5°, or a step of night). A clock reads on the HUD over the gear and speed (`hud-clock`), and the searchlight's night follows the clock too.
- **Continue keeps the hour** (`RoamSpot.hour`): the Continue button names the time on the clock, and the drive picks up at it.
- **Tests:** the clock's curve (sunrise, noon, sunset, midnight, continuity, wrapping), the hour for a sun either side of noon and for each time of day, darkness never lightening as the sun sinks, the headlights' threshold, the clock readout and the rates; the city's path through its own sun and round midnight; a world at golden hour with a day in 24 minutes runs the clock at an hour a minute and switches the lights at dusk and at dawn, a still day keeps the hour, a given hour wins over the time of day; the spot keeps the hour and drops a bad one. 366 unit tests.
- **Checked in the browser:** continuing at 17:30 with the day running: golden light on the avenue, then at 17:53 a dusk sky with the lamps, the windows and the headlights on and the clock on the HUD; at 19:50 full night. The kept spot carries the hour.
- **Honest limits:** no moon or stars; the sun's colour and the sky are the presets' blends, so the day has no weather of its own (clouds don't move); the signals and the traffic don't thin out at night; the circuits keep their fixed time of day.

### Push 25: Stars, a moon, and the day on the circuits (v0.25.0)
- **The night sky** (`Atmosphere.createNightSky`): 1400 stars as tiny instanced spheres spread evenly over the dome under the visible sky, brighter, larger and warmer at random, each twinkling to its own beat; and a full moon 25° up opposite the sun's bearing (it moves with the sun's path), a pale disc in a soft glow that fades to its rim. Both come up with the look's `night` (a new field of `SceneLook`: 0 by day and dusk, 1 with the sun well under) and go under a closed cloud deck; the fog leaves them alone; buildings and the ground hide them as they should. The reflections' sky has none (they would only glare).
- **The day on the circuits:** the race and time trial setups get the same *The day* choice (Still, a day in 24 minutes, a day in an hour; free roam keeps its own), the sun following a path through the circuit's own sun at its hour (`sunPathAt`, which the city's path now uses too); `TrackScene.setClock` makes the look each frame and re-renders the reflections as the sun moves on; the sim's clock starts at the chosen time's hour and every car's headlights come on at dusk and go off at dawn. At the night, dusk and (kept) time-of-day presets the cars on a circuit now run with their headlights on, cycle or not. The proving ground keeps its fixed light.
- **Tests:** the sun's path passes through a circuit's own sun at its hour, moves 15° an hour and is continuous round midnight; a race world with the clock running lights every car at dusk, one without stands still (night: lights on from the start), the proving ground never runs it; the scene look keeps the circuit's own sun by default, follows a chosen time, takes a sun from the clock and changes smoothly as it moves, and keeps its high, soft light under a closed deck. 372 unit tests.
- **Checked in the browser:** a time trial at night with the day running: stars over the circuit, the headlights on, the clock on the HUD; the city continued at 23:12: the lamps, the windows, the headlights and the clock.
- **Honest limits:** the moon is always full and never lights the ground (moonlight still comes from the sun's side); the stars don't turn with the hours; the circuits have no floodlights, so a night race is headlights only; replays play in the light of the finish.

### Push 26: Weather that moves (v0.26.0)
- **The sky moves** (`src/sim/weather.ts`, `MovingWeather`): every 150–330 s of simulated time the weather steps one rung along the ladder clear · cloudy · overcast · light rain · heavy rain (down more often once it rains, turning back at the ends), the change coming in over 45 s; seeded, so a replayed session sees the same sky. The road's grip follows (`surface.gripScale` each step) and so does the AI's pace (`paceScale` = the arcade band × the square root of the grip over the grip their lines were planned for), in races as in free roam. The snapshot carries the change (`SnapshotMessage.weather`: from, to, blend); a `weather` command starts a change at once (the checks use it through `__apex.weatherTo`).
- **The look between weathers** (`sceneLook`'s `mix`): every setting of the weather style (cover, gloom, clouds, haze, fog distances, rain) is blended between the two weathers, and the wetness with them; the closed-deck factor (the soft light from the whole sky, the sun disc gone, the grey fog) now comes in over the last of the cover instead of switching at once, so nothing jumps as overcast arrives; the presets look exactly as before. `CityScene.setWeather` / `TrackScene.setWeather` take the mix each frame and re-render the reflections as the cloud changes.
- **Choices and words:** *Changing weather* (Off: as chosen / On: it moves every few minutes) with the conditions on every setup (on by default in free roam, off on the circuits); a toast as rain comes in and as it eases off; Continue keeps the weather the sky had reached.
- **Tests:** the ladder waits, steps one rung, blends over the transition and repeats for a seed; wetness, grip and pace follow the blend; a race world follows the sky with the road's grip and the rivals' pace, a fixed one stays, the proving ground never moves; the look arrives exactly at the next weather and never jumps on the way, and each preset's look is unchanged. 379 unit tests.
- **Checked in the browser:** downtown at midday: a change to light rain called in (the toast, the sky greying and the road darkening half way, then rain and fog), on to heavy rain (streaks, the TC lamp working on the wet road) and clearing again with its word.
- **Honest limits:** the change is the same everywhere at once (no front crossing the map); the rain has no sound of its own and the wipers don't exist; the AI's pace follows the grip but their lines don't move to the dry line; the police and the traffic don't slow for the rain.

### Push 27: Smashable street props (v0.27.0)
- **Street furniture to smash** (`src/content/city/props.ts`, `src/render/Props.ts`): in arcade free roam the map places, seeded, bins, bollards and crates along the pavements of the downtown streets and avenues, crates, bollards and fence panels on the port's quays and bins and fences on the suburbs' verges (one about every 22 m, clear of the junctions, fences at the back of the pavement running along the road, an even share of every area within a budget of 1100), with the festival cones on the junction corners as before. One instanced mesh per kind (five draw calls for the lot), flat-coloured shapes with an origin at the bottom.
- **Sent flying:** the car's footprint in its own frame knocks anything it reaches: the prop takes the car's speed (less for the heavier kinds: cone 1, bin 1.4, crate 1.8, bollard 2.2, fence 2.6), pops up, tumbles with a spin, bounces, comes to rest on its side and is back on its spot 7 s later; each kind scores its own skill points with its own label (CONE 25, BIN 40, BOLLARD 50, CRATE 60, FENCE 80) and its own knock (`MenuAudio.smash`: a thud with a plastic knock, a wooden crack or a metal clang, at most one every 80 ms). The proving ground keeps its cones as they were.
- **Tests:** the placements stand on the pavement band beside a ground road, clear of the junctions, within the budgets, the same every time, with crates on the quays and bins downtown; a bin driven through flies, lies knocked over and is back later, a fence beside the line is left alone. 382 unit tests.
- **Checked in the browser:** downtown in arcade: the bins and bollards along the avenue, a bin knocked flying for 40 skill points (+40 BIN on the skill panel).
- **Honest limits:** the props don't push back on the car and the traffic drives through them; pedestrians walk through them; they never break into pieces; the knock is one sound per material, not per prop.

### Push 28: The festival's ladder (v0.28.0)
- **Lifetime tallies** (`records.ts`: `FestivalProgress`, `loadProgress`, `saveProgress`, key `apex-gp.progress`): the skill points of every arcade drive are banked as they are scored (`Game.bankSkill`, the score's growth since the last bank), and every street-race win counts; kept with the roam spot (on pause, on quitting, every 15 s) and at once on a level.
- **The ladder** (`src/content/ladder.ts`): ten levels by lifetime points, Rookie (0), Newcomer (1,500), Street (4,000), Racer (8,000), Hotshot (14,000), Pro (22,000), Ace (32,000), Elite (45,000), Star (60,000) and Legend (80,000); `ladderStanding(points)` gives the level, its title, the points into it, those to the next and the share of the way.
- **In the drive and the menus:** the skill panel shows LV n · TITLE · points TO GO with a bar under the score (`SkillHud.setLadder`); a level climbed brings "Festival level n: Title" and the start jingle; the festival map's subtitle opens with the standing (level, title, points, wins) before the events done and the medals.
- **Tests:** the ladder climbs level by level with unique titles; any number of points finds its level, boundary and top included, and bad input is nothing; the tallies round-trip through storage, repair bad data and are nothing without storage. 385 unit tests.
- **Checked in the browser:** from 1,470 lifetime points, a bin smashed (+40) crossed 1,500: the word "Festival level 2: Newcomer", the panel's LV 2 · NEWCOMER · 2,490 TO GO, the tally kept in storage, and the map screen's "Level 2 Newcomer · 1,510 pts · 2 wins".
- **Honest limits:** the levels unlock nothing yet (titles only); sim drives score no skill points and so don't climb; there is no ladder screen of its own; the tallies live in this browser only.

### Push 29: Back on touch (v0.29.0)
- **A way back for the iPad:** every menu screen with a way back (Back, Exit on the results, Resume on the pause screen's Back) shows a ‹ Back button in its top right corner on touch screens (`hasTouch()`), and the footer's Back, Pause and Tabs prompts are buttons on every device. A tap sends the same menu event as the key or the pad button (`InputManager.tap` → the UI queue with the source `touch`), so it goes through the focus engine and the screen logic exactly as Esc does: pop, resume, or exit.
- **Tests:** a new browser test on a touch screen (`tests/e2e/touch-menus.spec.ts`): Start by tap, no Back on the main menu, Free Roam → the corner button back, Race → track → car → the footer's Back prompt back, then the corner button to the main menu, with no page errors.
- **The readout beside the pedals:** with the on-screen pedals in the right corner the gear-and-speed panel takes the left corner (`Hud.setBesideTouch`, `.hud.beside-touch`), the speed-limit sign on its right, so nothing sits under a thumb; the touch browser test taps into a screen again if a tap was lost mid-transition (CI's slow runner lost one).
- **Honest limits:** the corner button shows on any touch-capable device (a touch laptop included); the Confirm prompt is not a tap (the focused item is not always the one a finger means).

### Push 30: In the rain (v0.30.0)
- **The rain's sound** (`EngineAudio`): two more voices off the shared road noise, a patter on the roof and glass (a 2.6 kHz band, by the rainfall: `rainGain`) and the spray off a wet road (a 900 Hz lowpass, by the wetness and rising with speed to 30 m/s: `sprayGain`); the audio frame carries `rain` and `wet`, which the game takes from the moving weather's mix (or the conditions chosen: `rainfall`, `wetness`).
- **Traffic in the wet** (`Traffic.wet`, `wetPace`): the lane limits the traffic drives at fall by up to 18 % on a soaked road; the world sets the wetness from the weather chosen, and from the moving weather as it changes.
- **Moonlight** (`SceneLook.lightAzimuth`): the shadow-casting light swings round to the moon's side (opposite the sun's bearing, 25° up) as the night comes, so the faint night light and its shadows come from where the moon hangs; by day it is the sun's as before.
- **Tests:** the patter and the spray rise as they should and stay finite; the traffic's fastest car runs slower in heavy rain than in the dry, and moving weather wets the road as the rain comes in; the shadow light comes from the sun by day, the moon's side at night, and swings without a jump through twilight. 388 unit tests.
- **Honest limits:** the rain is heard the same in every camera (no cockpit muffling); the spray has no visual on the player's own car beyond the circuits' plumes; the police don't slow in the wet.

### Push 31: Elimination races (v0.31.0)
- **The race type** (`SessionSetup.raceType`, *Race type: Standard / Elimination* on the quick-race setup; `SessionConfig.elimination` in seconds, 20): from lights out the director's clock runs down and at zero the last car still running is out (`RaceDirector.eliminate`: finished where it stands, `eliminated`, ranked below every other car by when it went, the last out highest); when one car is left it has won and the race is over; the player put out ends their race as a finish does (the results after the cool-down). Restart resets the clock and the cars.
- **Into the pits** (`Car.retired`, `FLAG_RETIRED`): a car put out stops where it is and the world leaves it be: no driver, no physics step, no contacts with it (`resolveCarContacts` skips it); the car view hides it while the flag is up and brings it back on a restart; the other cars' engine voices leave it out.
- **On the HUD and the results:** under the lap, OUT IN n counts down to the next car out, and LAST · OUT IN n pulses red when the player is the one on the way out (`RaceHud.updateElimination`); the results table marks the cars put out OUT (`ResultRow.out`).
- **Tests:** four cars with a 6 s clock: the first out after six seconds of racing, in last place, standing still and unseen from then on, the second out ranked above the first, the third leaving a winner in first place with the race finished; the snapshot carries the retired flag and a restart clears it; a standard race puts nobody out. 391 unit tests.
- **Honest limits:** the clock is fixed at 20 s (no choice yet); a car put out vanishes rather than pulling into a pit lane; the race radio says nothing about it; championship rounds are standard races.

### Push 32: Getaways (v0.32.0)
- **The event** (`EventKind` 'getaway', `FestivalEvent.heat`): three lines on the roads, Downtown Getaway (3 stars, par 45 s) on the central avenue, Port Getaway (4 stars, 55 s) on Dock Road and Ridge Getaway (5 stars, 70 s) on the ridge; a red-bannered gantry marks each (`FestivalScene`), the map lists them as Getaway with a purple marker and fast-travels to them, the event HUD names them GETAWAY.
- **The rules** (`Festival.updateGetaway`): crossing the line starts it and asks the simulation for the pursuit (`startPursuit` callback → the `pursuit` command → `Police.startPursuit(heat)`: the stars, the fine and the state set at once, the units heading for where the player was last seen); the clock runs from the line; from the first sight of the pursuit an escape ends it with the time (a medal against par, kept as a best when lower) and a bust ends it with nothing; police that never come let it lapse after six seconds. The festival takes the police status with each update; an arcade escape with a medal is 800 skill points.
- **Tests:** the events include getaways with stars and par; a getaway starts on its line with its stars, shows Here they come and then the stars to lose, records the escape time with a gold at 30 s, takes a bust with no record, and lapses without police; the police module starts a pursuit at the stars asked (clamped to five), with the units chasing, from a standing start. 393 unit tests.
- **Also:** an escape's time comes up on the race card (with no field to list) as a race's result does; the police's pursuit cap follows the wet road too (the limit-based term of it, so they still keep pace with the player).
- **Honest limits:** a getaway's difficulty is the pursuit's (no extra units or a helicopter called in beyond the stars); the line can be crossed again straight after an escape.

### Push 33: The festival board (v0.33.0)
- **The screen** (`BoardScreen`, screen id `board`): from the Free Roam setup (*Festival board*) and the pause menu in a drive, the festival at a glance: the ladder bar with the level, the title, the points and the wins, the points to the next level, how many events have a result and the medals, then every event under its kind (Races, Getaways, Drift zones, Speed traps, Jumps) with its best and its medal, gold, silver and bronze in their colours. In a drive the rows are buttons: pick one and you fast-travel to it, as from the map.
- **The data** (`FestivalDestination.medal`, `Game.festivalInfo`): each destination carries its medal (from `medalFor` against its par); the festival's info is set as the game boots, on every session start and on the quit to the menu, so the board reads right from the setup as well as from a drive.
- **Touch:** the touch walk-through opens the board from the roam setup and comes back with the corner Back button. That test's timeout is now 240 s: the menus render their 3D backdrop at a frame or two a second in software GL and every tap waits for a couple of frames, so nine screens take a while on CI.
- **Honest limits:** the board lists the bests only (no times per medal to aim for); nothing sorts the rows beyond their kind.

### Push 34: Qualifying (v0.34.0)
- **The option** (`SessionSetup.qualifying`, *Qualifying: None / 1 lap / 2 laps / 3 laps* on the race setup, the start position put away when it is on): the session starts as a qualifying instead of the race: the whole field off the grid at the lights, every car running its own laps (the leader taking the flag flags nobody else), the positions by best lap (`RaceDirector` with `qualifying`, `status.qualifying`; cars without a lap below the rest by progress), no eliminations, and the session over when everyone is in or 20 s after the player. The HUD reads QUALIFYING · LAP n/N and P n ON THE GRID at the end; the engineer's radio check and sign-off say so too; the flyover card names it.
- **The grid** (`SessionConfig.gridOrder`, `RaceDirector.restart(cars, slot, gridOrder)`, `World.gridOrder` for restarts): the results card *Qualifying* lists the grid with each best lap's gap to pole, and *Start the race* runs the race on it with the same seed, cars and liveries (`RaceCarry` in `Game`: the field and the grid carried over; a restart of that race keeps the grid, a restart of the qualifying runs it again). Championship rounds run a qualifying first when the season's setup has one; the points come from the race.
- **Tests:** three cars over two laps with the quickest held 20 s after the lights: last home, best lap, pole, where the same drive is last in a race; the grid given to a restart is the order on the grid; a car lapped in a race is flagged with the leader but runs its own laps in a qualifying (cars walked along the track by hand); a session from a config with qualifying laps and an elimination runs the laps with nobody put out, and a race from a grid order keeps it across a restart. 397 unit tests.
- **Honest limits:** the whole field starts together off the grid (no out-laps, no traffic management); the AI cars' first laps are standing-start laps like the player's; no separate qualifying tyres or fuel.

### Push 35: Drift trial (v0.35.0)
- **The mode** (a *Drift Trial* tile on the main menu; `SessionSetup.trial` 'drift', `driftLaps` 1–3; `SessionConfig.drift`): a circuit and a car, arcade handling whatever the setting (the handling choice makes way for a note), 1 to 3 laps alone on the track, and the drifts score: the arcade skill system's drift points (`Skill.driftScore`, the drifts' share of the score; speed and air points still chain the multiplier but don't count) shown as DRIFT on the skill panel. The director's lap count shows in a time trial when set (LAP n/N), FINISH flashes at the last line, the last drift has three seconds to bank, then the results. No ghost, no track records from arcade laps.
- **Medals and bests** (`content/driftTrial.ts`: `driftTargets(trackLength, laps)` at 1400 / 800 / 400 drift points per kilometre of lap for gold / silver / bronze, rounded to 50; `driftMedal`; `apex-gp.drift` records keyed by circuit and laps): the results card shows the score with its medal, the best (New best! when beaten) and the three targets; *Go again* runs it again.
- **Tests:** the drifts' points stay apart from the rest of the score; the targets scale with the lap and the laps and hand out the medals; a drift trial session is a time trial with the laps on the clock and nobody else on the track (a plain time trial has none). 400 unit tests.
- **Honest limits:** the medal targets are a first guess from the scoring's numbers, to tune from play; the score is the drift points alone (near misses have no traffic to come from, speed and air only feed the chain); no leaderboard beyond this browser.
