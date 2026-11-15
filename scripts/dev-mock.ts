#!/usr/bin/env bun
import { join } from "node:path";
import {
  eventFrame,
  startFakeOpenCode,
  testPassword,
  type FakeActive,
  type SessionFixture,
} from "../test/support/fake-opencode.ts";

interface CaseDefinition {
  readonly name: string;
  readonly description: string;
  readonly apply: () => Promise<void>;
}

const root = join(import.meta.dir, "..");
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("WEAVE_")),
);

const fixture: { sessions: ReadonlyArray<SessionFixture>; active: FakeActive } = {
  sessions: [],
  active: {},
};
const preview = process.argv.includes("--preview");
const variantSources = process.argv.includes("--variant-sources");
const speciesFixture = (id: string): ReadonlyArray<SessionFixture> => [
  {
    id: `ses_${id}_root`,
    title: `${id} root`,
    directory: `/tmp/${id}`,
    updated: 1_700_000_100_000,
  },
  {
    id: `ses_${id}_child`,
    parentID: `ses_${id}_root`,
    title: `${id} child`,
    directory: `/tmp/${id}`,
    updated: 1_700_000_050_000,
  },
];
if (variantSources) fixture.sessions = speciesFixture("local");
const upstream = startFakeOpenCode(fixture, {
  auth: { username: "opencode", password: testPassword },
});
const sourceHealth = process.argv.includes("--source-health");
const startingGate = Promise.withResolvers<void>();
const recoveringGate = Promise.withResolvers<void>();
let recoveringBlocked = false;
const healthSources = sourceHealth
  ? [
      {
        id: "starting",
        upstream: startFakeOpenCode(
          {},
          {
            beforeRequest: async (url) => {
              if (url.pathname === "/api/session") await startingGate.promise;
            },
          },
        ),
      },
      {
        id: "recovering",
        upstream: startFakeOpenCode(
          {},
          {
            beforeRequest: async (url) => {
              if (recoveringBlocked && url.pathname === "/api/session") {
                await recoveringGate.promise;
              }
            },
          },
        ),
      },
      { id: "offline", upstream: startFakeOpenCode({ status: 401, body: testPassword }) },
    ]
  : [];
const extraSources = [
  ...healthSources,
  ...(variantSources
    ? [
        { id: "iu", upstream: startFakeOpenCode({ sessions: speciesFixture("iu") }) },
        { id: "mj", upstream: startFakeOpenCode({ sessions: speciesFixture("mj") }) },
      ]
    : []),
];

const server = Bun.spawn({
  cmd: ["bun", "run", "serve"],
  cwd: root,
  env: {
    ...cleanEnv,
    WEAVE_HOST: "127.0.0.1",
    WEAVE_PORT: "0",
    WEAVE_OPENCODE_URL: upstream.url,
    WEAVE_OPENCODE_PASSWORD: testPassword,
    ...(sourceHealth || variantSources
      ? {
          WEAVE_OPENCODE_SOURCES: JSON.stringify(
            [{ id: "local", upstream }, ...extraSources].map(({ id, upstream: source }) => ({
              id,
              url: source.url,
              username: "opencode",
              password: testPassword,
            })),
          ),
        }
      : {}),
  },
  stdout: "pipe",
  stderr: "pipe",
});

let vite: ReturnType<typeof Bun.spawn> | undefined;
let control: ReturnType<typeof Bun.serve> | undefined;
let stopping = false;

const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;

  if (vite !== undefined && vite.exitCode === null) vite.kill("SIGTERM");
  if (server.exitCode === null) server.kill("SIGTERM");
  startingGate.resolve();
  recoveringGate.resolve();
  await upstream.stop();
  await Promise.all(extraSources.map((source) => source.upstream.stop()));
  if (control !== undefined) await control.stop(true);
  await Promise.race([Promise.all([vite?.exited, server.exited]), Bun.sleep(1_000)]);
};

const shutdown = async (): Promise<void> => {
  await stop();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  let serverPort: number | undefined;
  let resolvePort: (port: number) => void = () => {};
  const portReady = new Promise<number>((resolve) => {
    resolvePort = resolve;
  });

  const drain = async (
    stream: ReadableStream<Uint8Array>,
    onText: (text: string) => void,
  ): Promise<void> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      process.stderr.write(`[weave] ${text}`);
      onText(text);
    }
  };

  let output = "";
  void drain(server.stdout, (text) => {
    output += text;
    const match = /Listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (match?.[1] !== undefined) resolvePort(Number(match[1]));
  });
  void drain(server.stderr, () => {});

  const port = await Promise.race([portReady, Bun.sleep(15_000).then(() => undefined)]);

  if (port === undefined) {
    throw new Error(`The Weave server did not report its listener within 15 s.\n${output}`);
  }

  serverPort = port;
  const weaveUrl = `http://127.0.0.1:${serverPort}`;

  const reservePort = async (): Promise<number> => {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const reserved = reservation.port;
    await reservation.stop(true);

    if (reserved === undefined) throw new Error("The port reservation did not report a port.");
    return reserved;
  };

  const tailscaleIPv4 = (): string | undefined => {
    const result = Bun.spawnSync(["tailscale", "ip", "-4"]);
    if (result.exitCode !== 0) return undefined;

    const address = result.stdout.toString().trim().split("\n")[0];
    return address === undefined || address.length === 0 ? undefined : address;
  };

  const vitePort = await reservePort();
  const host = process.env.WEAVE_DEV_HOST ?? tailscaleIPv4() ?? "127.0.0.1";
  const serving = preview ? "preview" : "dev";
  vite = Bun.spawn({
    cmd: ["bun", "run", serving, "--", "--host", host, "--port", String(vitePort), "--strictPort"],
    cwd: root,
    env: { ...cleanEnv, WEAVE_DEV_RPC_URL: weaveUrl },
    stdout: "inherit",
    stderr: "inherit",
  });

  const uiUrl = `http://${host}:${vitePort}/`;
  const baseTime = Date.now();
  const directory = "/Users/mira/Code";

  const baseSessions: ReadonlyArray<SessionFixture> = [
    {
      id: "ses_design",
      title: "Design system audit",
      directory: `${directory}/design-system`,
      updated: baseTime - 30_000,
    },
    {
      id: "ses_payments",
      title: "Checkout regression",
      directory: `${directory}/payments`,
      updated: baseTime - 120_000,
      outcome: "succeeded",
    },
    {
      id: "ses_payments_trace",
      parentID: "ses_payments",
      title: "Trace slow card auth",
      directory: `${directory}/payments`,
      updated: baseTime - 100_000,
    },
    {
      id: "ses_harbor",
      title: "Release notes",
      directory: `${directory}/weave`,
      updated: baseTime - 300_000,
    },
    {
      id: "ses_harbor_mid",
      parentID: "ses_harbor",
      title: "Draft changes",
      directory: `${directory}/weave`,
      updated: baseTime - 280_000,
    },
    {
      id: "ses_harbor_grand",
      parentID: "ses_harbor_mid",
      title: "Collect changelog",
      directory: `${directory}/weave`,
      updated: baseTime - 60_000,
    },
    {
      id: "ses_legacy",
      title: "Payments v1 cleanup",
      directory: `${directory}/payments`,
      updated: baseTime - 86_400_000,
      outcome: "failed",
    },
  ];

  const baseActive: FakeActive = {
    ses_design: { type: "running" },
    ses_payments_trace: { type: "running" },
    ses_harbor_grand: { type: "running" },
  };

  const activeWithoutTrace: FakeActive = {
    ses_design: { type: "running" },
    ses_harbor_grand: { type: "running" },
  };

  let tracked: ReadonlyArray<SessionFixture> = [];
  let currentCase = "empty";
  let sequence = 0;

  const emit = (type: string, data: Readonly<Record<string, unknown>>): void => {
    upstream.events.send(
      eventFrame(type, data, {
        id: `evt_dev_${++sequence}`,
        created: Date.now(),
        seq: sequence,
      }),
    );
  };

  const orderedForParentsFirst = (
    sessions: ReadonlyArray<SessionFixture>,
  ): ReadonlyArray<SessionFixture> => {
    const byID = new Map(sessions.map((session) => [session.id, session]));
    const depth = (session: SessionFixture): number => {
      let current = session;
      let value = 0;

      while (current.parentID !== undefined) {
        const parent = byID.get(current.parentID);
        if (parent === undefined) break;
        current = parent;
        value += 1;
      }

      return value;
    };

    return [...sessions].sort((left, right) => depth(left) - depth(right));
  };

  const reset = async (
    sessions: ReadonlyArray<SessionFixture>,
    active: FakeActive,
  ): Promise<void> => {
    for (const session of orderedForParentsFirst(tracked).toReversed()) {
      emit("session.deleted", { sessionID: session.id });
    }
    if (tracked.length > 0) await Bun.sleep(30);

    upstream.setSessions(sessions);
    fixture.active = active;
    tracked = sessions;

    for (const session of orderedForParentsFirst(sessions)) {
      emit("session.created", {
        sessionID: session.id,
        projectID: "prj_dev",
        location: { directory: session.directory },
        slug: session.id,
        version: "0",
      });
    }
    await Bun.sleep(30);

    for (const session of sessions) {
      if (active[session.id] !== undefined) {
        emit("session.execution.started", { sessionID: session.id });
      }
    }
    await Bun.sleep(60);
  };

  const cases: ReadonlyArray<CaseDefinition> = [
    ...(sourceHealth
      ? [
          {
            name: "source-health",
            description:
              "Four ordered sources, including empty connecting and unavailable sources.",
            apply: async () => {
              recoveringBlocked = true;
              extraSources.find((source) => source.id === "recovering")?.upstream.events.end();
            },
          },
          {
            name: "sources-recovered",
            description: "Release the connecting and reconnecting source seeds.",
            apply: async () => {
              startingGate.resolve();
              recoveringGate.resolve();
            },
          },
        ]
      : []),
    {
      name: "empty",
      description: "No sessions.",
      apply: () => reset([], {}),
    },
    {
      name: "current",
      description: "Four roots with every descendant visible and three running sessions.",
      apply: () => reset(baseSessions, baseActive),
    },
    {
      name: "running",
      description: "An idle child starts a run and reports running.",
      apply: async () => {
        await reset(baseSessions, activeWithoutTrace);
        fixture.active = baseActive;
        emit("session.execution.started", { sessionID: "ses_payments_trace" });
        await Bun.sleep(80);
      },
    },
    {
      name: "specimen-context",
      description: "An empty session title and a long title and directory for placard checks.",
      apply: () =>
        reset(
          baseSessions.map((session) =>
            session.id === "ses_payments_trace"
              ? { ...session, title: "" }
              : session.id === "ses_design"
                ? {
                    ...session,
                    title:
                      "Inspect the selected session without losing its place in the shared tank, even when its real title runs across several lines",
                    directory:
                      "/Users/mira/Code/a-project-with-a-long-directory-name/another-long-component/weave",
                  }
                : session,
          ),
          baseActive,
        ),
    },
    {
      name: "crowded-family",
      description: "One root, 698 children and one grandchild, with two running sessions.",
      apply: () =>
        reset(
          [
            { id: "ses_family", title: "Habitat family", directory, updated: baseTime },
            ...Array.from({ length: 698 }, (_, index) => ({
              id: `ses_family_${index}`,
              parentID: "ses_family",
              title: `Family child ${index}`,
              directory,
              updated: baseTime,
            })),
            {
              id: "ses_family_grand",
              parentID: "ses_family_690",
              title: "Family grandchild",
              directory,
              updated: baseTime,
            },
          ],
          { ses_family_0: { type: "running" }, ses_family_2: { type: "running" } },
        ),
    },
    {
      name: "idle",
      description: "A running child becomes idle and remains visible.",
      apply: async () => {
        await reset(baseSessions, baseActive);
        fixture.active = activeWithoutTrace;
        emit("session.execution.succeeded", { sessionID: "ses_payments_trace" });
        await Bun.sleep(80);
      },
    },
    {
      name: "attention",
      description: "Two approvals on one descendant and one question on another.",
      apply: async () => {
        await reset(baseSessions, baseActive);
        emit("permission.asked", {
          id: "per_dev_1",
          sessionID: "ses_payments_trace",
          action: "read",
          resources: ["*"],
        });
        emit("permission.asked", {
          id: "per_dev_2",
          sessionID: "ses_payments_trace",
          action: "read",
          resources: ["*"],
        });
        emit("form.created", {
          form: {
            id: "frm_dev_1",
            sessionID: "ses_harbor_grand",
            title: "Which changelog section?",
            metadata: { kind: "question" },
            fields: [{ key: "answer", type: "string" }],
          },
        });
        await Bun.sleep(80);
      },
    },
    ...(variantSources
      ? [
          {
            name: "variant-attention",
            description: "A pending permission on the iu source root, leaving six bodies.",
            apply: async () => {
              const iu = extraSources.find((source) => source.id === "iu");
              if (iu === undefined) return;
              iu.upstream.events.send(
                eventFrame(
                  "permission.asked",
                  {
                    id: "per_iu_1",
                    sessionID: "ses_iu_root",
                    action: "read",
                    resources: ["*"],
                  },
                  { id: "evt_iu_attention", created: Date.now(), seq: 1 },
                ),
              );
            },
          },
          {
            name: "variant-delete",
            description: "The iu child leaves without reseeding local, leaving five bodies.",
            apply: async () => {
              const iu = extraSources.find((source) => source.id === "iu");
              if (iu === undefined) throw new Error("variant-delete requires the iu source");
              iu.upstream.setSessions(
                speciesFixture("iu").filter((session) => session.id !== "ses_iu_child"),
              );
              iu.upstream.events.send(
                eventFrame(
                  "session.deleted",
                  { sessionID: "ses_iu_child" },
                  { id: "evt_iu_delete", created: Date.now(), seq: 2 },
                ),
              );
              await Bun.sleep(80);
            },
          },
        ]
      : []),
    {
      name: "archive",
      description: "The Release notes family leaves after its root is archived.",
      apply: async () => {
        await reset(baseSessions, baseActive);
        const archived = tracked.map((session) =>
          session.id === "ses_harbor" ? { ...session, archived: true } : session,
        );
        upstream.setSessions(archived);
        tracked = archived;
        emit("session.archived", { sessionID: "ses_harbor" });
        await Bun.sleep(80);
      },
    },
    {
      name: "delete",
      description: "A running child is deleted and removed from the list.",
      apply: async () => {
        await reset(baseSessions, baseActive);
        const next = tracked.filter((session) => session.id !== "ses_payments_trace");
        upstream.setSessions(next);
        fixture.active = activeWithoutTrace;
        tracked = next;
        emit("session.deleted", { sessionID: "ses_payments_trace" });
        await Bun.sleep(80);
      },
    },
    {
      name: "disconnect",
      description:
        "Close the upstream event stream. The source reconnects and the school stays visible.",
      apply: async () => {
        upstream.events.end();
        await Bun.sleep(80);
      },
    },
  ];

  control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/state") {
        return Response.json({
          case: currentCase,
          sessions: tracked,
          active: fixture.active,
          requests: upstream.requests.length,
          ui: uiUrl,
          rpc: weaveUrl,
          fake: upstream.url,
          sources: extraSources.map(({ id, upstream: source }) => ({ id, url: source.url })),
        });
      }

      if (url.pathname === "/cases") {
        return Response.json({
          cases: cases.map(({ name, description }) => ({ name, description })),
        });
      }

      if (request.method === "POST" && url.pathname.startsWith("/case/")) {
        const name = decodeURIComponent(url.pathname.slice("/case/".length));
        const found = cases.find((candidate) => candidate.name === name);

        if (found === undefined) {
          return Response.json({ error: `Unknown case ${name}.` }, { status: 404 });
        }

        try {
          await found.apply();
          currentCase = name;
          return Response.json({ case: name });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 500 });
        }
      }

      return new Response("not found", { status: 404 });
    },
  });

  const controlPort = control.port;
  if (controlPort === undefined) throw new Error("The mock control server did not report a port.");

  const waitForUI = async (): Promise<void> => {
    const started = Date.now();

    while (Date.now() - started < 15_000) {
      try {
        const response = await fetch(uiUrl);
        if (response.ok) return;
      } catch {}

      await Bun.sleep(100);
    }

    throw new Error(`The Vite client did not answer at ${uiUrl} within 15 s.`);
  };

  await waitForUI();

  console.log(
    `DEV_READY ${JSON.stringify({
      ui: uiUrl,
      control: `http://127.0.0.1:${controlPort}`,
      rpc: weaveUrl,
      fake: upstream.url,
      sourceFakes: extraSources.map((source) => source.upstream.url),
    })}`,
  );
} catch (error) {
  await stop();
  throw error;
}
