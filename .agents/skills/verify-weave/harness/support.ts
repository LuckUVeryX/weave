import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import {
  testPassword,
  type SessionFixture,
  type FakeActive,
} from "../../../../test/support/fake-opencode.ts";

const defaultRunRoot = join(tmpdir(), "opencode", "weave-verify");

export const skillDir = dirname(import.meta.dir);

const RunStateSchema = Schema.Struct({
  run: Schema.String,
  worktree: Schema.String,
  sha: Schema.String,
  startedAt: Schema.String,
  supervisor: Schema.Struct({ pid: Schema.Int, control: Schema.String }),
  server: Schema.Struct({
    runnerPid: Schema.Int,
    listenerPid: Schema.optionalKey(Schema.Int),
    port: Schema.Int,
    url: Schema.String,
  }),
  fake: Schema.Struct({ url: Schema.String }),
  startupConnections: Schema.Int,
});

export interface RunState extends Schema.Schema.Type<typeof RunStateSchema> {}

export const CheckSchema = Schema.Struct({
  feature: Schema.String,
  scenario: Schema.String,
  name: Schema.String,
  pass: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(Schema.String),
});

export interface Check extends Schema.Schema.Type<typeof CheckSchema> {}

const ControlStateSchema = Schema.Struct({
  server: Schema.Struct({
    pid: Schema.Int,
    port: Schema.Int,
    url: Schema.String,
    exitCode: Schema.NullOr(Schema.Int),
  }),
  connections: Schema.Int,
  openConnections: Schema.Int,
  fakeUrl: Schema.String,
  upstreamStopped: Schema.Boolean,
});

export interface ControlState extends Schema.Schema.Type<typeof ControlStateSchema> {}

const UpstreamRequestSchema = Schema.Struct({
  method: Schema.String,
  path: Schema.String,
  search: Schema.String,
  authorization: Schema.Boolean,
});

export interface UpstreamRequest extends Schema.Schema.Type<typeof UpstreamRequestSchema> {}

const RequestsPageSchema = Schema.Struct({
  next: Schema.Int,
  requests: Schema.Array(UpstreamRequestSchema),
});

interface RequestsPage extends Schema.Schema.Type<typeof RequestsPageSchema> {}

const AckSchema = Schema.Struct({ ok: Schema.Boolean });

interface ControlAck extends Schema.Schema.Type<typeof AckSchema> {}

const SigtermSchema = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Int),
  listenerClosed: Schema.Boolean,
  connections: Schema.Int,
  openConnections: Schema.Int,
});

interface SigtermResult extends Schema.Schema.Type<typeof SigtermSchema> {}

const CursorSchema = Schema.Struct({ cursor: Schema.Int });

const SessionFixtureSchema = Schema.Struct({
  id: Schema.String,
  parentID: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  directory: Schema.String,
  created: Schema.optionalKey(Schema.Finite),
  updated: Schema.optionalKey(Schema.Finite),
  busy: Schema.optionalKey(Schema.Finite),
  idle: Schema.optionalKey(Schema.Finite),
  viewed: Schema.optionalKey(Schema.Finite),
  outcome: Schema.optionalKey(Schema.Literals(["succeeded", "failed", "interrupted"])),
  archived: Schema.optionalKey(Schema.Boolean),
});

const FakeActiveSchema = Schema.Record(
  Schema.String,
  Schema.Struct({ type: Schema.Literal("running") }),
);

export const ControlSessionsBodySchema = Schema.Struct({
  sessions: Schema.optionalKey(Schema.Array(SessionFixtureSchema)),
  active: Schema.optionalKey(FakeActiveSchema),
  reset: Schema.optionalKey(Schema.Boolean),
});

export const SessionReadySchema = Schema.Struct({
  control: Schema.String,
  server: Schema.Struct({
    runnerPid: Schema.Int,
    listenerPid: Schema.optionalKey(Schema.Int),
    port: Schema.Int,
    url: Schema.String,
  }),
  fake: Schema.Struct({ url: Schema.String }),
  connections: Schema.Int,
});

export interface SessionReady extends Schema.Schema.Type<typeof SessionReadySchema> {}

export const ManifestSchema = Schema.Struct({
  result: Schema.String,
  codeSHA: Schema.String,
  worktree: Schema.String,
  run: Schema.String,
  startedAt: Schema.String,
  bunVersion: Schema.String,
  platform: Schema.String,
  commands: Schema.Struct({
    launch: Schema.String,
    doctor: Schema.String,
    feature: Schema.String,
    all: Schema.String,
    cleanup: Schema.String,
  }),
  features: Schema.Array(Schema.Struct({ feature: Schema.String, result: Schema.String })),
  finishedAt: Schema.optionalKey(Schema.String),
});

export interface Manifest extends Schema.Schema.Type<typeof ManifestSchema> {}

export interface ScenarioResult {
  readonly feature: string;
  readonly scenario: string;
  readonly result: "PASS" | "FAIL";
  readonly checks: ReadonlyArray<Check>;
  readonly requests: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly authorization: boolean;
  }>;
  readonly error?: string;
}

export interface CommandResult {
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export interface RawFrame {
  readonly mode: "chunk" | "failure";
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

type Decoder = Schema.ConstraintDecoder<unknown>;

export const decodeJson = <S extends Decoder>(schema: S, text: string): S["Type"] =>
  Schema.decodeUnknownSync(schema)(JSON.parse(text));

export const readJson = <S extends Decoder>(path: string, schema: S): S["Type"] =>
  decodeJson(schema, readFileSync(path, "utf8"));

export const uniqueRun = (): string => {
  const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return join(defaultRunRoot, `${stamp}-${process.pid}`);
};

export const ensureDir = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

export const ensureFile = (path: string): void => {
  if (!existsSync(path)) appendFileSync(path, "");
};

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const appendJsonl = (path: string, values: ReadonlyArray<unknown>): void => {
  if (values.length === 0) return;
  appendFileSync(path, `${values.map((value) => JSON.stringify(value)).join("\n")}\n`);
};

export const sanitize = (text: string): string =>
  text
    .replaceAll(testPassword, "[redacted-password]")
    .replace(/Basic [A-Za-z0-9+/=]+/g, "Basic [redacted]")
    .replace(/WEAVE_OPENCODE_PASSWORD=\S+/g, "WEAVE_OPENCODE_PASSWORD=[redacted]");

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error);

export const hasSecretValue = (text: string): boolean =>
  text.includes(testPassword) || /Basic [A-Za-z0-9+/=]{20,}/.test(text);

export const statePath = (run: string): string => join(run, "state.json");
export const manifestPath = (run: string): string => join(run, "manifest.json");
export const checksPath = (run: string): string => join(run, "checks.json");
export const doctorPath = (run: string): string => join(run, "doctor.json");
export const cleanupPath = (run: string): string => join(run, "cleanup.json");
export const postCleanupPath = (run: string): string => join(run, "post-cleanup.json");
export const framesPath = (run: string): string => join(run, "frames.jsonl");
export const requestsPath = (run: string): string => join(run, "requests.jsonl");
export const rawFramesPath = (run: string): string => join(run, "raw.frames.jsonl");
export const cursorPath = (run: string): string => join(run, "request-cursor.json");

export const readState = (run: string): RunState => readJson(statePath(run), RunStateSchema);

export const readCursor = (run: string): number => {
  if (!existsSync(cursorPath(run))) return 0;
  return readJson(cursorPath(run), CursorSchema).cursor;
};

export const writeCursor = async (run: string, cursor: number): Promise<void> => {
  await writeJson(cursorPath(run), { cursor });
};

export const readChecks = (run: string): ReadonlyArray<Check> =>
  existsSync(checksPath(run)) ? readJson(checksPath(run), Schema.Array(CheckSchema)) : [];

export const recordChecks = async (run: string, checks: ReadonlyArray<Check>): Promise<void> => {
  await writeJson(checksPath(run), [...readChecks(run), ...checks]);
};

export const controlRequest = async <S extends Decoder>(
  control: string,
  path: string,
  schema: S,
  init?: RequestInit,
): Promise<S["Type"]> => {
  const response = await fetch(new URL(path, control), init);
  if (!response.ok) {
    throw new Error(
      `Control request ${path} failed with ${response.status}: ${await response.text()}`,
    );
  }
  return decodeJson(schema, await response.text());
};

export const controlState = (control: string): Promise<ControlState> =>
  controlRequest(control, "/state", ControlStateSchema);

export const controlSessions = (
  control: string,
  sessions: ReadonlyArray<SessionFixture>,
  active: FakeActive,
  options: { readonly reset?: boolean } = {},
): Promise<ControlAck> =>
  controlRequest(control, "/sessions", AckSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessions,
      active,
      ...(options.reset === undefined ? {} : { reset: options.reset }),
    }),
  });

export const controlEvent = (control: string, event: unknown): Promise<ControlAck> =>
  controlRequest(control, "/event", AckSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

export const controlEnd = (control: string): Promise<ControlAck> =>
  controlRequest(control, "/end", AckSchema, { method: "POST" });

export const controlSeedFailure = (control: string, fail: boolean): Promise<ControlAck> =>
  controlRequest(control, "/seed-failure", AckSchema, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fail),
  });

export const controlStopUpstream = (control: string): Promise<ControlAck> =>
  controlRequest(control, "/stop-upstream", AckSchema, { method: "POST" });

export const controlSigterm = (control: string): Promise<SigtermResult> =>
  controlRequest(control, "/sigterm", SigtermSchema, { method: "POST" });

export const controlShutdown = (control: string): Promise<ControlAck> =>
  controlRequest(control, "/shutdown", AckSchema, { method: "POST" });

export const controlRequests = (control: string, since: number): Promise<RequestsPage> =>
  controlRequest(control, `/requests?since=${since}`, RequestsPageSchema);

export const runCommand = async (
  command: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Record<string, string | undefined>;
    readonly timeoutMs?: number;
  },
): Promise<CommandResult> => {
  const child = Bun.spawn({
    cmd: [...command],
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const outcome = await Promise.race([
    child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    Bun.sleep(timeoutMs).then(() => ({ kind: "timeout" as const })),
  ]);

  if (outcome.kind === "timeout") {
    child.kill("SIGTERM");
    await Bun.sleep(200);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }

  return {
    command,
    cwd: options.cwd,
    stdout: sanitize(await stdout),
    stderr: sanitize(await stderr),
    exitCode: child.exitCode ?? -1,
    timedOut: outcome.kind === "timeout",
  };
};

export const freePort = async (): Promise<number> => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = server.port;
  await server.stop(true);
  if (port === undefined) throw new Error("The reservation server did not report a port.");
  return port;
};

export const listenerPIDs = (port: number): ReadonlyArray<number> => {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  return result.stdout
    .toString()
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
};

export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const parentPID = (pid: number): number | undefined => {
  const result = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]);
  const parsed = Number(result.stdout.toString().trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
};

export const isDescendantOf = (pid: number, ancestor: number): boolean => {
  const seen = new Set<number>();
  let current = parentPID(pid);

  while (current !== undefined && !seen.has(current)) {
    if (current === ancestor) return true;
    seen.add(current);
    current = parentPID(current);
  }

  return false;
};

export const sortChecks = (checks: ReadonlyArray<Check>): ReadonlyArray<Check> =>
  [...checks].sort(
    (left, right) =>
      left.feature.localeCompare(right.feature) ||
      left.scenario.localeCompare(right.scenario) ||
      left.name.localeCompare(right.name),
  );
