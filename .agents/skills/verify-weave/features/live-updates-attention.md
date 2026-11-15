# Live updates and attention

The process-owned projection publishes a new complete `SessionFeed` on every change. Metadata, activity, status, outcome, and request events replace the prior feed. Optional fields that disappear upstream disappear from the next feed; they do not linger. Attention is own-only on every session and is counted from the server's one upstream connection, so it survives with zero viewers. Idle children stay in the collection.

## Sub-features

- `live-records` renames, moves, records a viewed activity, records a failed outcome, then clears the optional title, outcome, and viewed fields from a complete feed.
- `live-running-idle-retained` updates an idle child to running and back to idle while keeping it in the collection.
- `live-attention-permission-own` counts a permission id on its owning session only. Unknown replies do nothing; a reply clears the owner's count.
- `live-attention-question-own` counts a question form id on its owning session only. Unknown cancels do nothing; reply and cancel clear the owner's count.
- `live-attention-cross-kind` tracks permission and question requests independently on the same session.
- `live-root-archive` removes an archived root and its family, forgets pending requests, and restores the whole family with fresh zero attention on unarchive.
- `live-delete-individual` removes each deleted session on its own child-first delete event, without removing its parent or child.
- `live-shared-retention` keeps observed attention while zero viewers are connected and serves it to a later viewer.

## How to get to it (user POV)

- Keep the bridge running. The projection is already live before any viewer connects.
- In OpenCode, rename or move a session, change its outcome, or open it. The bridge publishes a complete feed with the updated session.
- Start or finish a child session. Its status changes and it stays in the collection.
- Trigger a permission request or a question form on any session. Only the owning session's count changes, even if no browser is open.
- Reply to or cancel a request. The owner's count clears.
- Archive a root or delete sessions. The archived family leaves and its tracked state is forgotten. Each deleted session leaves on its own delete event.
- Attach a viewer later. It receives the current feed, including attention observed while it was absent.

## Driving it with verify-weave

Preconditions:

- The run was launched from the worktree under test and doctor passed every implementation check.
- The upstream fake is still running. Do not run `rpc-errors` before this feature; `rpc-errors` ends the upstream last.
- Start each scenario from its own fixture. `controlSessions` resets the projection with child-first delete events and parent-first create events. A mid-scenario fixture write uses `reset: false` and is followed by the exact public event under test.

- **Complete records.** Run `bun run verify feature live-updates-attention --run "$RUN"`. The `records` scenario changes title, directory, viewed time, and outcome, then removes optional fields. Each complete feed keeps id, time, location, status, and attention without retaining omitted fields.
- **Idle retention.** The `running-idle-retained` scenario starts with a visible idle child. After `session.execution.started`, the child is running with its parent id. After `session.execution.succeeded`, the child is idle and still present.
- **Permission attention.** The `attention-own` scenario asks permission `per_child` on the child. The child reaches `permissions: 1`; the root and deep child stay at `0`. A request on the root reaches `1` on the root only. Unknown replies emit no feed: the `unknown-reply-no-feed` check uses a metadata barrier and requires exactly one new feed. Replying to `per_child` drops the child to `0` and leaves the root at `1`.
- **Question attention.** The same scenario creates question `frm_child` on the child and `frm_deep` on the deep child. Each owner reaches `questions: 1`; the root stays at `0`. An unknown cancel changes nothing. Replying to `frm_child` drops only the child to `0` while the deep child stays at `1`. Cancelling `frm_deep` then drops the deep child to `0`. The child permission stays at `1` through both.
- **Cross-kind ids.** The `attention-cross-kind` scenario creates permission `per_shared` and question `frm_shared` on one child. The child reports one of each. Replying to the permission clears only the permission.
- **Root archive.** The `root-archive` scenario asks a permission on the child, then archives the root. The root, child, and deep child leave the feed. Unarchive re-reads the list and active map and returns the family with zero attention. This fixture's active map is empty, so its sessions return idle. A late reply for the old request emits no feed, proved with a one-feed barrier. A new child request counts only on the child.
- **Delete.** The `delete-individual` scenario sends child-first `session.deleted` events for a deep child, its child, and the root. Each event removes only its own session. The parent stays until its own event.
- **Retention across zero viewers.** The [lifecycle](./lifecycle.md) `late-viewer-retains` scenario proves last-cancel source retention and attention updates with no viewers.
- **Proof.** Inspect `frames.jsonl` for the named ids and counts, `scenarios/attention-own.json` for the unknown-reply barrier and the check list, and `scenarios/records.json` for the optional-field checks.

## Gotchas

- Attention is own-only. A child request never changes the root count.
- There is no family count, no root aura, and no rollup footnote.
- Attention is process-owned. It survives with zero viewers and is retained for later viewers. Do not assert zero attention for a new subscription.
- Permission and form events are live and ephemeral. OpenCode mints each id once and rejects a duplicate pending id, so do not build fixtures that send the same id twice.
- A reply or cancel for an id the connection never observed must do nothing.
- Full feeds replace optional fields. If an upstream summary has no title or outcome, the next feed omits it.
- A failed or succeeded execution event returns the session to idle. An idle child stays in the whole collection.
- Archiving a root removes the whole family and forgets pending requests, including ones observed before the archive. Child archive is not a supported event.
- Unarchive re-reads the global unarchived list plus the active map. The whole family returns with its own counts at zero; pending requests on other sessions are retained.
- Deleting a session removes only that session. Delete events arrive child-first; each event removes its own record.
- Pending ids are keyed by request kind and id, with the owning session stored as the value. This scenario checks independent permission and question counts, not a same-string cross-kind collision.
- Scenario resets clear old families with real delete events. Do not rely on writing the fixture alone.
