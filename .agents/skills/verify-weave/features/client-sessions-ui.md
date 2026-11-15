# Client habitat UI

The client is the Kreisel habitat: one WebGPU tank, one school of three
server-derived jelly species, one shared RPC subscription. A session is an animal, keyed by source plus
session id. Roots are larger than their own children. The page has no session
list, dashboard or navigation at rest. A small top-left HUD keeps the FPS
readout and a source disclosure icon. A persistent status notice appears only
when the browser stream is lost or a source is retrying or unavailable. Hover or
focus shows a bare
title; deliberate selection opens one fixed-width specimen placard. Its desktop
window renders the selected animal through an isolated specimen camera.
A debug query expands the readout with SPS and mean frame interval.

This feature is a browser smoke over the same controlled feed. It proves the
real feed becomes one animal per unarchived session, a live status change
updates the same animal without resetting the school, a replacement feed
departs only absent keys, the built preview mounts the habitat, the FPS
readout uses a closed wall-clock sample and detailed stats require a debug query,
one development page checks actual App WebGPU teardown,
and upstream recovery keeps the last school without a transport notice.

## Sub-features

- `live` opens the development page, proves the empty tank is quiet, and
  renders the real fixture as seven animals with seven hidden session controls.
- `jelly-variants` starts the `--variant-sources` fake, which serves local, iu,
  and mj from one root and one child each. It checks six animals, 29 meshes, the
  iu bodies in the fried-egg bucket and the mj bodies in the white-spotted
  bucket, that the board capture has lit pixels rather than a black frame, and
  the renderer backend on WebGPU. It captures the board and one specimen per
  species.
- `drawer` selects a real child, checks its source, basename, status, and
  focus-only path tooltip, and copies its exact context through the native title
  button. Its Parent button selects the immediate known parent by click, Enter,
  or Space. Roots and sessions without a known parent omit the row.
  The fixed mobile sheet preserves the canvas and camera, and closes
  with Escape or an outside tap. Shared near-black and stone theme tokens
  provide at least 4.5:1 text contrast.
- `specimen` checks one nonmodal 340px placard at 1280, 1440, and 1920 desktop
  widths and a DPR change. The isolated close-up is compared with the board using
  downsampled appearance and pose, not identical pixels. It checks motion,
  another real ray-hit selection, offscreen and behind-camera hiding, removed
  selection, empty and long titles, and target release on close.
- `debug` proves sampled FPS is visible by default. `?debug=1` adds SPS
  and mean frame interval; removing the query returns to FPS only.
- `update` changes the fixture from `idle` to `running` and proves the
  same animal reports `running` while the creature count stays flat.
- `interaction` uses real ray hits to check keyboard preview priority,
  pointer fallback after blur, immediate leave dismissal, throttled pointer moves,
  immediate click picking, and retained preview after drawer close.
- `palette-family-selection` captures cyan, blue, violet, and mint at identical
  animal poses. It retains typed question and permission controls, selected and
  immediate-parent instance emphasis, session selection, and clearing both marks
  on close. The approved UI has no family tree or disclosure controls.
- `crowded-family` keeps all 700 fixture animals and one fixed-width
  placard without family rows. Mobile selection does not move the canvas or
  camera. Selected and closed 240-frame WebGPU samples check board and specimen
  OIT passes, resolves, the selected overlay, and one instance sync per frame,
  with flat selected engine resource counters.
- `reduced-palette` proves reduced motion keeps the palette stationary.
- `lifecycle` removes one child, observes one departing animal, waits for
  it to be gone, returns it, and proves the retained identities keep their pose.
- `preview` serves the built client from Vite preview. It proves built
  assets, no Vite client, no dev inspection hook, and a mounted canvas. It also
  proves the debug counter works in the built client without the dev hook.
- `webgpu-required` disables GPU access and requires the visible
  renderer-unavailable notice, without a WebGL fallback.
- `webgpu-init-failed` rejects GPU adapter initialization and requires the same
  visible failure without a stale development scene.
- `scene` mounts the actual App, checks WebGPU rendering, CSS resize and
  model retention, then unmounts it three times. Native device destruction,
  stopped render calls, removed canvases, zeroed engine resources, and one shared
  RPC POST are the teardown assertions.
- `disconnect` ends the upstream stream and proves the last school stays
  on screen while source health reconnects, without a transport notice.
- `source-controls` proves the top-left HUD: FPS, one source disclosure, and a
  persistent noninteractive notice. It checks source order, the terminal
  unavailable precedence over a retrying sibling, amber and red aggregate glyphs,
  row-only accessible status names, the shared 16px gutter and 24px inner edge,
  popover alignment, hover, focus, pin, Escape and outside dismissal. At
  390x844 it checks the notice and popover clear the 47svh sheet. A lost RPC
  stream removes the stale trigger, popover and rows, leaving
  "Disconnected. Refresh the page." in `role="status"`.

## How to get to it (user POV)

- Run `bun run dev:mock`. It starts a controlled OpenCode fake, the real Weave
  server, and the Vite client, then prints one `DEV_READY` JSON line with the
  UI, control, RPC, and fake URLs.
- Open the UI URL. The empty feed is a quiet empty tank.
- Add `?debug=1` or `?debug=sps` to the same URL to show the compact
  `SPS 60 · FPS 58 · 16.7 ms` counter instead of the FPS-only readout. No other
  part of the UI changes. The FPS-only HUD is visible by default.
- Switch fixtures through the control URL:
  `curl -X POST <control>/case/current`.
- Hover an animal for its title; click to open its placard. Tab reaches the hidden
  session controls; focus reveals the title and Enter opens the drawer. Click
  the title to copy context. Hover or focus the folder to reveal its full path.
  Escape or a click on empty water closes the placard and restores focus. Click
  another animal to update the same placard. On desktop, a faint leader connects
  the fixed crop to the selected animal. Mobile retains the fixed bottom sheet
  without introducing a magnifier layout.
  Click **Parent &lt;title&gt;** below the folder and status to inspect the immediate
  known parent. Tab reaches the same button for Enter or Space activation.
  The selected animal and specimen change without moving the camera.
  Escape still restores the control that originally opened the placard.
- Water cycles through cyan, royal blue, violet, and pale mint over 160 seconds.
  Reduced motion freezes its palette. Running sessions have a cool internal glow.
  Questions glow amber and permissions glow coral. Selection adds an edge glow
  independently, with a quieter mark on the immediate known parent.
- The helper uses the `current`, `idle`, `running`, `delete`, and `disconnect`
  cases. The runner starts on the `empty` fixture, which is the natural first
  page load.
- Read `<control>/state` for the active case, fixture sessions, active ids, and
  owned URLs.
- Open `/test/harness/scene.html` on the same dev URL for the actual App lifecycle
  page. That page exists only under Vite development.
- On `disconnect`, the tank keeps its last animals while the backend reconnects.
- Run `bun run dev:mock --source-health` for four ordered source fixtures. Wait
  for the offline source to exhaust its retries, then apply `source-health` through
  the control URL. The top-left source icon is red because any unavailable source
  wins, and its notice names the down source. Hover the icon or Tab to it for the
  list of connected, connecting, reconnecting, and unavailable sources.
  Click, tap, Enter, or Space pins the list.
  Escape or a click outside dismisses them. `sources-recovered` releases both blocked
  seeds. The browser smoke aborts its live RPC request to hide the stale source
  disclosure and show "Disconnected. Refresh the page."

## Driving it with verify-weave

Preconditions:

- Run from the worktree under test after `bun install --frozen-lockfile`.
- Google Chrome is installed at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- Choose an absolute run directory outside the repository. The helper creates it
  if needed.
- The helper owns its `dev:mock` runner, its Chrome profile, and every port
  those processes use. Do not reuse a preview or runner that the helper did not
  start.

```sh
RUN=$(mktemp -d "$TMPDIR/weave-client-ui.XXXXXX")
bun .agents/skills/verify-weave/harness/client-ui.ts --worktree "$PWD" --run "$RUN"
```

`--only` accepts the exact scenario names listed above, separated by commas.
Use `--only live,drawer` for a focused placard run: `live` loads the seven-animal
fixture that `drawer` expects. Filtered evidence proves only its listed scenarios.

The helper starts one `bun run dev:mock`, waits for `DEV_READY`, drives one
headless Chrome page through a fixture sequence, the built preview, and the
dev-only scene probe, then stops its runner, browser, and preview on success and
on failure. It checks the owned ports are closed and the evidence is still
readable.

- **Live.** The runner starts empty, so the first page load proves the empty
  tank has no caption, drawer, or notice, and one healthy source disclosure
  remains. The `current` case then renders seven animals on the live GPU backend
  with draw calls and triangles and seven hidden session labels.
- **Debug.** The helper reopens the development page with `?debug=1` and waits
  for one closed sample in the form `SPS <n> · FPS <n> · <n.n> ms`. It then
  reopens the page without the query and proves only sampled FPS remains. The unit
  test for `CycleMeter` fixes the arithmetic: simulation steps and rendered
  frames are separate counts over the same wall-clock window.
- **Update.** The helper applies the `idle` case, then `running`, and waits for
  the same `local:ses_payments_trace` animal to report `running`. The creature
  count stays the same, so the update did not reset the school.
- **Drawer.** The helper selects `Trace slow card auth` and observes its actual
  `local` source. It checks the folder basename, hidden full path,
  focus tooltip, and running icon. At 390x844 it compares canvas bounds, drawing
  buffer, and both camera matrices before opening, after opening, and after title
  copy. Enter writes the exact available context to the real clipboard once.
  Repeating a copy restarts the toast timeout, and the replacement message
  dismisses after its own interval. A denied clipboard write shows a failure toast. The toast
  leaves title and panel bounds unchanged. Escape restores focus. An outside
  desktop click or mobile tap closes the placard. The sheet fits the viewport
  without horizontal overflow.
  Native pointer and Enter activation follow Collect changelog to Draft changes,
  then Release notes. The root has no Parent row. Native Space activation follows
  Trace slow card auth to Checkout regression on mobile without changing the
  canvas or camera. Each hop retains the dialog and focuses it. Escape restores
  the original opener after either journey.
- **Lifecycle.** The helper applies `delete` and observes one departing animal,
  then six animals and no departing animal. It applies `current` again and
  proves seven present animals, at least five retained keys within 0.6 world
  units of their old pose, and one returned key as a single body. Two more
  departure and return cycles leave renderer memory counts, capacity and mesh
  count unchanged.
- **Palette and family.** The `attention` fixture supplies a real permission
  request and a valid question form through the upstream boundary. The helper
  selects the grandchild and checks the two emphasized instances and distinct
  typed state controls. It freezes the development
  scene, advances only its existing light clock, and captures four palettes
  without changing any animal pose or renderer resource count. Selecting the
  root through its session control clears the old marks and emphasizes
  only that root. Closing clears every emphasis value.
- **Preview.** The helper builds once into its run directory, starts `bun run preview`
  against the same controlled server, and opens it. The built page has a
  mounted canvas, built assets rather than the Vite HMR client, and no dev
  inspection hook. With `?debug=1` the built page shows the same counter and
  still exposes no dev hook. The helper stops only its own preview process.
- **Scene.** The helper opens `/test/harness/scene.html` and checks actual App
  WebGPU rendering, a CSS resize to 448 pixels, and a feed update that retains
  the scene and device. Three unmounts remove the canvases, stop rendering, dispose
  geometry and materials, reset engine resources, and destroy every owned StrictMode GPU device. One RPC POST
  stays alive through the persistent feed consumer.
- **Disconnect.** The `disconnect` case ends the current upstream event stream.
  A typed watcher observes reconnecting and connected health. The browser keeps
  seven animals with no transport notice after recovery.
- **Source controls.** A second owned runner uses `--source-health` with real
  authenticated upstream fixtures. Two blocked list responses hold connecting
  and reconnecting health. A 401 fixture exhausts retries to become unavailable.
  The browser checks one top-left disclosure, source order, the red aggregate that
  wins over a retrying sibling, one persistent noninteractive notice, the shared
  16px HUD gutter and 24px inner edge, popover alignment, source-name-only popup
  text, hover and keyboard previews, native dismissal, and the touch target at
  390x844. It also checks the notice and popover clear the 47svh mobile sheet.
  Releasing the seeds updates pinned glyphs without adding status text. Aborting
  the browser's live RPC request removes the stale source trigger and rows and
  leaves only "Disconnected. Refresh the page." in `role="status"`.
  Evidence is in `source-controls.json` and `source-*.png` screenshots.
- **Proof.** Use `manifest.json`, `checks.json`, `dev-mock-*.log`,
  `dev-mock.json`, `cleanup.json`, and `post-cleanup.json`, plus the
  `current-desktop.png`, `debug-counter.png`, `one-departed.png`,
  `returned.png`, `drawer-desktop.png`, `drawer-mobile-closed.png`,
  `drawer-mobile-copy.png`, `drawer-mobile-tooltip.png`, `drawer-landscape.png`,
  `preview-desktop.png`, `preview-debug.png`, and
  `disconnect-desktop.png` screenshots. The manifest
  records the commit SHA plus `sourceDirty` and `sourceFiles` when the worktree
  has uncommitted changes, so an interim run does not read as a committed-SHA
  proof.
  The palette scenario adds `palette-cyan.png`, `palette-blue.png`,
  `palette-violet.png`, `palette-mint.png`, and `palette-samples.json`.
  The specimen scenario adds `specimen-desktop-<width>-<dpr>.png`,
  `specimen-closeup.png`, `specimen-long-context.png`, `specimen-appearance.json`,
  `specimen-desktops.json`, `specimen-work.json`, and `specimen-reopens.json`. The
  source scenario adds `source-states-desktop.png`, `source-hover-desktop.png`,
  `source-tap-mobile.png`, `source-sheet-mobile.png`,
  `source-transport-mobile.png`, and `source-controls.json`. The crowded sample
  records both selected and closed results in `crowded-frame-sample.json`.
  The drawer scenario adds `parent-child.png`, `parent-selected.png`, and
  `parent-navigation.json`.

## Gotchas

- The owned Chrome profile treats only its fixture UI origin as secure so the
  clipboard API works on the runner's HTTP Tailscale address. Focus emulation
  makes headless `:focus` match a focused browser window. Native Enter dispatch
  includes the carriage-return text, and Escape includes its virtual key code.

- `dev:mock` binds Vite to `WEAVE_DEV_HOST` when set, otherwise to the Tailscale
  IPv4 address when `tailscale ip -4` returns one, and to `127.0.0.1` otherwise.
  The client helper sets `WEAVE_DEV_HOST=127.0.0.1` so its temporary runner never
  listens on the tailnet. Read the URL from `DEV_READY`; do not assume port 5173.
- The runner uses ephemeral ports for Vite, control, server, and fake. Never
  point it at a user preview, OpenCode, or Tailscale listener.
- Case changes are serial. Each session-changing case resets the fixture with
  real delete and create events before it applies its own events. A single
  replacement feed is reconciled by identity, so a reset that returns every key
  cancels the in-progress departure instead of rebuilding the school.
- `disconnect` ends the fake's current SSE stream, not the fake process. The
  backend reconnects automatically. Its source icon updates independently of the
  browser transport notice.
- The main runner stays on one source instance. The source-controls scenario owns
  a separate four-source runner and stops all of its ports after the scenario.
- The habitat exposes `window.__weaveHabitat` only under Vite development. The
  harness reads animal counts, poses, the backend, and draw calls from it. The
  production preview must not expose it, and the helper asserts that.
- The habitat prepares the initial feed's normal and specimen rendering paths
  before starting its animation loop. An empty initial feed is valid. Closing
  releases the specimen target textures but retains its pipeline until unmount.
  Three reopens must restore the same texture counts. A closed frame submits the
  board default and OIT accumulation passes plus its resolve. Selection adds
  specimen default/accumulation passes, its resolve, and the aperture overlay.
  Later feed changes can introduce material or geometry variants that were not
  present during preparation.
- The FPS readout refreshes every 500 ms. Detailed stats are query-gated, not
  environment-gated. The detailed counter works in the
  production build and shows only SPS, FPS, and mean frame interval from the
  last closed wall-clock sample. SPS counts completed fixed steps, so it can
  stay near 60 while FPS falls when rendering is the bottleneck; it does not
  measure GPU memory and cannot prove or disprove a leak.
- The page owns one `watchSessions` atom subscription. `Atom.keepAlive` keeps it
  alive after the last consumer unmounts, so the page issues one RPC POST and
  later mounts reuse it. The ROOT backend source connection stays on for the
  process lifetime. The renderer never opens a second RPC or SDK subscription.
- The lifecycle page uses the actual App and renderer. Native device destruction
  is not a driver-memory measurement or a long-run leak test. The page does not
  establish visual acceptance.
- The helper kills only the processes it started. Leave an intentionally
  running preview alone.
