#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectFeed } from "./client.ts";
import { featureRunners, type FeatureEnv } from "./scenarios.ts";
import {
  appendJsonl,
  checksPath,
  cleanupPath,
  controlRequests,
  controlShutdown,
  controlSigterm,
  controlState,
  decodeJson,
  doctorPath,
  ensureDir,
  ensureFile,
  errorMessage,
  framesPath,
  hasSecretValue,
  isDescendantOf,
  listenerPIDs,
  manifestPath,
  ManifestSchema,
  postCleanupPath,
  processAlive,
  rawFramesPath,
  readChecks,
  readCursor,
  readJson,
  readState,
  recordChecks,
  requestsPath,
  sanitize,
  SessionReadySchema,
  skillDir,
  sortChecks,
  statePath,
  uniqueRun,
  writeCursor,
  writeJson,
  type Check,
  type Manifest,
  type RunState,
  type SessionReady,
  type UpstreamRequest,
} from "./support.ts";

const features = ["snapshot", "live-updates-attention", "lifecycle", "rpc-errors"] as const;

type Feature = (typeof features)[number];

interface Options {
  readonly worktree: string;
  readonly run: string;
}

const shellQuote = (value: string): string => (value.includes(" ") ? `"${value}"` : value);

const parseOptions = (args: ReadonlyArray<string>, fallbackRun?: string): Options => {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    const value = args[index + 1];
    if (key !== undefined && key.startsWith("--") && value !== undefined) {
      values.set(key, value);
      index += 1;
    }
  }

  const worktree = values.get("--worktree") ?? process.cwd();
  const run = values.get("--run") ?? fallbackRun ?? uniqueRun();
  return { worktree, run };
};

const gitSHA = (worktree: string): string => {
  const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "HEAD"]);
  if (result.exitCode !== 0) throw new Error(`Could not read the git SHA for ${worktree}.`);
  return result.stdout.toString().trim();
};

const requiredEvidence = (run: string, manifest: Manifest): ReadonlyArray<string> => {
  const recordedFeatures = new Set(manifest.features.map((entry) => entry.feature));
  const scenarios = new Set(
    readChecks(run)
      .filter((check) => recordedFeatures.has(check.feature))
      .map((check) => check.scenario),
  );
  return [
    statePath(run),
    manifestPath(run),
    checksPath(run),
    doctorPath(run),
    framesPath(run),
    requestsPath(run),
    rawFramesPath(run),
    ...[...scenarios].map((scenario) => join(run, "scenarios", `${scenario}.json`)),
    ...(recordedFeatures.has("rpc-errors")
      ? ["snapshot", "raw-protocol", "closed-transport", "missing-credentials"].map((name) =>
          join(run, "direct", `${name}.json`),
        )
      : []),
    join(run, "server.stdout.log"),
    join(run, "server.stderr.log"),
    join(run, "supervisor.json"),
    cleanupPath(run),
  ];
};

const initialManifest = (run: string, worktree: string, sha: string): Manifest => ({
  result: "RUNNING",
  codeSHA: sha,
  worktree,
  run,
  startedAt: new Date().toISOString(),
  bunVersion: Bun.version,
  platform: `${process.platform}/${process.arch}`,
  commands: {
    launch: `bun run verify launch --run ${shellQuote(run)}`,
    doctor: `bun run verify doctor --run ${shellQuote(run)}`,
    feature: `bun run verify feature <${features.join("|")}> --run ${shellQuote(run)}`,
    all: `bun run verify all --run ${shellQuote(run)}`,
    cleanup: `bun run verify cleanup --run ${shellQuote(run)}`,
  },
  features: [] as ReadonlyArray<{ feature: string; result: string }>,
});

const prepareEvidence = (run: string): void => {
  ensureDir(run);
  ensureDir(join(run, "scenarios"));
  ensureDir(join(run, "direct"));
  ensureFile(framesPath(run));
  ensureFile(requestsPath(run));
  ensureFile(rawFramesPath(run));
  ensureFile(join(run, "server.stdout.log"));
  ensureFile(join(run, "server.stderr.log"));
  if (!existsSync(checksPath(run))) void Bun.write(checksPath(run), "[]\n");
};

const launch = async (worktree: string, run: string): Promise<RunState> => {
  if (existsSync(statePath(run))) {
    throw new Error(`The run directory already has state: ${statePath(run)}`);
  }

  prepareEvidence(run);
  const sha = gitSHA(worktree);
  await writeJson(manifestPath(run), initialManifest(run, worktree, sha));

  const supervisor = Bun.spawn({
    cmd: [
      "bun",
      join(skillDir, "harness", "session.ts"),
      "--worktree",
      worktree,
      "--run",
      run,
      "--sha",
      sha,
    ],
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrReader = supervisor.stderr.getReader();
  const stdoutReader = supervisor.stdout.getReader();
  const decoder = new TextDecoder();
  let stderrBuffer = "";
  let stdoutBuffer = "";
  const stderrDrain = (async () => {
    try {
      while (true) {
        const { done, value } = await stderrReader.read();
        if (done) return;
        stderrBuffer += decoder.decode(value, { stream: true });
      }
    } catch {
      return;
    }
  })();

  const deadline = Date.now() + 15_000;
  let readyPayload: SessionReady | undefined;
  let pending = stdoutReader.read();

  while (readyPayload === undefined && Date.now() < deadline && supervisor.exitCode === null) {
    const next = await Promise.race([pending, Bun.sleep(250).then(() => undefined)]);
    if (next === undefined) continue;
    pending = stdoutReader.read();
    if (next.done) break;
    stdoutBuffer += decoder.decode(next.value, { stream: true });
    const line = stdoutBuffer.split("\n").find((entry) => entry.startsWith("SESSION_READY "));
    if (line !== undefined) {
      readyPayload = decodeJson(SessionReadySchema, line.slice("SESSION_READY ".length));
    }
  }

  await stdoutReader.cancel().catch(() => {});
  await stderrReader.cancel().catch(() => {});
  void stderrDrain;

  if (readyPayload === undefined) {
    supervisor.kill("SIGTERM");
    await Bun.sleep(200);
    if (supervisor.exitCode === null) supervisor.kill("SIGKILL");
    await supervisor.exited;
    const stderr = sanitize(stderrBuffer);
    await writeJson(join(run, "launch-failure.json"), {
      result: "FAIL",
      reason: "The supervisor did not report readiness within 15 s.",
      stderr,
    });
    throw new Error(`Verification launch failed. See ${join(run, "launch-failure.json")}`);
  }

  const state: RunState = {
    run,
    worktree,
    sha,
    startedAt: new Date().toISOString(),
    supervisor: { pid: supervisor.pid, control: readyPayload.control },
    server: {
      runnerPid: readyPayload.server.runnerPid,
      ...(readyPayload.server.listenerPid === undefined
        ? {}
        : { listenerPid: readyPayload.server.listenerPid }),
      port: readyPayload.server.port,
      url: readyPayload.server.url,
    },
    fake: { url: readyPayload.fake.url },
    startupConnections: readyPayload.connections,
  };
  await writeJson(statePath(run), state);
  return state;
};

interface DoctorCheck {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const doctor = async (run: string): Promise<boolean> => {
  const state = readState(run);
  const checks: Array<DoctorCheck> = [];

  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  add(
    "supervisor-alive",
    processAlive(state.supervisor.pid),
    `supervisor pid ${state.supervisor.pid}`,
  );

  const live = await controlState(state.supervisor.control).catch((error: unknown) => {
    add("control-responsive", false, String(error));
    return undefined;
  });
  if (live !== undefined) {
    add(
      "control-responsive",
      live.server.pid === state.server.runnerPid && live.server.port === state.server.port,
      `control reported runner ${live.server.pid} on ${live.server.port}`,
    );
  }

  add(
    "server-runner-alive",
    processAlive(state.server.runnerPid),
    `server runner pid ${state.server.runnerPid}`,
  );

  const listeners = listenerPIDs(state.server.port);
  add(
    "actual-listener-owned",
    listeners.some(
      (pid) =>
        pid === state.server.runnerPid ||
        pid === state.server.listenerPid ||
        isDescendantOf(pid, state.server.runnerPid),
    ),
    `listener pids ${listeners.join(", ") || "none"} on port ${state.server.port}`,
  );

  const serverLog = readFileSync(join(run, "server.stdout.log"), "utf8");
  add(
    "listener-log",
    serverLog.includes(`Listening on http://127.0.0.1:${state.server.port}`),
    "the server log names the actual ephemeral port",
  );

  add(
    "code-sha",
    gitSHA(state.worktree) === state.sha,
    `worktree ${state.worktree} is at ${state.sha}`,
  );

  const status = Bun.spawnSync(["git", "-C", state.worktree, "status", "--porcelain"]);
  const dirty = status.stdout.toString().trim();
  add(
    "worktree-clean",
    status.exitCode === 0 && dirty === "",
    dirty === "" ? "no working tree changes" : `working tree changes: ${dirty}`,
  );

  add(
    "source-connection-live",
    live !== undefined &&
      live.connections >= state.startupConnections &&
      live.openConnections === 1,
    `source open ${live?.openConnections ?? "unknown"}, cumulative ${
      live?.connections ?? "unknown"
    }, startup ${state.startupConnections}`,
  );

  const history = await controlRequests(state.supervisor.control, 0);
  const feed = await collectFeed(state.server.url, 10_000).catch((error: unknown) => {
    add("rpc-live-feed", false, String(error));
    return undefined;
  });
  if (feed !== undefined) {
    add(
      "rpc-live-feed",
      feed.length === 1 && feed[0]?.id === "local" && feed[0].health.kind === "connected",
      `the typed client decoded the current feed as ${feed.length} source group(s): ${
        feed.map((group) => group.id).join(", ") || "none"
      }, ${feed[0]?.sessions.length ?? 0} sessions`,
    );
  }

  const watch = await controlRequests(state.supervisor.control, history.next);
  add(
    "watch-adds-no-source-requests",
    watch.requests.length === 0,
    watch.requests.length === 0
      ? "the first watch added no source connection, list, or active request"
      : `the first watch added ${watch.requests.map((request) => request.path).join(", ")}`,
  );
  await writeCursor(run, watch.next);

  const pass = checks.every((check) => check.pass);
  await writeJson(doctorPath(run), {
    result: pass ? "PASS" : "FAIL",
    checkedAt: new Date().toISOString(),
    checks,
  });
  await recordChecks(
    run,
    checks.map((check) => ({
      feature: "doctor",
      scenario: "readiness",
      name: check.name,
      pass: check.pass,
      detail: check.detail,
    })),
  );

  console.log(`${pass ? "PASS" : "FAIL"} doctor run=${run}`);
  return pass;
};

const featureEnv = (
  state: RunState,
  feature: Feature,
  writeScenarioChecks: (checks: ReadonlyArray<Check>) => void,
): FeatureEnv => {
  const cache = new Map<string, ReadonlyArray<UpstreamRequest>>();

  return {
    feature,
    state,
    writeScenario: async (scenario, value) => {
      await writeJson(join(state.run, "scenarios", `${scenario}.json`), value);
      writeScenarioChecks(value.checks);
    },
    takeRequests: async (scenario) => {
      const cached = cache.get(scenario);
      if (cached !== undefined) return cached;
      const cursor = readCursor(state.run);
      const page = await controlRequests(state.supervisor.control, cursor);
      await writeCursor(state.run, page.next);
      appendJsonl(
        requestsPath(state.run),
        page.requests.map((request) => ({
          feature,
          scenario,
          at: new Date().toISOString(),
          method: request.method,
          path: request.path,
          search: request.search,
          authorization: request.authorization ? "basic" : "none",
        })),
      );
      cache.set(scenario, page.requests);
      return page.requests;
    },
    frame: (scenario, client, event) => {
      appendJsonl(framesPath(state.run), [
        {
          feature,
          scenario,
          client,
          at: new Date().toISOString(),
          event,
        },
      ]);
    },
    direct: async (name, value) => {
      await writeJson(join(state.run, "direct", `${name}.json`), value);
    },
    rawFrames: (scenario, frames) => {
      appendJsonl(
        rawFramesPath(state.run),
        frames.map((frame) => ({
          feature,
          scenario,
          at: new Date().toISOString(),
          ...frame,
        })),
      );
    },
  };
};

const runFeature = async (run: string, feature: Feature): Promise<boolean> => {
  const state = readState(run);
  const runner = featureRunners[feature];
  if (runner === undefined) throw new Error(`Unknown feature ${feature}.`);

  const checks: Array<Check> = [];
  const env = featureEnv(state, feature, (next) => {
    checks.push(...next);
  });

  let failure: unknown;
  try {
    await runner(env);
  } catch (error) {
    failure = error;
  }

  await recordChecks(run, sortChecks(checks));
  const manifest = readJson(manifestPath(run), ManifestSchema);
  await writeJson(manifestPath(run), {
    ...manifest,
    features: [
      ...manifest.features.filter((entry) => entry.feature !== feature),
      { feature, result: failure === undefined ? "PASS" : "FAIL" },
    ],
  });

  console.log(
    `${failure === undefined ? "PASS" : "FAIL"} feature=${feature} run=${run}${
      failure === undefined ? "" : ` error=${errorMessage(failure)}`
    }`,
  );
  if (failure !== undefined) throw failure;
  return true;
};

const cleanup = async (run: string): Promise<boolean> => {
  const checks: Array<DoctorCheck> = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    checks.push({ name, pass, detail });
  };

  if (!existsSync(statePath(run))) {
    await writeJson(cleanupPath(run), {
      result: "FAIL",
      reason: "No state file; nothing owned to clean up.",
      checks,
    });
    return false;
  }

  const state = readState(run);
  let sourceConnections = state.startupConnections;
  let sigterm:
    | {
        exitCode: number | null;
        listenerClosed: boolean;
        connections: number;
        openConnections: number;
      }
    | undefined;
  try {
    sourceConnections = (await controlState(state.supervisor.control)).connections;
    sigterm = await controlSigterm(state.supervisor.control);
  } catch (error) {
    if (processAlive(state.supervisor.pid) || processAlive(state.server.runnerPid)) {
      add("sigterm-request", false, String(error));
    }
  }
  if (sigterm !== undefined) {
    add(
      "sigterm-stops-server",
      sigterm.listenerClosed && (sigterm.exitCode === 0 || sigterm.exitCode === 130),
      `server exit ${sigterm.exitCode}, listener closed ${sigterm.listenerClosed}`,
    );
    add(
      "source-connection-inactive",
      sigterm.openConnections === 0 && sigterm.connections === sourceConnections,
      `source open ${sigterm.openConnections}, cumulative ${sigterm.connections}, before shutdown ${sourceConnections}`,
    );
  } else if (!processAlive(state.server.runnerPid)) {
    add("sigterm-stops-server", true, "the owned server was already stopped");
  }

  try {
    await controlShutdown(state.supervisor.control);
  } catch (error) {
    if (processAlive(state.supervisor.pid)) {
      add("shutdown-request", false, String(error));
    }
  }

  const waitGone = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (!processAlive(pid)) return true;
      await Bun.sleep(50);
    }
    return !processAlive(pid);
  };

  if (!(await waitGone(state.supervisor.pid, 5_000))) {
    process.kill(state.supervisor.pid, "SIGTERM");
    if (!(await waitGone(state.supervisor.pid, 2_000))) {
      process.kill(state.supervisor.pid, "SIGKILL");
      await waitGone(state.supervisor.pid, 2_000);
    }
  }
  add(
    "supervisor-gone",
    !processAlive(state.supervisor.pid),
    `supervisor pid ${state.supervisor.pid}`,
  );

  if (!(await waitGone(state.server.runnerPid, 5_000))) {
    process.kill(state.server.runnerPid, "SIGTERM");
    if (!(await waitGone(state.server.runnerPid, 2_000))) {
      process.kill(state.server.runnerPid, "SIGKILL");
      await waitGone(state.server.runnerPid, 2_000);
    }
  }
  add(
    "runner-gone",
    !processAlive(state.server.runnerPid),
    `server runner pid ${state.server.runnerPid}`,
  );

  for (const pid of listenerPIDs(state.server.port)) {
    if (pid === state.server.runnerPid || pid === state.server.listenerPid) {
      process.kill(pid, "SIGTERM");
      await waitGone(pid, 2_000);
    }
  }

  const fakePort = Number(new URL(state.fake.url).port);
  add(
    "server-port-closed",
    listenerPIDs(state.server.port).length === 0,
    `port ${state.server.port}`,
  );
  add("fake-port-closed", listenerPIDs(fakePort).length === 0, `fake port ${fakePort}`);

  const secretFiles = readdirSync(run, { recursive: true, encoding: "utf8" })
    .map((entry) => join(run, entry))
    .filter((entry) => {
      if (entry === cleanupPath(run) || entry === postCleanupPath(run)) return false;
      try {
        return hasSecretValue(readFileSync(entry, "utf8"));
      } catch {
        return false;
      }
    });
  add(
    "no-secret-values",
    secretFiles.length === 0,
    secretFiles.length === 0
      ? "no controlled password or authorization header in evidence"
      : `secret values appeared in ${secretFiles.join(", ")}`,
  );

  const pass = checks.every((check) => check.pass);
  await writeJson(cleanupPath(run), {
    result: pass ? "PASS" : "FAIL",
    cleanedAt: new Date().toISOString(),
    checks,
  });
  await recordChecks(
    run,
    checks.map((check) => ({
      feature: "cleanup",
      scenario: "teardown",
      name: check.name,
      pass: check.pass,
      detail: check.detail,
    })),
  );

  const manifest = readJson(manifestPath(run), ManifestSchema);
  const files = requiredEvidence(run, manifest).map((path) => {
    try {
      const size = readFileSync(path).byteLength;
      return { path, exists: true, readable: true, bytes: size };
    } catch {
      return { path, exists: false, readable: false, bytes: 0 };
    }
  });
  const evidencePass = files.every((file) => file.readable);
  await writeJson(postCleanupPath(run), {
    result: evidencePass ? "PASS" : "FAIL",
    verifiedAt: new Date().toISOString(),
    files,
  });

  const checksPass = readChecks(run).every((check) => check.pass);
  const finalPass =
    pass &&
    evidencePass &&
    checksPass &&
    manifest.features.every((entry) => entry.result === "PASS");
  await writeJson(manifestPath(run), {
    ...manifest,
    result: finalPass ? "PASS" : "FAIL",
    finishedAt: new Date().toISOString(),
  });

  console.log(`${finalPass ? "PASS" : "FAIL"} cleanup run=${run}`);
  return finalPass;
};

const manifestResult = async (run: string, result: "PASS" | "FAIL"): Promise<void> => {
  if (!existsSync(manifestPath(run))) return;
  const manifest = readJson(manifestPath(run), ManifestSchema);
  await writeJson(manifestPath(run), {
    ...manifest,
    result,
    finishedAt: new Date().toISOString(),
  });
};

const all = async (worktree: string, run: string): Promise<boolean> => {
  let failure: unknown;

  try {
    await launch(worktree, run);
    if (!(await doctor(run))) throw new Error("Doctor failed.");
    for (const feature of features) {
      await runFeature(run, feature);
    }
  } catch (error) {
    failure = error;
  }

  const cleaned = await cleanup(run);
  const passed = failure === undefined && cleaned;
  await manifestResult(run, passed ? "PASS" : "FAIL");
  console.log(
    `${passed ? "PASS" : "FAIL"} all run=${run}${failure === undefined ? "" : ` error=${errorMessage(failure)}`}`,
  );
  return passed;
};

const help = (): void => {
  console.log(`Usage:
  bun run verify launch [--run <abs>] [--worktree <abs>]
  bun run verify doctor --run <abs>
  bun run verify feature <${features.join("|")}> --run <abs>
  bun run verify all [--run <abs>] [--worktree <abs>]
  bun run verify cleanup --run <abs>

The default run directory is ${uniqueRun()}`);
};

const main = async (): Promise<number> => {
  const [command, ...args] = process.argv.slice(2);

  if (command === undefined || command === "help" || command === "--help") {
    help();
    return 0;
  }

  if (command === "launch") {
    const options = parseOptions(args);
    await launch(options.worktree, options.run);
    console.log(`LAUNCHED run=${options.run}`);
    process.exit(0);
  }

  if (command === "doctor") {
    const options = parseOptions(args);
    return (await doctor(options.run)) ? 0 : 1;
  }

  if (command === "feature") {
    const [featureName, ...rest] = args;
    if (featureName === undefined || !features.includes(featureName as Feature)) {
      throw new Error(`feature requires one of: ${features.join(", ")}`);
    }
    const options = parseOptions(rest);
    try {
      await runFeature(options.run, featureName as Feature);
      return 0;
    } catch (error) {
      await cleanup(options.run);
      throw error;
    }
  }

  if (command === "all") {
    const options = parseOptions(args);
    return (await all(options.worktree, options.run)) ? 0 : 1;
  }

  if (command === "cleanup") {
    const options = parseOptions(args);
    return (await cleanup(options.run)) ? 0 : 1;
  }

  help();
  return 1;
};

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
