#!/usr/bin/env bun
import { join } from "node:path";
import { Effect } from "effect";
import type { SessionFeed } from "../../../../src/shared/session.ts";
import {
  basicAuthorization,
  eventFrame,
  startFakeOpenCode,
} from "../../../../test/support/fake-opencode.ts";
import { rawProbe, startWatcher, waitForFeed, withClient } from "./client.ts";
import { Recorder } from "./scenarios.ts";
import {
  appendJsonl,
  ensureDir,
  isDescendantOf,
  listenerPIDs,
  runCommand,
  uniqueRun,
  writeJson,
} from "./support.ts";

const worktree = process.cwd();
const runIndex = Bun.argv.indexOf("--run");
const run = runIndex < 0 ? uniqueRun() : Bun.argv[runIndex + 1];
if (run === undefined) throw new Error("--run requires a path");
ensureDir(run);
const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree }).stdout.toString().trim();
const clean =
  Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktree }).stdout.toString().trim() ===
  "";
const recorder = new Recorder("multi-source", "isolation");
const authA = { username: "verify-source-alice", password: "verify-source-a-password" };
const authB = { username: "verify-source-bob", password: "verify-source-b-password" };
let releaseSeed: () => void = () => {};
const seedGate = new Promise<void>((resolve) => {
  releaseSeed = resolve;
});
const family = (title: string) => [
  { id: "ses_root", title, directory: "/work/multi" },
  { id: "ses_child", parentID: "ses_root", title: `${title} child`, directory: "/work/multi" },
];
const firstFixture: { status?: number; sessions: ReturnType<typeof family> } = {
  sessions: family("First"),
};
const first = startFakeOpenCode(firstFixture, {
  auth: authA,
  beforeRequest: (url) => (url.pathname === "/api/session" ? seedGate : Promise.resolve()),
});
const second = startFakeOpenCode(
  { sessions: family("Second"), active: { ses_child: { type: "running" } } },
  { auth: authB },
);
const sources = [
  { id: "z-first", ...authA, url: first.url },
  { id: "a-second", ...authB, url: second.url },
];
const server = Bun.spawn({
  cmd: ["bun", "run", "serve"],
  cwd: worktree,
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("WEAVE_"))),
    WEAVE_HOST: "127.0.0.1",
    WEAVE_PORT: "0",
    WEAVE_OPENCODE_SOURCES: JSON.stringify(sources),
    WEAVE_OPENCODE_URL: "invalid legacy URL",
    WEAVE_OPENCODE_PASSWORD: "ignored legacy password",
  },
  stdout: "pipe",
  stderr: "pipe",
});
let stdout = "";
let stderr = "";
const drain = async (stream: ReadableStream<Uint8Array>, append: (text: string) => void) => {
  for await (const value of stream) append(new TextDecoder().decode(value));
};
const drains = [
  drain(server.stdout, (text) => {
    stdout += text;
  }),
  drain(server.stderr, (text) => {
    stderr += text;
  }),
];
let sequence = 0;
const emit = (upstream: typeof first, type: string, data: Readonly<Record<string, unknown>>) => {
  sequence += 1;
  upstream.events.send(
    eventFrame(type, data, { id: `evt_multi_${sequence}`, created: Date.now(), seq: sequence }),
  );
};
const session = (feed: SessionFeed, source: number, id = "ses_child") =>
  feed[source]?.sessions.find((item) => item.id === id);
const check = (name: string, pass: unknown) => recorder.require(name, pass, name);
let port = 0;
let failure: unknown;
try {
  for (const [name, input] of [
    ["empty", ""],
    ["invalid", JSON.stringify([{ id: "broken", ...authA, url: "file:///invalid" }])],
  ] as const) {
    const observed = await runCommand(["bun", "run", "serve"], {
      cwd: worktree,
      timeoutMs: 5_000,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("WEAVE_")),
        ),
        WEAVE_HOST: "127.0.0.1",
        WEAVE_PORT: "0",
        WEAVE_OPENCODE_SOURCES: input,
        WEAVE_OPENCODE_URL: first.url,
        WEAVE_OPENCODE_PASSWORD: authA.password,
      },
    });
    check(
      `authoritative-${name}-startup-fails`,
      !observed.timedOut && observed.exitCode !== 0 && !observed.stdout.includes("Listening on"),
    );
    const output = observed.stdout + observed.stderr;
    check(
      `authoritative-${name}-safe-error`,
      output.includes("WEAVE_OPENCODE_SOURCES") &&
        !output.includes(authA.password) &&
        !output.includes(authA.username),
    );
    await writeJson(join(run, `startup-${name}.json`), observed);
  }
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
    if (match !== null) {
      port = Number(match[1]);
      break;
    }
    if (server.exitCode !== null) throw new Error("Owned server exited before listening");
    await Bun.sleep(20);
  }
  check(
    "owned-listener",
    port > 0 &&
      listenerPIDs(port).some((pid) => pid === server.pid || isDescendantOf(pid, server.pid)),
  );
  const url = `http://127.0.0.1:${port}`;
  await writeJson(join(run, "state.json"), {
    sha,
    worktree,
    clean,
    server: { pid: server.pid, url },
    fakes: [first.url, second.url],
  });
  await withClient(url, (client) =>
    Effect.gen(function* () {
      const watcher = yield* startWatcher(client, (feed) =>
        appendJsonl(join(run, "frames.jsonl"), [{ at: Date.now(), feed }]),
      );
      const slow = yield* waitForFeed(
        watcher,
        "healthy source while first seed is blocked",
        (feed) => feed[0]?.health.kind === "connecting" && feed[1]?.health.kind === "connected",
      );
      check(
        "ordered-groups-before-readiness",
        slow.map((source) => source.id).join(",") === "z-first,a-second",
      );
      check(
        "slow-source-does-not-block",
        session(slow, 1)?.status === "running" && slow[0]?.sessions.length === 0,
      );
      releaseSeed();
      const initial = yield* waitForFeed(watcher, "both sources", (feed) =>
        feed.every((source) => source.health.kind === "connected"),
      );
      check(
        "colliding-family-isolated",
        session(initial, 0)?.title === "First child" &&
          session(initial, 1)?.title === "Second child" &&
          session(initial, 0)?.parentID === "ses_root" &&
          session(initial, 1)?.parentID === "ses_root",
      );
      for (const upstream of [first, second]) {
        emit(upstream, "permission.asked", {
          id: "per_same",
          sessionID: "ses_child",
          action: "read",
          resources: ["*"],
        });
        emit(upstream, "form.created", {
          form: {
            id: "frm_same",
            sessionID: "ses_child",
            title: "Question",
            metadata: { kind: "question" },
            fields: [{ key: "answer", type: "string" }],
          },
        });
      }
      yield* waitForFeed(watcher, "colliding requests", (feed) =>
        [0, 1].every(
          (index) =>
            session(feed, index)?.attention.permissions === 1 &&
            session(feed, index)?.attention.questions === 1,
        ),
      );
      emit(first, "permission.replied", {
        sessionID: "ses_child",
        requestID: "per_same",
        reply: "once",
      });
      emit(first, "form.replied", { id: "frm_same", sessionID: "ses_child", answer: {} });
      const replied = yield* waitForFeed(
        watcher,
        "source-local replies",
        (feed) =>
          session(feed, 0)?.attention.permissions === 0 &&
          session(feed, 0)?.attention.questions === 0,
      );
      check(
        "colliding-requests-isolated",
        session(replied, 1)?.attention.permissions === 1 &&
          session(replied, 1)?.attention.questions === 1,
      );
      emit(first, "permission.asked", {
        id: "per_unresolved",
        sessionID: "ses_child",
        action: "read",
        resources: ["*"],
      });
      yield* waitForFeed(
        watcher,
        "unresolved attention before drop",
        (feed) => session(feed, 0)?.attention.permissions === 1,
      );
      first.setSessions([{ id: "ses_fresh", title: "Fresh", directory: "/work/fresh" }]);
      first.events.end();
      const dropped = yield* waitForFeed(
        watcher,
        "source-local reconnect",
        (feed) => feed[0]?.health.kind === "reconnecting",
      );
      check(
        "drop-retains-only-affected-health",
        session(dropped, 0)?.title === "First child" &&
          session(dropped, 0)?.attention.permissions === 1 &&
          feedConnected(dropped, 1),
      );
      emit(second, "session.execution.succeeded", { sessionID: "ses_child" });
      yield* waitForFeed(
        watcher,
        "sibling updates during backoff",
        (feed) => feed[0]?.health.kind === "reconnecting" && session(feed, 1)?.status === "idle",
      );
      const recovered = yield* waitForFeed(
        watcher,
        "fresh source replacement",
        (feed) =>
          feed[0]?.health.kind === "connected" && session(feed, 0, "ses_fresh") !== undefined,
      );
      check(
        "fresh-recovery-replaces-one-slot",
        recovered[0]?.sessions.length === 1 &&
          session(recovered, 0, "ses_fresh")?.attention.permissions === 0 &&
          session(recovered, 0) === undefined &&
          session(recovered, 1)?.attention.permissions === 1 &&
          session(recovered, 1)?.status === "idle",
      );
      check(
        "source-connections-independent",
        first.events.connections() === 2 && second.events.connections() === 1,
      );
      const connectionsBeforeOutage = first.events.connections();
      firstFixture.status = 503;
      first.events.end();
      const exhausted = yield* waitForFeed(
        watcher,
        "source exhaustion",
        (feed) => feed[0]?.health.kind === "unavailable",
        220_000,
      );
      check(
        "exhaustion-retains-source-and-sibling",
        exhausted[0]?.sessions[0]?.id === "ses_fresh" && feedConnected(exhausted, 1),
      );
      emit(second, "permission.replied", {
        sessionID: "ses_child",
        requestID: "per_same",
        reply: "once",
      });
      const live = yield* waitForFeed(
        watcher,
        "sibling after exhaustion",
        (feed) =>
          feed[0]?.health.kind === "unavailable" && session(feed, 1)?.attention.permissions === 0,
      );
      check(
        "exhausted-source-does-not-fail-feed",
        watcher.fiber.pollUnsafe() === undefined && session(live, 1)?.attention.questions === 1,
      );
      const connections = first.events.connections();
      recorder.require(
        "per-source-retry-budget",
        connections === connectionsBeforeOutage + 10 && second.events.connections() === 1,
        "Expected ten source-local reconnects",
        `first ${connectionsBeforeOutage} to ${connections}; second ${second.events.connections()}`,
      );
      const later = yield* Effect.promise(() => rawProbe(url, "chunk"));
      yield* Effect.promise(() => writeJson(join(run, "raw.frames.json"), later));
      check(
        "raw-feed-contains-both-sources",
        later.body.includes("z-first") &&
          later.body.includes("a-second") &&
          later.body.includes("unavailable"),
      );
    }),
  );
  for (const [index, upstream] of [first, second].entries()) {
    const auth = index === 0 ? authA : authB;
    check(
      `source-${index}-distinct-basic-auth`,
      upstream.requests.length > 0 &&
        upstream.requests.every(
          (request) => request.authorization === basicAuthorization(auth.username, auth.password),
        ),
    );
  }
} catch (error) {
  failure = error;
} finally {
  releaseSeed();
  server.kill("SIGTERM");
  await Promise.race([server.exited, Bun.sleep(5_000)]);
  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await server.exited;
  }
  await Promise.all(drains);
  for (const [index, upstream] of [first, second].entries()) {
    appendJsonl(
      join(run, "requests.jsonl"),
      upstream.requests.map((request) => ({
        source: index,
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.authorization === null ? "none" : "basic",
      })),
    );
  }
  const openSourceConnections = [first.events.open(), second.events.open()];
  await first.stop();
  await second.stop();
  await Bun.write(join(run, "server.stdout.log"), stdout);
  await Bun.write(join(run, "server.stderr.log"), stderr);
  const cleanup = {
    exitCode: server.exitCode,
    openSourceConnections,
    serverPortClosed: port === 0 || listenerPIDs(port).length === 0,
    fakePortsClosed: [first, second].every(
      (upstream) => listenerPIDs(Number(new URL(upstream.url).port)).length === 0,
    ),
  };
  await writeJson(join(run, "cleanup.json"), cleanup);
  try {
    check(
      "owned-processes-and-ports-closed",
      (cleanup.exitCode === 0 || cleanup.exitCode === 130) &&
        cleanup.serverPortClosed &&
        cleanup.fakePortsClosed &&
        cleanup.openSourceConnections.every((count) => count === 0),
    );
  } catch (error) {
    failure ??= error;
  }
}
const evidence = (
  await Promise.all(
    ["frames.jsonl", "raw.frames.json", "server.stdout.log", "server.stderr.log"].map(
      async (name) =>
        Bun.file(join(run, name))
          .exists()
          .then((exists) => (exists ? Bun.file(join(run, name)).text() : "")),
    ),
  )
).join("\n");
try {
  check(
    "no-credentials-in-feed-or-logs",
    sources.every(
      (source) =>
        !evidence.includes(source.password) &&
        !evidence.includes(source.username) &&
        !evidence.includes(basicAuthorization(source.username, source.password)),
    ),
  );
} catch (error) {
  failure ??= error;
}
await writeJson(join(run, "checks.json"), recorder.checks);
await writeJson(join(run, "manifest.json"), {
  result: failure === undefined ? "PASS" : "FAIL",
  codeSHA: sha,
  clean,
  worktree,
  run,
  checks: recorder.checks.length,
  ...(failure === undefined
    ? {}
    : { error: failure instanceof Error ? failure.message : JSON.stringify(failure) }),
});
console.log(`${failure === undefined ? "PASS" : "FAIL"} multi-source run=${run}`);
if (failure !== undefined) {
  console.error(failure);
  process.exitCode = 1;
}

function feedConnected(feed: SessionFeed, index: number): boolean {
  return feed[index]?.health.kind === "connected";
}
