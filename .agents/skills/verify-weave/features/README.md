# Weave verification map

This directory is the maintained source for verifying the user-facing behavior of the Weave session-watch RPC bridge and its React client. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run from the Weave worktree at the SHA you intend to prove. `git rev-parse HEAD` must match the `codeSHA` in the run manifest.
- Install exactly once per clean worktree with `bun install --frozen-lockfile`. Use Bun 1.4.4 or newer.
- Start a fresh owned run with `bun run verify launch --worktree "$PWD"`. Use the absolute path it prints as `RUN` for later commands. A `--run` path must be absolute.
- Launch returns only after the server has opened one source SSE, drained the paginated unarchived list, and read the active map with zero frontends.
- Run `bun run verify doctor --run "$RUN"` and require every implementation check to pass before driving. On an uncommitted worktree, `worktree-clean` fails by design and the run is interim evidence, not a clean-SHA proof.
- Never drive a Weave, OpenCode, or Tailscale listener that this run did not start.
- Never use ports 4399 through 4403. The harness asks the real server for port 0 and records the actual ephemeral port in `state.json`.

## Driving conventions

- Treat every command as literal. Keep quoted paths unchanged.
- Drive features in order: `snapshot`, `live-updates-attention`, `lifecycle`, then `rpc-errors`.
- One long-lived server serves the whole run. The projection is owned by the serve layer and starts before the first client.
- `rpc-errors` runs last because it exhausts source retries and stops its fake upstream.
- Client UI runs use `bun .agents/skills/verify-weave/harness/client-ui.ts`. It is a habitat smoke for the development client and built preview. It starts and stops its own `bun run dev:mock` runner and headless Chrome. Do not point it at a preview or runner it did not start.
- Use the native typed RPC client built from the production `Group`. Do not add a test-only endpoint to Weave. The watch stream yields a `SessionFeed`, a list of source groups. The single-source regression fixture uses source ID `local`.
- A feed is complete. Presence and absence in the latest feed are the only truth about the collection.
- Change the upstream fixture only through `harness/session.ts` control requests. A reset emits child-first `session.deleted` and parent-first `session.created` events; a mid-scenario write uses `reset: false` and is followed by the public event under test. Writing the fixture alone does not change an already-running projection.
- The fixtures are replayable. Each control request sets deterministic sessions and publishes public events through the fake's HTTP and SSE boundary. Reproducibility comes from the fixture and the event sequence, not a product replay command.
- On a failed feature, inspect `scenarios/*.json`, `frames.jsonl`, `raw.frames.jsonl`, and `requests.jsonl` before rerunning. Cleanup already stopped owned processes; evidence stays.

## Proof and skip reporting

- Capture the user action and the resulting feed or process result, not only a final summary.
- RPC proof includes the actual typed client feed in `frames.jsonl` and the upstream request path in `requests.jsonl`.
- Error proof includes the direct client result in `direct/*.json` and the raw HTTP status, content type, and frames in `raw.frames.jsonl`.
- Lifecycle proof uses the fake's cumulative connection count and its open SSE controller count. A watch leaves both unchanged. Only backend layer close sets the open count to zero.
- Process proof includes the owned PID, actual port, and listener ownership check.
- Report an unreachable path with the attempted command and the unmet precondition. Do not report a skipped entry point as verified through a different path.
- A check that can only be made inside the harness is insufficient. Assert the observable feed, request, process result, exit code, PID, or port.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-weave` starts with `Preconditions:` and pairs each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Snapshot](./snapshot.md) covers the startup whole feed with zero frontends, paginated seed, all idle and running descendants, zero attention, whole replacement, and a watch that adds no source reads.
- [Live updates and attention](./live-updates-attention.md) covers complete feed replacement, idle retention, own permission and question counts, cross-kind ids, root archive and whole-family unarchive, individual delete, and retention across zero viewers.
- [Stream lifecycle](./lifecycle.md) covers one startup source, watch with no reads, late-viewer retention, shared projection, last cancel keeping the source, and SIGTERM teardown. Source recovery is covered in `rpc-errors`.
- [Source recovery and RPC errors](./rpc-errors.md) covers retained source health, fresh reseeding, bounded retries, zero-viewer recovery, raw NDJSON, closed transport, missing credentials, and secret-free evidence.
- [Multiple sources](./multi-source.md) covers ordered explicit configuration, independent authenticated HTTP and SSE sources, colliding IDs, blocked startup, source-local recovery, and sibling flow after retry exhaustion.
- [Client habitat UI (browser smoke)](./client-sessions-ui.md) checks the real feed, session updates, departure and return, debug SPS behavior, built preview, App teardown, retention through source recovery, and the top-left connection HUD. Its source-controls scenario checks one source disclosure, the terminal unavailable precedence, persistent problem text, mobile sheet clearance, live health updates, and the transport-loss notice. Attention counts, archive, and delete are proved by the server features.

The client feature also covers native title copy, typed placard context, the
folder tooltip, Escape focus return, outside close, and the unchanged mobile
canvas and camera when the fixed bottom sheet opens. Its `specimen` scenario
compares downsampled specimen appearance and pose with the main tank. It checks
desktop placement, motion, selection replacement, WebGPU, and target release on close.

## Not implemented

[Three.js validation](../references/threejs-validation.md) is partial: a
development page checks three actual App WebGPU mount/unmount cycles, and the
client habitat smoke covers the live tank. Supersampling and a published performance
baseline are still open.

There is no database, replay log, polling loop, startup request scan, cursor
resume token, or pending-request hydration. The process keeps one
temporary in-memory projection for its own lifetime and does not persist it.
