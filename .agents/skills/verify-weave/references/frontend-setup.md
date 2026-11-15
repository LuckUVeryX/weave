# Frontend setup

The production React client renders the WebGPU habitat with `three/webgpu`.
Use [Client habitat UI](../features/client-sessions-ui.md) for live behavior and
[Three.js validation](./threejs-validation.md) for coverage limits.

## Static checks

Run from the worktree under test:

```sh
bun install --frozen-lockfile
bun run check
bun run build
```

The build writes `dist/client/index.html` and hashed assets, including Three.js.
The lifecycle page under `test/harness` is development-only.

## Development and preview

`bun run dev:mock` starts the controlled OpenCode fake, real server, and Vite
client. Open the UI URL printed in `DEV_READY`. The client helper uses
`WEAVE_DEV_HOST=127.0.0.1` so its listeners stay local.

For an owned server without the mock runner, set `WEAVE_DEV_RPC_URL` to its URL
before starting `bun run dev` or `bun run preview`. Both proxy `/rpc` to that
target; the fallback is `http://127.0.0.1:4310`. Preview serves the built
`dist/client` directory. Bind explicitly to a reviewer's network address only
when remote access is intended.

Open `/test/harness/scene.html` on the development URL for the actual App
lifecycle page. It requires a live RPC target and WebGPU. It is not a
production readiness endpoint.

## Browser regression

```sh
RUN=$(mktemp -d "$TMPDIR/weave-client-ui.XXXXXX")
bun .agents/skills/verify-weave/harness/client-ui.ts --worktree "$PWD" --run "$RUN"
```

This owns its mock runner, Chrome profile, and production preview. It drives
the real feed, rendering, interactions, source recovery, and App teardown,
then checks owned-process cleanup and evidence readability. It does not
launch a real OpenCode server or establish visual acceptance.
