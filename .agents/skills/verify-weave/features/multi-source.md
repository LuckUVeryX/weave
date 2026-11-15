# Multiple sources

Weave accepts an ordered explicit source list. Each server has its own credentials, session state, attention requests, health, and retry budget. An unavailable source leaves sibling feeds live.

## Sub-features

- `configuration`: authoritative JSON configuration, stable unique IDs, input order, HTTP or HTTPS URLs, safe errors, and legacy fallback.
- `independence`: a blocked first seed permits the second source to publish.
- `collisions`: identical session, parent, permission, and question IDs stay source-local.
- `recovery`: only the dropped source is replaced by a fresh snapshot. Siblings continue during backoff and after exhaustion.
- `secrets`: raw feed and server logs exclude source usernames, passwords, and authorization values.

## How to get to it (user POV)

Set `WEAVE_OPENCODE_SOURCES` before `bun run serve`, then subscribe to `/rpc`. Each array entry requires `id`, `username`, `password`, and `url`. See the root README for a placeholder example.

## Driving it with verify-weave

Preconditions: use the worktree and SHA under review, install with `bun install --frozen-lockfile`, and keep the worktree clean for final evidence.

Run `bun .agents/skills/verify-weave/harness/multi-source.ts --run <absolute-new-directory>` from that worktree. The runner starts two independently controlled HTTP and SSE fakes with distinct Basic credentials and the real server on ephemeral ports. It blocks the first seed, observes the healthy second feed, releases the seed, sends colliding requests, drops and recovers the first source, and exhausts that source while the sibling stays live. Allow about four minutes.

Require `result: "PASS"` in `manifest.json` and `pass: true` in every `checks.json` entry. Inspect `frames.jsonl`, `raw.frames.json`, scrubbed `requests.jsonl`, both server logs, and `cleanup.json`. Cleanup must show closed fake and server ports and server exit 0 or 130.

Run `bun run check` for invalid configuration and legacy fallback cases, plus virtual-clock recovery and initial-group tests. Run `bun run verify all --worktree "$PWD"` for the single-source regression map. Run the existing client habitat smoke after fixture changes.

## Gotchas

- This runner owns its processes and cleans them up on success or failure. It never drives an existing listener.
- The two-source runner is separate from the single-source `verify all` fixture. Neither runner requires evidence from the other; run both for full server coverage.
- The runner records the SHA and whether the worktree was clean. Dirty-worktree evidence is interim evidence.
- Pending requests are not hydrated during startup or recovery. A fresh source starts with zero attention.
- Source health icons and details are verified by [Client habitat UI](./client-sessions-ui.md).
