# Source recovery and RPC errors

Upstream failures change the required `health` on the `local` source group. They do not fail the watch. The last sessions remain visible during retries and after exhaustion. RPC transport failures remain separate failures.

## Sub-features

- `rpc-direct-feed` decodes the production `SessionFeed` through the native client.
- `rpc-raw-chunk` checks HTTP 200, NDJSON, and a raw `Chunk` frame.
- `source-recovery` observes reconnecting health, retained sessions, a fresh replacement snapshot, and a reset retry budget after successful seeding.
- `source-zero-viewers` recovers while no viewers are attached.
- `source-exhaustion` fails every reconnect seed, closes each attempt SSE, stops after ten retries, and serves retained unavailable feeds to current and later watches.
- `rpc-closed-transport` fails a native client without a feed and records the actual error tag and cause.
- `rpc-missing-credentials` exits non-zero and names the missing configuration key.
- `rpc-no-secrets` scans evidence written so far for controlled credentials. Cleanup performs the final scan.

## How to get to it (user POV)

- Connect a watch to the bridge. The feed includes source health.
- End the upstream SSE. The source reports `reconnecting` with the retry number and delay, while retaining its sessions.
- Restore upstream access. A new SSE opens before the bridge reads a fresh snapshot. The source reports `connected` and replaces old sessions.
- Keep the upstream unavailable through ten retries. The source reports `unavailable`; watches stay open. A later watch receives the same retained feed. Restart the bridge to retry after exhaustion.
- Connect to a closed RPC port. The native client fails without a feed.
- Start without credentials. The process exits and names the missing key.

## Driving it with verify-weave

Preconditions:

- Launch an owned run from the SHA under test and pass doctor.
- A fresh launched run with passing doctor is sufficient. On a shared full run, run this feature last, after `snapshot`, `live-updates-attention`, and `lifecycle`.
- Allow about three minutes for the real retry delays. The harness does not shorten production timing.

Run `bun run verify feature rpc-errors --run "$RUN"`.

The `source-recovery` scenario drops SSE, changes the fixture without events during the outage, and requires a fresh connected snapshot. It drops again and requires retry `1`, then closes all viewers during recovery.

The `source-exhaustion` scenario makes snapshot HTTP reads return 503 after SSE connects. It requires exactly ten new connections, zero open connections after exhaustion, retained sessions, and live current and later watches. The raw response must still be a `Chunk`, not an upstream-error `Exit`. Restoring snapshot access must not restart an exhausted source.

The other scenarios retain native closed-transport, missing-credential, raw NDJSON, and secret-redaction checks. Evidence is in `scenarios/source-recovery.json`, `scenarios/source-exhaustion.json`, `frames.jsonl`, `requests.jsonl`, `raw.frames.jsonl`, `direct/closed-transport.json`, and `checks.json`.

Deterministic service-boundary tests in `test/source-recovery.test.ts` prove eleven total attempts for startup connection and seed failures, the exact delay sequence, and closure of failed seed scopes. Run them with `bun run test test/source-recovery.test.ts`.

## Gotchas

- The fake's `events.end()` closes current SSE connections but accepts new ones. It proves recovery, not exhaustion.
- Acknowledging SSE alone does not reset the budget. The seed must also succeed.
- Each recovery starts a fresh projection. Pending attention hydration remains deferred, so recovered sessions start with zero attention.
- Run this feature last because it leaves the source exhausted and stops its fake upstream.
- Doctor accepts a recovered source when it has one open connection and a connected typed feed. It fails while the source is reconnecting or exhausted.
- Cleanup compares cumulative connections with the count immediately before shutdown, not the initial count.
- A source outage is not an RPC transport failure. Keep the closed-port check separate.
