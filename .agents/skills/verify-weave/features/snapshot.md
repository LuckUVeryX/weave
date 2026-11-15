# Snapshot

The server builds one projection when the process starts, before any client connects. It subscribes to OpenCode events, waits for `server.connected`, drains the unarchived collection at `archived=false` with no `parentID` filter, and reads the active ids. The seeded `SessionFeed` has one `local` source group and zero attention. Before seeding completes, a viewer can receive an empty group with `connecting` health. Every child under an unarchived root is included, idle or running, at any depth.

## Sub-features

- `snapshot-startup-first-feed` publishes one `local` source group from the 502-session startup fixture before any reset, with the running child and zero attention.
- `snapshot-startup-pagination` reads the mixed collection across more than one page at server start, with one active read and no per-session fanout.
- `snapshot-all-children` includes idle and running descendants at any depth under an unarchived root.
- `snapshot-zero-attention` starts every returned permission and question count at zero.
- `snapshot-full-replace` publishes the current whole collection after a fixture reset, not a patch of an older one.
- `snapshot-watch-no-reads` attaches a viewer without another source connection, list read, or active read.
- `snapshot-no-pending-reads` keeps permission and form endpoints out of the seed.

## How to get to it (user POV)

- Start the bridge with `bun run serve`. The projector starts with the process, before any viewer.
- Connect a watch subscription with the native RPC client built from `Group` in `src/shared/rpc.ts`. The first item is the current feed.
- Open another viewer. It replays the same current feed.
- Change the collection upstream. The next feed is the whole collection again.

## Driving it with verify-weave

Preconditions:

- The run was launched from the worktree under test with `bun run verify launch --worktree "$PWD" --run "$RUN"`. Launch waits for one source SSE, the paginated list seed, and one active read with zero frontends. The startup fixture takes three list requests.
- `bun run verify doctor --run "$RUN"` passed every implementation check. On an uncommitted worktree the `worktree-clean` check fails by design. Doctor checks live health, so you can re-run it after a fixture change.
- Fixture resets go through `harness/session.ts`: child-first deletes, parent-first creates, then execution-started events for active sessions. Scenarios emit archive, unarchive, and metadata events separately. Viewers never trigger seeding; startup, unarchive, and source recovery do.

- **Startup first feed.** Run `bun run verify feature snapshot --run "$RUN"` before any other feature. Its `startup` scenario records one source connection and one source stream, the paginated seed below, one active read, and no per-session or pending read. The typed client decodes one `local` group with the 502-session startup fixture, the child running, and zero attention before any fixture reset.
- **Startup pagination.** The same scenario reads three `/api/session` pages with `limit=500&archived=false`, no `parentID`, one `/api/session/active`, and no individual `/api/session/<id>` read. The startup fixture has 501 roots plus one running child, so 500 is a page size and not a cap.
- **All children.** The `all-children` scenario sets a visible root with idle and running children, an idle intermediate with an idle grandchild, a running grandchild under that intermediate, an archived root with a child, and a session whose parent does not exist. The feed contains every unarchived-family id, including the idle intermediate and idle deep child. It omits the archived pair and the outside-family session.
- **Zero attention.** The `first-feed` scenario requires every returned attention object to be `{ permissions: 0, questions: 0 }`. The lifecycle `late-viewer-retains` scenario proves attention observed later stays with the process and is not reset per viewer.
- **Full replacement.** The `full-replace` scenario publishes `ses_before`, then resets the fixture to `ses_after` through delete and create events. The next feed contains `ses_after` and not `ses_before`.
- **Watch adds no reads.** `doctor` records `watch-adds-no-source-requests`; the lifecycle `startup-zero-frontend` scenario records `watch-start-same-source-connection` and `watch-start-no-source-requests`.
- **No pending reads.** The `no-pending-reads` scenario requires every request path in the seed and reset to avoid `permission` and `form`.
- **Proof.** Use `doctor.json`, `scenarios/startup.json`, `scenarios/first-feed.json`, `scenarios/whole-collection.json`, `scenarios/all-children.json`, `frames.jsonl`, and `requests.jsonl`.

## Gotchas

- The first stream item is the feed. Do not scan for a `connected` or `sessions` event type.
- A feed is complete. Absence of an id means the session is not in the collection.
- 500 is a page size, not a total cap. Pagination follows the next cursor until it is absent or a page is empty. The startup fixture seeds 502 sessions before the first viewer.
- Startup, unarchive, and source recovery can read multiple pages. Attaching a viewer never triggers a list or active read.
- The whole collection includes idle children at any depth. Do not treat idle or hidden parents as a visibility filter.
- Archived roots and their descendants are outside the collection. A session whose parent is missing is also outside it.
- A fixture reset must emit real delete and create events. Writing `setSessions` alone does not change an already-running projection.
- Startup attention is zero. Attention observed after startup is retained for later viewers; it is not reset by a new subscription.
- Use the native typed client for every feed. The harness does not run a CLI.
