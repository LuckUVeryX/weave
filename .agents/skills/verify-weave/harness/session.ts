#!/usr/bin/env bun
import { join } from "node:path";
import { Schema } from "effect";
import {
  eventFrame,
  startFakeOpenCode,
  testPassword,
  type FakeActive,
  type SessionFixture,
} from "../../../../test/support/fake-opencode.ts";
import {
  ControlSessionsBodySchema,
  ensureDir,
  listenerPIDs,
  writeJson,
  type ControlState,
} from "./support.ts";

interface Options {
  readonly worktree: string;
  readonly run: string;
  readonly sha: string;
}

const options = (): Options => {
  const values = new Map<string, string>();
  const args = Bun.argv.slice(2);

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined) break;
    values.set(key, value);
  }

  const worktree = values.get("--worktree");
  const run = values.get("--run");
  const sha = values.get("--sha");
  if (worktree === undefined || run === undefined || sha === undefined) {
    throw new Error("session.ts requires --worktree, --run, and --sha.");
  }

  return { worktree, run, sha };
};

const { worktree, run, sha } = options();
ensureDir(run);

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("WEAVE_")),
);

const startupBase = 1_700_000_000_000;
const startupSessions: ReadonlyArray<SessionFixture> = [
  ...Array.from({ length: 501 }, (_, index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      id: `ses_start_${suffix}`,
      title: `Startup root ${suffix}`,
      directory: `/work/startup-${suffix}`,
      updated: startupBase + index,
    };
  }),
  {
    id: "ses_start_child",
    parentID: "ses_start_000",
    title: "Startup child",
    directory: "/work/startup-000",
    updated: startupBase + 900_000,
    busy: startupBase + 800_000,
  },
];
const startupActive: FakeActive = { ses_start_child: { type: "running" } };

const fixture: { sessions: ReadonlyArray<SessionFixture>; active: FakeActive; status?: number } = {
  sessions: startupSessions,
  active: startupActive,
};
const upstream = startFakeOpenCode(fixture, {
  auth: { username: "opencode", password: testPassword },
});
let tracked = startupSessions;
let upstreamStopped = false;
let controlSequence = 0;

const emit = (type: string, data: Readonly<Record<string, unknown>>): void => {
  controlSequence += 1;
  upstream.events.send(
    eventFrame(type, data, {
      id: `evt_control_${controlSequence}`,
      created: Date.now(),
      seq: controlSequence,
    }),
  );
};

const orderedParentsFirst = (
  sessions: ReadonlyArray<SessionFixture>,
): ReadonlyArray<SessionFixture> => {
  const byID = new Map(sessions.map((session) => [session.id, session]));
  const depth = (session: SessionFixture): number => {
    let current = session;
    let value = 0;
    const seen = new Set<string>();

    while (current.parentID !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byID.get(current.parentID);
      if (parent === undefined) break;
      current = parent;
      value += 1;
    }

    return value;
  };

  return [...sessions].sort((left, right) => depth(left) - depth(right));
};

const orderedChildrenFirst = (
  sessions: ReadonlyArray<SessionFixture>,
): ReadonlyArray<SessionFixture> => orderedParentsFirst(sessions).toReversed();

const stdoutSink = Bun.file(join(run, "server.stdout.log")).writer();
const stderrSink = Bun.file(join(run, "server.stderr.log")).writer();
const decoder = new TextDecoder();
let stdoutBuffer = "";
let stderrBuffer = "";
let serverPort: number | undefined;

const server = Bun.spawn({
  cmd: ["bun", "run", "serve"],
  cwd: worktree,
  env: {
    ...cleanEnv,
    WEAVE_HOST: "127.0.0.1",
    WEAVE_PORT: "0",
    WEAVE_OPENCODE_URL: upstream.url,
    WEAVE_OPENCODE_PASSWORD: testPassword,
  },
  stdout: "pipe",
  stderr: "pipe",
});

const drain = async (
  stream: ReadableStream<Uint8Array>,
  sink: ReturnType<typeof Bun.file.prototype.writer>,
  onText: (text: string) => void,
): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      await sink.write(value);
      onText(decoder.decode(value, { stream: true }));
    }
  } finally {
    await sink.end();
  }
};

let resolvePort: (port: number) => void = () => {};
const portReady = new Promise<number>((resolve) => {
  resolvePort = resolve;
});

const readServerStdout = (text: string): void => {
  stdoutBuffer += text;
  const match = /Listening on (http:\/\/\S+)/.exec(stdoutBuffer);
  if (match === null) return;
  const url = new URL(match[1] as string);
  const port = Number(url.port);
  if (Number.isInteger(port) && port > 0) resolvePort(port);
};

const readServerStderr = (text: string): void => {
  stderrBuffer += text;
};

void drain(server.stdout, stdoutSink, readServerStdout);
void drain(server.stderr, stderrSink, readServerStderr);

const shutdown = async (): Promise<void> => {
  await control.stop(true);
  if (!upstreamStopped) {
    upstreamStopped = true;
    await upstream.stop();
  }

  if (server.exitCode === null) {
    server.kill("SIGTERM");
    const outcome = await Promise.race([
      server.exited,
      Bun.sleep(5_000).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout" && server.exitCode === null) {
      server.kill("SIGKILL");
      await server.exited;
    }
  }

  await writeJson(join(run, "supervisor.json"), {
    sha,
    worktree,
    serverExitCode: server.exitCode,
    upstreamStopped,
    stdoutTail: stdoutBuffer.slice(-2_000),
    stderrTail: stderrBuffer.slice(-2_000),
  });
  process.exit(0);
};

const control = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/state") {
        const state: ControlState = {
          server: {
            pid: server.pid,
            port: serverPort ?? 0,
            url: serverPort === undefined ? "" : `http://127.0.0.1:${serverPort}`,
            exitCode: server.exitCode,
          },
          connections: upstream.events.connections(),
          openConnections: upstream.events.open(),
          fakeUrl: upstream.url,
          upstreamStopped,
        };
        return Response.json(state);
      }

      if (url.pathname === "/requests") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const requests = upstream.requests
          .slice(Number.isInteger(since) ? since : 0)
          .map((item) => {
            const parsed = new URL(item.url);
            return {
              method: item.method,
              path: parsed.pathname,
              search: parsed.search,
              authorization: item.authorization !== null,
            };
          });
        return Response.json({ next: upstream.requests.length, requests });
      }

      if (url.pathname === "/sessions" && request.method === "POST") {
        const body = Schema.decodeUnknownSync(ControlSessionsBodySchema)(await request.json());
        const nextSessions = body.sessions ?? [];
        const nextActive = body.active ?? {};

        if (body.reset === false) {
          upstream.setSessions(nextSessions);
          fixture.sessions = nextSessions;
          fixture.active = nextActive;
          tracked = nextSessions;
          return Response.json({ ok: true });
        }

        for (const session of orderedChildrenFirst(tracked)) {
          emit("session.deleted", { sessionID: session.id });
        }

        upstream.setSessions(nextSessions);
        fixture.sessions = nextSessions;
        fixture.active = nextActive;
        tracked = nextSessions;

        for (const session of orderedParentsFirst(nextSessions)) {
          emit("session.created", {
            sessionID: session.id,
            projectID: "prj_verify",
            location: { directory: session.directory },
            slug: session.id,
            version: "0",
          });
        }

        for (const id of Object.keys(nextActive)) {
          if (nextSessions.some((session) => session.id === id)) {
            emit("session.execution.started", { sessionID: id });
          }
        }

        return Response.json({ ok: true });
      }

      if (url.pathname === "/event" && request.method === "POST") {
        upstream.events.send(await request.json());
        return Response.json({ ok: true });
      }

      if (url.pathname === "/end" && request.method === "POST") {
        upstream.events.end();
        return Response.json({ ok: true });
      }

      if (url.pathname === "/seed-failure" && request.method === "POST") {
        const fail = Schema.decodeUnknownSync(Schema.Boolean)(await request.json());
        if (fail) fixture.status = 503;
        else delete fixture.status;
        return Response.json({ ok: true });
      }

      if (url.pathname === "/stop-upstream" && request.method === "POST") {
        if (!upstreamStopped) {
          upstreamStopped = true;
          await upstream.stop();
        }
        return Response.json({ ok: true });
      }

      if (url.pathname === "/sigterm" && request.method === "POST") {
        if (server.exitCode === null) server.kill("SIGTERM");
        await Promise.race([server.exited, Bun.sleep(5_000).then(() => "timeout" as const)]);
        if (server.exitCode === null) {
          server.kill("SIGKILL");
          await server.exited;
        }
        const started = Date.now();
        while (Date.now() - started < 2_000 && listenerPIDs(serverPort ?? 0).length > 0) {
          await Bun.sleep(50);
        }
        return Response.json({
          exitCode: server.exitCode,
          listenerClosed: listenerPIDs(serverPort ?? 0).length === 0,
          connections: upstream.events.connections(),
          openConnections: upstream.events.open(),
        });
      }

      if (url.pathname === "/shutdown" && request.method === "POST") {
        setTimeout(() => void shutdown(), 50);
        return Response.json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  },
});

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

const stopIfServerDied = server.exited.then((exitCode) => {
  if (serverPort === undefined) {
    console.error(
      `The Weave server exited before it reported its listener (exit ${exitCode}).\n${stderrBuffer}`,
    );
    process.exit(1);
  }
});
void stopIfServerDied;

const port = await Promise.race([portReady, Bun.sleep(15_000).then(() => undefined)]);

if (port === undefined) {
  server.kill("SIGTERM");
  console.error(`The Weave server did not report its listener within 15 s.\n${stderrBuffer}`);
  process.exit(1);
}

serverPort = port;
const listenerPid = listenerPIDs(port)[0];
const controlPort = control.port;
if (controlPort === undefined) {
  console.error("The control server did not report its port.");
  process.exit(1);
}

const waitForStartupSeed = async (): Promise<void> => {
  const started = Date.now();
  let settledAt = 0;
  let settledCount = -1;

  while (Date.now() - started < 15_000) {
    const paths = upstream.requests.map((request) => new URL(request.url).pathname);
    const hasList = paths.includes("/api/session");
    const hasActive = paths.includes("/api/session/active");
    const count = upstream.requests.length;

    if (upstream.events.connections() >= 1 && hasList && hasActive) {
      if (count !== settledCount) {
        settledCount = count;
        settledAt = Date.now();
      } else if (Date.now() - settledAt >= 150) {
        return;
      }
    }

    await Bun.sleep(50);
  }

  throw new Error(
    "The Weave server did not open one source connection and seed the collection before any frontend.",
  );
};

await waitForStartupSeed();

console.log(
  `SESSION_READY ${JSON.stringify({
    control: `http://127.0.0.1:${controlPort}`,
    server: {
      runnerPid: server.pid,
      listenerPid,
      port,
      url: `http://127.0.0.1:${port}`,
    },
    fake: { url: upstream.url },
    connections: upstream.events.connections(),
    sha,
    worktree,
    run,
  })}`,
);
