# Three.js validation reference

Status: partial. The production client now renders the Kreisel habitat with
`three/webgpu` from the existing `three` dependency. The
[client habitat UI](../features/client-sessions-ui.md) smoke proves the real
feed becomes animals on a live GPU backend, with draw calls and triangles. A
development page at `/test/harness/scene.html` mounts the actual `App` under
StrictMode and the same `RegistryProvider` as the application entry point.

Read the installed Three.js API and release notes before applying examples
written for another version.

The frontend consumes the typed `Group` contract in `src/shared/rpc.ts`.
It does not interpret upstream OpenCode events or add a product RPC for test
control. Validation drives the browser against controlled RPC fixtures.

The test page adds a mount button and a persistent feed consumer. Production
code has no test-only lifecycle export or alternative renderer.

## Size the canvas in CSS

The caller sizes the canvas with CSS. The hook reads `clientWidth` and
`clientHeight` and calls `renderer.setSize(width, height, false)`, which sets the
drawing buffer and never writes CSS. A canvas with zero CSS size renders
nothing, and the hook has no fallback size.

## What the dev probe proves

- The actual habitat reports WebGPU and completed render calls.
- One CSS resize from 640 to 448 pixels resizes the drawing buffer to match.
- A new `SessionFeed` updates animals without replacing the scene or allocating
  another GPU device.
- Three App unmounts remove the canvas and development reference, stop render
  calls and the animation loop, dispose scene geometry and materials, and reset
  engine resource counts.
- Every device created by three StrictMode mounts receives exactly one native
  `destroy()` call and resolve `device.lost` with reason `destroyed`.
- One `POST /rpc` stays alive across those mounts through the page's feed consumer.

The run enables WebGPU in headless Chrome and permits a SwiftShader fallback.
The lifecycle check proves actual habitat teardown, not driver-memory recovery,
responsive layout, accessibility, pixel comparison, or visual acceptance.

## Interaction and specimen coverage

The habitat smoke now verifies one mobile overlay invariant at 390x844:
placard open, title focus, and clipboard confirmation leave the canvas bounds,
drawing buffer, and camera matrices unchanged. It also checks Escape focus
return and outside close. This is bounded interaction coverage, not complete
responsive or accessibility acceptance. Real pointer ray hits and keyboard
focus are exercised by `interaction`; `scene` checks camera aspect after CSS
resize, and `specimen` changes DPR without changing CSS size. The specimen
camera renders independently, so its downsampled appearance and pose are compared
with the board rather than requiring identical pixels.

## Still unverified

- Shader, lighting, material, and density acceptance for the production scene,
  and a pixel-level comparison against the approved Kreisel.
- Supersampling and an accepted performance baseline on a named device, browser,
  viewport, pixel ratio, and rendering protocol. One five-minute live-feed run
  on 11 November 2026 measured SPS and FPS at 60 with flat three.js resource
  counts, but it is single-machine evidence, not an accepted baseline.
- A frame-level WebGPU capture. A WebGPU canvas has no `drawingBufferWidth` or
  `drawingBufferHeight`; the habitat smoke reads backend, draw calls, triangles,
  animal counts and poses from the live renderer instead.

## Limits

A canvas element in the page is not proof of rendering. The probe reads draw
calls and buffer dimensions from the live renderer, so it fails when the context
or frame loop is missing. Controlled fixtures, frozen poses, and captured frames
provide bounded regression checks, not approved visual baselines. Driver-memory
recovery and long-run performance still require measurements outside this smoke.
