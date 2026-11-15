# Stream lifecycle

The serve layer owns the OpenCode event stream and projection. It connects and seeds before any viewer, then keeps publishing with zero viewers. Viewers read the retained feed without opening a source. A normal SIGTERM closes the layer and listener. Source recovery and retry exhaustion are proved in [Source recovery and RPC errors](./rpc-errors.md). That feature closes the source before cleanup, so cleanup observes source absence rather than proving SIGTERM closed a live SSE. The layer-scope test in `test/session-watch.test.ts` proves live SSE closure.

## Sub-features

- `lifecycle-startup-zero-frontend` starts one source SSE and one seed with zero viewers before any RPC client connects.
- `lifecycle-watch-no-reads` attaches a viewer without a new source connection, list read, or active read.
- `lifecycle-late-viewer-retains` keeps the process projection and observed attention while zero viewers are connected, then serves both to a later viewer.
- `lifecycle-two-frontends-shared` serves two viewers from one source and one projection; cancelling one leaves the other receiving events.
- `lifecycle-sigterm-teardown` sends SIGTERM and proves the server listener closes, then observes that no source connection remains open and no replacement opened.
- `lifecycle-source-recovery` is covered by `rpc-errors/source-recovery` and `rpc-errors/source-exhaustion`.

## How to get to it (user POV)

- Start the bridge with `bun run serve`. It opens its OpenCode source before any browser or RPC client connects.
- Connect one watch subscription. It receives the current feed.
- Open a second watch subscription at the same time. Both receive the same projection.
- Cancel one subscription. Keep watching with the other.
- Cancel the last subscription. The source stays open and the projection keeps updating.
- Connect again. The new viewer receives everything observed while it was gone.
- Stop the server with SIGTERM. The process closes its source connection, exits with the native signal code, and releases its port.
- Drop the upstream event stream. Watches retain sessions and report source health while the backend retries.

## Driving it with verify-weave

Preconditions:

- The run was launched from the worktree under test. Launch waits for one source SSE, the paginated list seed, and one active read with zero frontends.
- Doctor passed every implementation check. On an uncommitted worktree the `worktree-clean` check fails by design.
- The upstream fake is still running. Exhaustion runs last in `rpc-errors`.
- Run the features in order: `snapshot`, `live-updates-attention`, `lifecycle`, then `rpc-errors`.

- **Startup with zero frontends.** Run `bun run verify feature lifecycle --run "$RUN"`. The `startup-zero-frontend` scenario records `startup-one-source-and-seed` with cumulative `1` and open `1`. Launch already proved the seed ran before any frontend, and the snapshot `startup` scenario records that one-time seed before any fixture change.
- **A watch starts no source work.** `startup-zero-frontend` opens a viewer after a settled fixture and records `watch-start-same-source-connection` and `watch-start-no-source-requests`. The request delta must be empty. Doctor records `watch-adds-no-source-requests` for the first watch.
- **Late viewer retention.** The `late-viewer-retains` scenario opens a viewer, asks one permission, and closes it. The source stays open (`last-cancel-keeps-source`). It then asks a second permission with zero viewers, applies a metadata barrier, and opens a late viewer. The late feed has both permission counts. `late-viewer-retains-attention` and `late-viewer-no-new-source` prove retention and one source.
- **Two viewers, one projection.** The `two-frontends-shared-projection` scenario opens two viewers, then requires `two-frontends-one-source` with one source and one projection. A permission reaches both. After cancelling one, `cancel-one-leaves-other` requires the survivor to see the next event and `cancel-one-keeps-source` requires the source to stay open.
- **SIGTERM listener closure and source absence.** Run `bun run verify cleanup --run "$RUN"` after the features. `cleanup.json` records `sigterm-stops-server` (the server exits 0 or 130 and its listener closes), `source-connection-inactive` (no open source connection and no new connection), `supervisor-gone`, `runner-gone`, `server-port-closed`, and `fake-port-closed`. Because `rpc-errors` normally closes the source first, this check observes that no source connection remains open. It does not prove SIGTERM closed a live source. The Effect SSE scope closure is owned by the `test/session-watch.test.ts` layer-scope case.
- **Upstream recovery and exhaustion.** Run `bun run verify feature rpc-errors --run "$RUN"` last. See [Source recovery and RPC errors](./rpc-errors.md).
- **Proof.** Use `doctor.json`, `scenarios/startup-zero-frontend.json`, `scenarios/late-viewer-retains.json`, `scenarios/two-frontends-shared-projection.json`, `cleanup.json`, `post-cleanup.json`, `frames.jsonl`, and `requests.jsonl`.

## Gotchas

- Attention is retained across viewers. A new subscription does not reset it. Startup and recovery snapshots start attention at zero.
- The fake connection counter is cumulative. `openConnections` is the live controller count. A watch must leave both unchanged.
- Two concurrent viewers share one source and one projection. Expect one connection for both, not two.
- Cancelling one viewer must not close the source. Cancelling the last viewer must not close it either. Only the serve-layer scope close aborts it.
- Upstream failure changes source health, not RPC watch liveness. After ten failed retries, restart the backend to retry again.
- SIGTERM may exit with 0 or the native Bun signal code 130. Both are successful intentional shutdown. Do not mark 130 as a verification failure.
- Keep retry exhaustion in `rpc-errors` so earlier features run against a connected source.
