---
name: verify-weave
description: "Drive the real Weave session-watch RPC server against a controlled OpenCode HTTP/SSE fake, then prove snapshot, live update, lifecycle, RPC error, and client habitat smoke with direct typed client and browser artifacts. Use when verifying Weave serve or client behavior, before shipping a Weave RPC change, or when asked to run the Weave verification map."
---

# Verify Weave

Weave is a read-only bridge over OpenCode sessions. `bun run serve` exposes an NDJSON watch at `POST /rpc`; the React client subscribes to it. Each `SessionFeed` contains ordered source groups. Each source owns its SSE, seeded projection, and retry budget for the process lifetime, including periods with zero viewers. The single-source fixtures use group id `local`. This skill drives the real server through the native client built from `Group` in `src/shared/rpc.ts`, with a fake only at OpenCode's HTTP and event-SSE boundary. The client feature uses `bun run dev:mock` to own that fake, real server, and Vite client.

Read `features/README.md` first. Use one feature file as the recipe for the behavior you need to prove. The commands below use the legacy single `local` source. For explicit multi-source configuration and isolation, also run [Multiple sources](features/multi-source.md).

## Launch

Run from the worktree at the SHA under test, after `bun install --frozen-lockfile`.

```sh
bun run verify launch --worktree "$PWD"
```

Launch prints `LAUNCHED run=<absolute path>`. Copy that path into `RUN` and reuse it for every later command.

```sh
RUN=<absolute path from LAUNCHED>
bun run verify doctor --run "$RUN"
```

The default run directory is a unique timestamp-and-process-id child of the native OS temp directory, under `opencode/weave-verify`. Pass `--run <abs>` to choose a known location.

Launch starts `harness/session.ts`. That process starts the controlled OpenCode fake, starts the real `bun run serve` subprocess with `WEAVE_PORT=0`, reads the actual ephemeral port from the server's `Listening on http://127.0.0.1:<port>` log line, waits for the server's one source SSE plus its paginated list and active reads with zero frontends, and writes `state.json`. Launch returns only after that source seed is complete. It does not claim the RPC surface is usable; run doctor for that.

Never point the harness at an existing user Weave, OpenCode, or Tailscale listener. The harness owns its fake, server, supervisor, and ports. It uses no default listener ports.

## Doctor

```sh
bun run verify doctor --run "$RUN"
```

Doctor is read-only. It checks:

- the supervisor and server PIDs are alive;
- the actual listener PID belongs to the owned server process tree;
- the server log names the actual ephemeral port;
- the worktree SHA still matches `state.json`, and the worktree is clean;
- exactly one source connection is open, with cumulative connections at least the startup count;
- a native typed RPC client decodes one connected `local` source group within 10 seconds, proving current source health, accepted upstream auth, and the wire schema;
- the typed watch adds no source connection, list, or active request.

It writes `doctor.json` and exits non-zero on any failed check. Doctor checks live health, so you can re-run it after a fixture change. Run it before a feature, and again after any surprising result. On an uncommitted worktree, `worktree-clean` fails by design; that is interim evidence and not a clean-SHA proof.

The snapshot `startup` scenario owns the one-time startup proof before any fixture change: one source SSE, three paginated `/api/session` reads with `archived=false` and no `parentID`, one active read, no per-session or pending read, and the 502-session startup feed with the child running and zero attention.

## Client UI

The client feature starts its own runner and browser. It does not use the run directory from `launch`.

```sh
RUN=$(mktemp -d "$TMPDIR/weave-client-ui.XXXXXX")
bun .agents/skills/verify-weave/harness/client-ui.ts --worktree "$PWD" --run "$RUN"
```

The React client is the Kreisel habitat, so this is a habitat RPC smoke, not UI
acceptance. The helper starts `bun run dev:mock`, reads its `DEV_READY` URLs, and
drives headless Chrome through live feed updates, departures, returns, specimen
selection, a built preview, actual App teardown, and source recovery.
Preview builds stay inside the run directory. Animal counts and poses come from
the development inspection hook, which the built preview must not expose.

The page at `/test/harness/scene.html` mounts the actual `App` under StrictMode
and `RegistryProvider`. The browser checks WebGPU rendering, CSS resize, model
retention, and three mount/unmount cycles. It observes native GPU device
destruction, disposal events, zeroed engine resources, removed canvases, and
stopped rendering. One RPC POST remains alive through a persistent feed consumer.
This is not a driver-memory measurement or a long-run leak test.

The helper stops only processes it started, on success and failure. It uses
`WEAVE_CHROME_PATH` when set, otherwise the macOS Chrome bundle or
`/usr/bin/chromium`. Do not point it at an existing preview, runner, OpenCode,
or Tailscale listener.

The client smoke also checks the session placard's typed context, native title
copy, folder tooltip, Escape focus return, outside close, and fixed mobile
overlay. At 390x844, opening and copying must leave canvas bounds, drawing
buffer, and camera matrices identical. Preview builds stay inside the run
directory so verification never overwrites a running production bundle.

The `specimen` scenario checks an isolated specimen pass on WebGPU, desktop
widths of 1280, 1440, and 1920, DPR changes, the target matching the aperture's
device pixels, downsampled appearance and pose against the same board frame,
continuous phase motion across a bucket boundary, live motion, selection
replacement, offscreen hiding, removal, and closed-state render work.

`--only` accepts comma-separated scenario names. A filtered run proves only the
scenarios listed in its manifest. Use a fresh run directory for each invocation.
Set `WEAVE_CHROME_PATH` when the Chrome executable is not at the macOS default
or `/usr/bin/chromium`.

## Drive

One feature run uses the long-lived instance from launch. Feature runs are serial because each resets the shared fixture with real events.

```sh
bun run verify feature snapshot --run "$RUN"
bun run verify feature live-updates-attention --run "$RUN"
bun run verify feature lifecycle --run "$RUN"
bun run verify feature rpc-errors --run "$RUN"
```

The client UI command above is a separate feature run. It starts and stops its own runner.

`rpc-errors` runs last. It proves recovery, then exhausts ten retries with failing snapshot reads and stops the fake upstream. Current and later watches retain sessions and unavailable health. Allow about three minutes for the real backoff delays. A failed feature writes evidence and stops only its owned processes.

To run the whole lifecycle without separate commands:

```sh
bun run verify all --worktree "$PWD"
```

`all` launches a fresh instance, runs doctor, drives the four server features in order, runs cleanup, and writes the final manifest. It does not start the client runner. Pass `--run <abs>` to keep the evidence at a known location.

## Evidence

Every run writes under `$RUN`:

- `manifest.json`: code SHA, worktree, commands, feature results, final result.
- `doctor.json`: readiness checks.
- `checks.json`: every behavioral check, with feature and scenario.
- `frames.jsonl`: actual typed client feeds, with feature, scenario, client, and time.
- `requests.jsonl`: actual upstream HTTP requests observed at the fake boundary. Authorization values are reduced to `basic` or `none`.
- `raw.frames.jsonl`: raw NDJSON status, content type, and response frames for each direct protocol probe.
- `direct/*.json`: direct typed client results and failed subprocess results, one file per scenario.
- `scenarios/*.json`: one result per scenario, including its checks and request paths.
- `server.stdout.log`, `server.stderr.log`, `supervisor.json`: process logs and shutdown state.
- `cleanup.json`, `post-cleanup.json`: teardown checks and a post-teardown readability check of the evidence.

A client UI run writes `manifest.json`, `checks.json`, `screenshots/*.png`,
`dev-mock-*.log`, `dev-mock.json`, `cleanup.json`, and `post-cleanup.json` under
its own run directory. Pass means the browser observed the real feed, one
idle-to-running update, the built preview, actual App WebGPU teardown, and the
source recovery, not only that the page loaded.

Pass means a behavioral check observed the result on the real server or the real typed client. A feed is complete, so a removed session is proved by absence from the latest feed. Do not replace a failed journey with a helper-level assertion. Mocks exist only at the OpenCode public HTTP and event-SSE boundary. The process keeps temporary in-memory projections; there is no database, replay log, polling loop, startup request scan, cursor resume token, or pending-request hydration.

## Cleanup

```sh
bun run verify cleanup --run "$RUN"
```

Cleanup sends SIGTERM to the owned server and records its exit code, listener state, cumulative source connections, and open source connections. It accepts the native Bun exit 0 or 130 and requires no open source connection and no connection added during shutdown. When `rpc-errors` already closed the source, this observes the absence, not a SIGTERM cause; the unit test owns the Effect SSE scope closure. It then stops the supervisor and fake, checks the owned PIDs and both ports are gone, and writes `cleanup.json`. Finally it verifies the evidence still exists and is readable, then writes `post-cleanup.json`.

Cleanup requires base launch/doctor logs and the scenario files named by recorded feature checks. Direct RPC result files are required only when `rpc-errors` ran. A launch/doctor/cleanup run with no features needs no RPC-error files. Any failed recorded feature or unreadable required file keeps the final result at `FAIL`.

Cleanup never deletes evidence. It never kills by process name or by broad port ownership. It kills only the supervisor PID, the server runner PID, and a listener PID recorded as the runner or listener in `state.json`.

## Feature map

- [Feature map](./features/README.md)
- [Snapshot](./features/snapshot.md)
- [Live updates and attention](./features/live-updates-attention.md)
- [Stream lifecycle](./features/lifecycle.md)
- [RPC and transport errors](./features/rpc-errors.md)
- [Multiple sources](./features/multi-source.md)
- [Client habitat UI (browser smoke)](./features/client-sessions-ui.md)

## Frontend references

[Frontend setup](./references/frontend-setup.md) records the rerunnable static,
development, and production-preview checks for the React shell. Live client
behavior belongs to the [client sessions UI](./features/client-sessions-ui.md)
feature.

[Three.js validation](./references/threejs-validation.md) records what the
dev-only scene probe covers and what a production 3D view still needs. Read it
before claiming a scene, shader, supersampling, or performance result.

## Helpers

All helpers live in this skill directory:

- `harness/verify.ts` is the command above.
- `harness/session.ts` owns the fake, the real `bun run serve` child, and the control server. It waits for the startup seed before reporting ready. Its `POST /sessions` reset emits child-first delete events and parent-first create events; `reset: false` writes the fixture without publishing an event for the next explicit public event.
- `harness/client.ts` imports the production `Group` and builds the native client with `RpcClient.make(Group)`, `RpcClient.layerProtocolHttp`, `RpcSerialization.layerNdjson`, and `FetchHttpClient.layer` inside `Effect.scoped`. Its watcher collects complete `SessionFeed` values.
- `harness/scenarios.ts` holds the four feature runners.
- `harness/support.ts` holds evidence, control, process, and port helpers.
- `harness/client-ui.ts` starts `bun run dev:mock`, drives headless Chrome through the habitat smoke with source recovery, and writes the client evidence.

The upstream fixture reuses `test/support/fake-opencode.ts` through an import. The fixture can change sessions, active ids, events, and stream lifetime through the control server. It has no Weave test endpoint. `FakeEvents.open()` reports the active SSE controller count; `connections()` stays cumulative.

## Limits

This is a controlled-boundary proof, not a real user integration. It uses an OpenCode fake at the external HTTP and SSE boundary. It does not install OpenCode, start a real OpenCode server, or send model or provider requests. The separate real OpenCode compatibility probe is not part of this skill or its feature map.

The client feature drives headless Chrome against its controlled runner and the
built preview of the same worktree, not a user's preview. Chrome enables WebGPU.
Checks cover identity, typed state, palette phases, isolated specimen appearance,
mobile overlay geometry, actual App teardown, and bounded selected and closed
700-animal submission samples. They do not establish visual acceptance, a
production performance comparison, driver-memory recovery, or a long-run GPU
leak result.

This skill does not claim CI coverage; the repository has no CI configured.
