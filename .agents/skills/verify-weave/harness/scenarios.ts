import { Effect, Fiber, Ref } from "effect";
import { eventFrame } from "../../../../test/support/fake-opencode.ts";
import type { SessionFixture } from "../../../../test/support/fake-opencode.ts";
import type { SessionFeed, SessionView } from "../../../../src/shared/session.ts";
import {
  attemptFeed,
  latestFeed,
  rawProbe,
  startWatcher,
  waitForFeed,
  withClient,
  type Watcher,
} from "./client.ts";
import {
  controlEnd,
  controlEvent,
  controlRequests,
  controlSessions,
  controlSeedFailure,
  controlState,
  controlStopUpstream,
  errorMessage,
  freePort,
  hasSecretValue,
  readCursor,
  runCommand,
  sanitize,
  type Check,
  type RawFrame,
  type RunState,
  type ScenarioResult,
  type UpstreamRequest,
} from "./support.ts";

const baseTime = 1_700_000_000_000;

const fixture = (
  id: string,
  options: {
    readonly parentID?: string;
    readonly title?: string;
    readonly directory?: string;
    readonly updated?: number;
    readonly busy?: number;
    readonly viewed?: number;
    readonly outcome?: "succeeded" | "failed" | "interrupted";
    readonly archived?: boolean;
  } = {},
): SessionFixture => ({
  id,
  directory: options.directory ?? "/work/verify",
  updated: options.updated ?? baseTime + 100_000,
  ...(options.parentID === undefined ? {} : { parentID: options.parentID }),
  ...(options.title === undefined ? {} : { title: options.title }),
  ...(options.busy === undefined ? {} : { busy: options.busy }),
  ...(options.viewed === undefined ? {} : { viewed: options.viewed }),
  ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
  ...(options.archived === undefined ? {} : { archived: options.archived }),
});

let eventSequence = 0;

const event = (type: string, data: Readonly<Record<string, unknown>>): unknown => {
  eventSequence += 1;
  return eventFrame(type, data, {
    id: `evt_verify_${eventSequence}`,
    created: baseTime + eventSequence,
    seq: eventSequence,
  });
};

const latestView = (feed: SessionFeed | undefined, id: string): SessionView | undefined => {
  for (const group of feed ?? []) {
    const found = group.sessions.find((item) => item.id === id);
    if (found !== undefined) return found;
  }

  return undefined;
};

const present = (feed: SessionFeed, id: string): boolean => latestView(feed, id) !== undefined;

const absent = (feed: SessionFeed, id: string): boolean => !present(feed, id);

const feedIDs = (feed: SessionFeed): ReadonlySet<string> =>
  new Set(feed.flatMap((group) => group.sessions.map((item) => item.id)));

const sourceIDs = (feed: SessionFeed): ReadonlyArray<string> => feed.map((group) => group.id);

const zeroAttention = (feed: SessionFeed): boolean =>
  feed.every((group) =>
    group.sessions.every(
      (item) => item.attention.permissions === 0 && item.attention.questions === 0,
    ),
  );

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

export class Recorder {
  readonly checks: Array<Check> = [];
  readonly feature: string;
  readonly scenario: string;

  constructor(feature: string, scenario: string) {
    this.feature = feature;
    this.scenario = scenario;
  }

  require(name: string, condition: unknown, failure: string, observed?: string): void {
    const pass = Boolean(condition);
    this.checks.push({
      feature: this.feature,
      scenario: this.scenario,
      name,
      pass,
      ...(observed === undefined ? {} : { detail: observed }),
      ...(pass ? {} : { failure }),
    });
    if (!pass) throw new Error(`${name}: ${failure}`);
  }
}

export interface FeatureEnv {
  readonly feature: string;
  readonly state: RunState;
  readonly writeScenario: (scenario: string, value: ScenarioResult) => Promise<void>;
  readonly takeRequests: (scenario: string) => Promise<ReadonlyArray<UpstreamRequest>>;
  readonly frame: (scenario: string, client: string, feed: SessionFeed) => void;
  readonly direct: (name: string, value: unknown) => Promise<void>;
  readonly rawFrames: (scenario: string, frames: ReadonlyArray<RawFrame>) => void;
}

const scenario = async (
  env: FeatureEnv,
  name: string,
  run: (recorder: Recorder) => Promise<void>,
): Promise<void> => {
  const recorder = new Recorder(env.feature, name);
  let failure: unknown;

  try {
    await run(recorder);
  } catch (error) {
    failure = error;
  }

  let requests: ReadonlyArray<UpstreamRequest> = [];
  try {
    requests = await env.takeRequests(name);
  } catch (error) {
    if (failure === undefined) failure = error;
  }

  await env.writeScenario(name, {
    feature: env.feature,
    scenario: name,
    result: failure === undefined ? "PASS" : "FAIL",
    checks: recorder.checks,
    requests: requests.map((request) => ({
      method: request.method,
      path: request.path,
      authorization: request.authorization,
    })),
    ...(failure === undefined ? {} : { error: errorMessage(failure) }),
  });

  if (failure !== undefined) throw failure;
};

const openWatcherUntil = (
  env: FeatureEnv,
  name: string,
  clientName: string,
  url: string,
  predicate: (feed: SessionFeed) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<SessionFeed> =>
  withClient(url, (client) =>
    Effect.gen(function* () {
      const watcher = yield* startWatcher(client, (feed) => env.frame(name, clientName, feed));
      yield* waitForFeed(watcher, label, predicate, timeoutMs);
      return (yield* latestFeed(watcher)) ?? [];
    }),
  );

const sendEvent = (control: string, payload: unknown): Effect.Effect<void> =>
  Effect.promise(() => controlEvent(control, payload)).pipe(Effect.asVoid);

const prepare = (
  control: string,
  sessions: ReadonlyArray<SessionFixture>,
  active: Readonly<Record<string, { readonly type: "running" }>> = {},
): Promise<unknown> => controlSessions(control, sessions, active, { reset: false });

const assertWatchAddsNoSourceRequests = async (
  recorder: Recorder,
  env: FeatureEnv,
  label: string,
  open: () => Promise<unknown>,
): Promise<void> => {
  const control = env.state.supervisor.control;
  const baseline = await controlRequests(control, readCursor(env.state.run));
  const before = await controlState(control);
  await open();
  const added = await controlRequests(control, baseline.next);
  const after = await controlState(control);

  recorder.require(
    `${label}-same-source-connection`,
    after.connections === before.connections && after.openConnections === before.openConnections,
    "opening a watch changed the source connection",
    `connections ${before.connections} -> ${after.connections}, open ${before.openConnections} -> ${after.openConnections}`,
  );
  recorder.require(
    `${label}-no-source-requests`,
    added.requests.length === 0,
    "opening a watch issued a source connection, list, or active request",
    `the watch added ${added.requests.map((request) => request.path).join(", ") || "no requests"}`,
  );
};

const currentFeed = (watcher: Watcher): Effect.Effect<SessionFeed | undefined> =>
  latestFeed(watcher);

export const runSnapshot = (env: FeatureEnv): Promise<void> =>
  (async () => {
    const control = env.state.supervisor.control;
    const url = env.state.server.url;

    await scenario(env, "startup", async (recorder) => {
      const before = await controlState(control);
      recorder.require(
        "startup-one-source",
        before.connections === env.state.startupConnections &&
          before.connections === 1 &&
          before.openConnections === 1,
        "the server did not keep one startup source connection before the first feature reset",
        `startup ${env.state.startupConnections}, cumulative ${before.connections}, open ${before.openConnections}`,
      );

      const history = await controlRequests(control, 0);
      const paths = history.requests.map((request) => request.path);
      const listRequests = history.requests.filter((request) => request.path === "/api/session");
      const eventReads = paths.filter((path) => path === "/api/event");
      const activeReads = paths.filter((path) => path === "/api/session/active");
      const perSessionReads = paths.filter(
        (path) => path !== "/api/session/active" && /^\/api\/session\/[^/]+$/.test(path),
      );

      recorder.require(
        "startup-one-source-stream",
        eventReads.length === 1,
        "startup did not open exactly one source stream",
        `startup opened ${eventReads.length} source stream(s)`,
      );
      recorder.require(
        "startup-paginated-seed",
        listRequests.length >= 2 &&
          listRequests.every(
            (request) =>
              request.search.includes("limit=500") &&
              request.search.includes("archived=false") &&
              !request.search.includes("parentID"),
          ),
        "startup did not read the whole collection across paginated pages",
        `startup list reads: ${listRequests.length}, searches: ${listRequests
          .map((request) => request.search)
          .join(", ")}`,
      );
      recorder.require(
        "startup-one-active-read",
        activeReads.length === 1,
        "startup did not read the active ids once",
        `startup active reads were ${activeReads.length}`,
      );
      recorder.require(
        "startup-no-per-session-read",
        perSessionReads.length === 0,
        "startup read individual sessions instead of the whole collection",
        `startup per-session reads were ${perSessionReads.join(", ") || "none"}`,
      );
      recorder.require(
        "startup-no-pending-read",
        paths.every((path) => !path.includes("permission") && !path.includes("form")),
        "startup read a pending permission or form endpoint",
        `startup paths were ${paths.join(", ")}`,
      );

      const feed = await openWatcherUntil(
        env,
        "startup",
        "watcher",
        url,
        (current) => feedIDs(current).size === 502,
        "the 502-session startup feed",
        20_000,
      );
      recorder.require(
        "startup-one-local-group",
        feed.length === 1 && feed[0]?.id === "local",
        "the startup feed was not one local source group",
        `source ids were ${sourceIDs(feed).join(", ") || "empty"}`,
      );
      recorder.require(
        "startup-whole-collection",
        feedIDs(feed).size === 502,
        "the startup feed stopped before the whole 502-session fixture",
        `received ${feedIDs(feed).size} sessions`,
      );
      recorder.require(
        "startup-child-running",
        latestView(feed, "ses_start_child")?.status === "running",
        "the startup active read did not mark the child running",
        `the startup child was ${latestView(feed, "ses_start_child")?.status ?? "absent"}`,
      );
      recorder.require(
        "startup-zero-attention",
        zeroAttention(feed),
        "the first startup feed did not keep every attention count at zero",
        `all ${feedIDs(feed).size} startup sessions were checked for zero attention`,
      );
    });

    await scenario(env, "first-feed", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Root", directory: "/work/root" }),
          fixture("ses_child", {
            parentID: "ses_root",
            title: "Child",
            directory: "/work/child",
            busy: baseTime + 50_000,
          }),
        ],
        { ses_child: { type: "running" } },
      );
      const feed = await openWatcherUntil(
        env,
        "first-feed",
        "watcher",
        url,
        (current) => feedIDs(current).size === 2 && present(current, "ses_root"),
        "the first two-session projection",
      );
      const root = latestView(feed, "ses_root");
      const child = latestView(feed, "ses_child");
      recorder.require(
        "one-local-source-group",
        feed.length === 1 && feed[0]?.id === "local",
        "the first feed was not one local source group",
        `source ids were ${sourceIDs(feed).join(", ")}`,
      );
      recorder.require(
        "root-idle",
        root?.status === "idle" && root.location.directory === "/work/root",
        "the root was not idle at its directory",
        `root was ${JSON.stringify(root)}`,
      );
      recorder.require(
        "child-running",
        child?.status === "running" && child.parentID === "ses_root",
        "the child was not running under its parent",
        `child was ${JSON.stringify(child)}`,
      );
      recorder.require(
        "attention-zero",
        zeroAttention(feed),
        "the projection did not keep every attention count at zero",
      );
      recorder.require(
        "full-collection",
        feedIDs(feed).size === 2,
        "the feed was not the full two-session collection",
        `received ${feedIDs(feed).size} sessions`,
      );
    });

    await scenario(env, "whole-collection", async (recorder) => {
      const roots = Array.from({ length: 501 }, (_, index) =>
        fixture(`ses_paged_${String(index).padStart(3, "0")}`, {
          title: `Root ${index}`,
          directory: `/work/directory-${String(index).padStart(3, "0")}`,
          updated: baseTime + 1_000 + index,
        }),
      );
      const child = fixture("ses_paged_child", {
        parentID: "ses_paged_000",
        title: "Paged child",
        directory: "/work/directory-000",
        busy: baseTime + 60_000,
      });
      await controlSessions(control, [...roots, child], {
        ses_paged_child: { type: "running" },
      });
      const feed = await openWatcherUntil(
        env,
        "whole-collection",
        "watcher",
        url,
        (current) =>
          feedIDs(current).size === 502 &&
          latestView(current, "ses_paged_child")?.status === "running",
        "the whole 502-session collection",
        20_000,
      );
      const ids = feedIDs(feed);
      recorder.require(
        "whole-collection-not-capped",
        ids.size === 502 && roots.every((root) => ids.has(root.id)) && ids.has("ses_paged_child"),
        "the collection stopped before the whole 502-session set",
        `received ${ids.size} sessions`,
      );
      recorder.require(
        "whole-collection-child-running",
        latestView(feed, "ses_paged_child")?.status === "running",
        "the child in the whole collection was not running",
      );
    });

    await scenario(env, "all-children", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Visible", directory: "/work/visible" }),
          fixture("ses_idle_child", { parentID: "ses_root", directory: "/work/idle-child" }),
          fixture("ses_idle_mid", { parentID: "ses_root", directory: "/work/idle-mid" }),
          fixture("ses_idle_deep", { parentID: "ses_idle_mid", directory: "/work/idle-deep" }),
          fixture("ses_running_child", {
            parentID: "ses_root",
            directory: "/work/running-child",
          }),
          fixture("ses_running_deep", {
            parentID: "ses_idle_mid",
            directory: "/work/running-deep",
          }),
          fixture("ses_archived_root", { archived: true, directory: "/work/archived" }),
          fixture("ses_archived_child", {
            parentID: "ses_archived_root",
            directory: "/work/archived-child",
          }),
          fixture("ses_outside", { parentID: "ses_missing", directory: "/work/outside" }),
        ],
        {
          ses_running_child: { type: "running" },
          ses_running_deep: { type: "running" },
        },
      );
      const feed = await openWatcherUntil(
        env,
        "all-children",
        "watcher",
        url,
        (current) =>
          present(current, "ses_root") &&
          present(current, "ses_idle_child") &&
          present(current, "ses_idle_mid") &&
          present(current, "ses_idle_deep") &&
          present(current, "ses_running_child") &&
          present(current, "ses_running_deep"),
        "the whole unarchived family",
      );
      const ids = feedIDs(feed);
      recorder.require(
        "idle-descendants-included",
        ids.has("ses_idle_child") && ids.has("ses_idle_mid") && ids.has("ses_idle_deep"),
        "an idle descendant was missing from the whole collection",
        `visible IDs were ${[...ids].join(", ")}`,
      );
      recorder.require(
        "running-descendants-included",
        ids.has("ses_running_child") && ids.has("ses_running_deep"),
        "a running descendant was missing from the whole collection",
      );
      recorder.require(
        "deep-status-own",
        latestView(feed, "ses_idle_deep")?.status === "idle" &&
          latestView(feed, "ses_running_deep")?.status === "running",
        "a deep descendant did not carry its own status",
      );
      recorder.require(
        "archived-family-excluded",
        !ids.has("ses_archived_root") && !ids.has("ses_archived_child"),
        "an archived root or its child was visible",
      );
      recorder.require(
        "outside-family-excluded",
        !ids.has("ses_outside"),
        "a session outside the unarchived family set was included",
      );
    });

    await scenario(env, "full-replace", async (recorder) => {
      await controlSessions(control, [fixture("ses_before", { title: "Before" })], {});
      const before = await openWatcherUntil(
        env,
        "full-replace",
        "before",
        url,
        (current) => present(current, "ses_before") && absent(current, "ses_after"),
        "the before projection",
      );
      await controlSessions(control, [fixture("ses_after", { title: "After" })], {});
      const after = await openWatcherUntil(
        env,
        "full-replace",
        "after",
        url,
        (current) => present(current, "ses_after") && absent(current, "ses_before"),
        "the after projection",
      );
      const beforeIDs = feedIDs(before);
      const afterIDs = feedIDs(after);
      recorder.require(
        "new-projection-replaces",
        beforeIDs.has("ses_before") && afterIDs.has("ses_after") && !afterIDs.has("ses_before"),
        "the changed fixture did not replace the old collection",
        `before=${[...beforeIDs].join(",")} after=${[...afterIDs].join(",")}`,
      );
    });

    await scenario(env, "no-pending-reads", async (recorder) => {
      await controlSessions(control, [fixture("ses_root", { title: "Root" })], {});
      await openWatcherUntil(
        env,
        "no-pending-reads",
        "watcher",
        url,
        (current) => present(current, "ses_root"),
        "the root projection",
      );
      const requests = await env.takeRequests("no-pending-reads");
      recorder.require(
        "no-pending-reads",
        requests.every(
          (request) => !request.path.includes("permission") && !request.path.includes("form"),
        ),
        "a source read used a pending permission or form endpoint",
        `request paths were ${requests.map((request) => request.path).join(", ")}`,
      );
    });
  })();

export const runLiveUpdates = (env: FeatureEnv): Promise<void> =>
  (async () => {
    const control = env.state.supervisor.control;
    const url = env.state.server.url;

    await scenario(env, "records", async (recorder) => {
      const initial = [
        fixture("ses_root", {
          title: "Before",
          directory: "/work/before",
          updated: 100,
          outcome: "failed",
        }),
      ];
      await controlSessions(control, initial, {});
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("records", "watcher", feed),
          );
          yield* waitForFeed(
            watcher,
            "the initial record",
            (current) => latestView(current, "ses_root")?.time.updated === 100,
          );

          yield* Effect.promise(() =>
            prepare(
              control,
              [fixture("ses_root", { directory: "/work/before", updated: 200 })],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.renamed", { sessionID: "ses_root", title: "After" }),
          );
          let feed = yield* waitForFeed(
            watcher,
            "the renamed full feed",
            (current) => latestView(current, "ses_root")?.time.updated === 200,
          );
          const root = latestView(feed, "ses_root");
          recorder.require(
            "rename-clears-optional-fields",
            root !== undefined && !hasOwn(root, "title") && !hasOwn(root, "outcome"),
            "the renamed record kept a stale optional field",
            `renamed root was ${JSON.stringify(root)}`,
          );
          recorder.require(
            "rename-keeps-full-record",
            root?.status === "idle" &&
              root.location.directory === "/work/before" &&
              root.time.updated === 200 &&
              root.attention.permissions === 0,
            `renamed root lost a full-record field: ${JSON.stringify(root)}`,
          );

          yield* Effect.promise(() =>
            prepare(control, [fixture("ses_root", { directory: "/work/after", updated: 300 })], {}),
          );
          yield* sendEvent(
            control,
            event("session.moved", {
              sessionID: "ses_root",
              location: { directory: "/work/after" },
              projectID: "prj_verify",
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the moved full feed",
            (current) => latestView(current, "ses_root")?.location.directory === "/work/after",
          );
          recorder.require(
            "move-updates-location",
            latestView(feed, "ses_root")?.time.updated === 300,
            "the moved record did not carry its new updated time",
          );

          yield* Effect.promise(() =>
            prepare(
              control,
              [fixture("ses_root", { directory: "/work/after", updated: 300, viewed: 350 })],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.viewed", { sessionID: "ses_root", idle: baseTime + 350_000 }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the viewed activity",
            (current) => latestView(current, "ses_root")?.time.viewed === 350,
          );
          const viewedRecord = latestView(feed, "ses_root");

          yield* Effect.promise(() =>
            prepare(
              control,
              [fixture("ses_root", { directory: "/work/after", updated: 400, outcome: "failed" })],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.execution.failed", {
              sessionID: "ses_root",
              error: { type: "unknown", message: "execution failed" },
            }),
          );
          feed = yield* waitForFeed(watcher, "the failed outcome", (current) => {
            const view = latestView(current, "ses_root");
            return view?.outcome === "failed" && view.time.updated === 400;
          });
          const refreshed = latestView(feed, "ses_root");
          recorder.require(
            "outcome-updates",
            refreshed?.status === "idle",
            "the failed outcome did not return the root to idle",
          );
          recorder.require(
            "viewed-cleared-on-refresh",
            viewedRecord?.time.viewed === 350 &&
              viewedRecord.time.updated === 300 &&
              refreshed !== undefined &&
              refreshed.time.updated === 400 &&
              !hasOwn(refreshed.time, "viewed"),
            "the viewed time did not clear on a full-record refresh",
            `viewed frame ${JSON.stringify(viewedRecord?.time)} refreshed frame ${JSON.stringify(refreshed?.time)}`,
          );

          yield* Effect.promise(() =>
            prepare(control, [fixture("ses_root", { directory: "/work/after", updated: 500 })], {}),
          );
          yield* sendEvent(
            control,
            event("session.metadata.updated", { sessionID: "ses_root", metadata: {} }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the cleared outcome",
            (current) => latestView(current, "ses_root")?.time.updated === 500,
          );
          const cleared = latestView(feed, "ses_root");
          recorder.require(
            "outcome-cleared",
            cleared !== undefined && !hasOwn(cleared, "outcome"),
            "the stale outcome survived a full-record refresh",
          );
        }),
      );
    });

    await scenario(env, "running-idle-retained", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Root" }),
          fixture("ses_idle_child", { parentID: "ses_root", title: "Idle child" }),
        ],
        {},
      );
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("running-idle-retained", "watcher", feed),
          );
          yield* waitForFeed(
            watcher,
            "the idle child projection",
            (current) =>
              present(current, "ses_idle_child") &&
              latestView(current, "ses_idle_child")?.status === "idle",
          );
          const initial = (yield* currentFeed(watcher)) ?? [];
          recorder.require(
            "idle-child-visible",
            present(initial, "ses_idle_child") &&
              latestView(initial, "ses_idle_child")?.status === "idle",
            "an idle child was not visible before it started running",
          );

          yield* Effect.promise(() =>
            prepare(
              control,
              [
                fixture("ses_root", { title: "Root" }),
                fixture("ses_idle_child", {
                  parentID: "ses_root",
                  title: "Idle child",
                  busy: baseTime + 200_000,
                }),
              ],
              { ses_idle_child: { type: "running" } },
            ),
          );
          yield* sendEvent(
            control,
            event("session.execution.started", { sessionID: "ses_idle_child" }),
          );
          const running = yield* waitForFeed(
            watcher,
            "the running child",
            (current) => latestView(current, "ses_idle_child")?.status === "running",
          );
          recorder.require(
            "running-child-updates",
            latestView(running, "ses_idle_child")?.parentID === "ses_root",
            "the started child lost its parent",
          );

          yield* Effect.promise(() =>
            prepare(
              control,
              [
                fixture("ses_root", { title: "Root" }),
                fixture("ses_idle_child", {
                  parentID: "ses_root",
                  title: "Idle child",
                  updated: baseTime + 300_000,
                }),
              ],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.execution.succeeded", { sessionID: "ses_idle_child" }),
          );
          const finished = yield* waitForFeed(
            watcher,
            "the retained idle child",
            (current) => latestView(current, "ses_idle_child")?.status === "idle",
          );
          recorder.require(
            "idle-child-retained",
            present(finished, "ses_idle_child"),
            "the finished child left the whole collection",
          );
        }),
      );
    });

    await scenario(env, "attention-own", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Root" }),
          fixture("ses_child", { parentID: "ses_root", title: "Child" }),
          fixture("ses_deep", { parentID: "ses_child", title: "Deep child" }),
        ],
        {},
      );
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("attention-own", "watcher", feed),
          );
          yield* waitForFeed(watcher, "the own-attention family", (current) =>
            present(current, "ses_deep"),
          );

          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_child",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          let feed = yield* waitForFeed(
            watcher,
            "the child permission",
            (current) => latestView(current, "ses_child")?.attention.permissions === 1,
          );
          recorder.require(
            "permission-child-own",
            latestView(feed, "ses_child")?.attention.permissions === 1,
            "the child did not count its own permission",
          );
          recorder.require(
            "permission-root-own-zero",
            latestView(feed, "ses_root")?.attention.permissions === 0,
            "a root counted a child permission",
            `root permissions were ${latestView(feed, "ses_root")?.attention.permissions}`,
          );
          recorder.require(
            "permission-deep-own-zero",
            latestView(feed, "ses_deep")?.attention.permissions === 0,
            "a sibling counted another child's permission",
          );

          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_root",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the root permission",
            (current) => latestView(current, "ses_root")?.attention.permissions === 1,
          );
          recorder.require(
            "permission-root-own",
            latestView(feed, "ses_root")?.attention.permissions === 1 &&
              latestView(feed, "ses_child")?.attention.permissions === 1,
            "the root did not count only its own permission",
          );

          yield* sendEvent(
            control,
            event("form.created", {
              form: {
                id: "frm_child",
                sessionID: "ses_child",
                title: "Child question",
                metadata: { kind: "question" },
                fields: [{ key: "answer", type: "string" }],
              },
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the child question",
            (current) => latestView(current, "ses_child")?.attention.questions === 1,
          );
          recorder.require(
            "question-child-own",
            latestView(feed, "ses_child")?.attention.questions === 1 &&
              latestView(feed, "ses_root")?.attention.questions === 0,
            "a root counted a child question",
          );

          yield* sendEvent(
            control,
            event("form.created", {
              form: {
                id: "frm_deep",
                sessionID: "ses_deep",
                title: "Deep question",
                metadata: { kind: "question" },
                fields: [{ key: "answer", type: "string" }],
              },
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the deep question",
            (current) => latestView(current, "ses_deep")?.attention.questions === 1,
          );
          recorder.require(
            "question-deep-own",
            latestView(feed, "ses_deep")?.attention.questions === 1 &&
              latestView(feed, "ses_root")?.attention.questions === 0,
            "a deep child did not count its own question",
          );

          const feedsBeforeUnknown = yield* Ref.get(watcher.feeds);
          yield* sendEvent(
            control,
            event("permission.replied", {
              sessionID: "ses_child",
              requestID: "per_unknown",
              reply: "once",
            }),
          );
          yield* sendEvent(
            control,
            event("form.cancelled", {
              id: "frm_unknown",
              sessionID: "ses_child",
            }),
          );
          yield* Effect.promise(() =>
            prepare(
              control,
              [
                fixture("ses_root", { title: "Root", updated: baseTime + 200_000 }),
                fixture("ses_child", { parentID: "ses_root", title: "Child" }),
                fixture("ses_deep", { parentID: "ses_child", title: "Deep child" }),
              ],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.metadata.updated", { sessionID: "ses_root", metadata: {} }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the barrier after unknown replies",
            (current) => latestView(current, "ses_root")?.time.updated === baseTime + 200_000,
          );
          const feedsAfterUnknown = yield* Ref.get(watcher.feeds);
          recorder.require(
            "unknown-reply-no-feed",
            feedsAfterUnknown.length === feedsBeforeUnknown.length + 1,
            "an unknown permission reply or question cancel emitted its own feed",
            `feed count went ${feedsBeforeUnknown.length} -> ${feedsAfterUnknown.length}`,
          );
          recorder.require(
            "unknown-permission-reply-no-effect",
            latestView(feed, "ses_child")?.attention.permissions === 1 &&
              latestView(feed, "ses_root")?.attention.permissions === 1 &&
              latestView(feed, "ses_child")?.attention.questions === 1 &&
              latestView(feed, "ses_deep")?.attention.questions === 1,
            "an unknown permission reply changed attention",
          );

          yield* sendEvent(
            control,
            event("form.replied", {
              id: "frm_child",
              sessionID: "ses_child",
              answer: {},
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the replied question",
            (current) => latestView(current, "ses_child")?.attention.questions === 0,
          );
          recorder.require(
            "question-reply-clears-own",
            latestView(feed, "ses_child")?.attention.questions === 0 &&
              latestView(feed, "ses_deep")?.attention.questions === 1 &&
              latestView(feed, "ses_root")?.attention.questions === 0 &&
              latestView(feed, "ses_child")?.attention.permissions === 1,
            "the replied question did not clear only the child or cleared a permission",
          );

          yield* sendEvent(
            control,
            event("form.cancelled", {
              id: "frm_deep",
              sessionID: "ses_deep",
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the cancelled question",
            (current) => latestView(current, "ses_deep")?.attention.questions === 0,
          );
          recorder.require(
            "question-cancel-clears-own",
            latestView(feed, "ses_deep")?.attention.questions === 0 &&
              latestView(feed, "ses_child")?.attention.questions === 0 &&
              latestView(feed, "ses_root")?.attention.questions === 0 &&
              latestView(feed, "ses_child")?.attention.permissions === 1 &&
              latestView(feed, "ses_root")?.attention.permissions === 1,
            "the cancelled question did not clear only the deep child",
          );

          yield* sendEvent(
            control,
            event("permission.replied", {
              sessionID: "ses_child",
              requestID: "per_child",
              reply: "once",
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the replied permission",
            (current) => latestView(current, "ses_child")?.attention.permissions === 0,
          );
          recorder.require(
            "permission-reply-clears-own",
            latestView(feed, "ses_child")?.attention.permissions === 0 &&
              latestView(feed, "ses_root")?.attention.permissions === 1,
            "the replied permission did not clear only the child",
          );
        }),
      );
    });

    await scenario(env, "attention-cross-kind", async (recorder) => {
      await controlSessions(
        control,
        [fixture("ses_root", { title: "Root" }), fixture("ses_child", { parentID: "ses_root" })],
        {},
      );
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("attention-cross-kind", "watcher", feed),
          );
          yield* waitForFeed(watcher, "the cross-kind family", (current) =>
            present(current, "ses_child"),
          );

          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_shared",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          yield* waitForFeed(
            watcher,
            "the permission before the question",
            (current) => latestView(current, "ses_child")?.attention.permissions === 1,
          );

          yield* sendEvent(
            control,
            event("form.created", {
              form: {
                id: "frm_shared",
                sessionID: "ses_child",
                title: "Shared suffix question",
                metadata: { kind: "question" },
                fields: [{ key: "answer", type: "string" }],
              },
            }),
          );
          let feed = yield* waitForFeed(
            watcher,
            "the question before the reply",
            (current) => latestView(current, "ses_child")?.attention.questions === 1,
          );
          recorder.require(
            "cross-kind-independent",
            latestView(feed, "ses_child")?.attention.permissions === 1 &&
              latestView(feed, "ses_child")?.attention.questions === 1,
            "a permission and a question interfered with each other",
          );

          yield* sendEvent(
            control,
            event("permission.replied", {
              sessionID: "ses_child",
              requestID: "per_shared",
              reply: "once",
            }),
          );
          feed = yield* waitForFeed(
            watcher,
            "the shared permission reply",
            (current) => latestView(current, "ses_child")?.attention.permissions === 0,
          );
          recorder.require(
            "cross-kind-reply-scoped",
            latestView(feed, "ses_child")?.attention.permissions === 0 &&
              latestView(feed, "ses_child")?.attention.questions === 1,
            "a permission reply interfered with the pending question",
          );
        }),
      );
    });

    await scenario(env, "root-archive", async (recorder) => {
      const root = fixture("ses_root", { title: "Root" });
      const child = fixture("ses_child", { parentID: "ses_root", title: "Child" });
      const deep = fixture("ses_deep", { parentID: "ses_child", title: "Deep child" });
      await controlSessions(control, [root, child, deep], {});
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("root-archive", "watcher", feed),
          );
          yield* waitForFeed(watcher, "the archive family", (current) =>
            present(current, "ses_deep"),
          );
          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_archive",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          yield* waitForFeed(
            watcher,
            "the child permission before archive",
            (current) => latestView(current, "ses_child")?.attention.permissions === 1,
          );

          yield* Effect.promise(() =>
            prepare(
              control,
              [fixture("ses_root", { title: "Root", archived: true }), child, deep],
              {},
            ),
          );
          yield* sendEvent(control, event("session.archived", { sessionID: "ses_root" }));
          const archived = yield* waitForFeed(
            watcher,
            "the archived root family",
            (current) =>
              absent(current, "ses_root") &&
              absent(current, "ses_child") &&
              absent(current, "ses_deep"),
          );
          recorder.require(
            "archive-root-removes-family",
            absent(archived, "ses_root") &&
              absent(archived, "ses_child") &&
              absent(archived, "ses_deep"),
            "the archived root family stayed visible",
          );

          yield* Effect.promise(() => prepare(control, [root, child, deep], {}));
          yield* sendEvent(control, event("session.unarchived", { sessionID: "ses_root" }));
          const unarchived = yield* waitForFeed(
            watcher,
            "the unarchived family with zero attention",
            (current) =>
              present(current, "ses_root") &&
              present(current, "ses_child") &&
              present(current, "ses_deep") &&
              latestView(current, "ses_deep")?.status === "idle" &&
              zeroAttention(current),
          );
          recorder.require(
            "unarchive-restores-family",
            present(unarchived, "ses_root") &&
              present(unarchived, "ses_child") &&
              present(unarchived, "ses_deep") &&
              latestView(unarchived, "ses_deep")?.status === "idle" &&
              zeroAttention(unarchived),
            "unarchive did not restore the whole family as idle with fresh zero attention",
          );

          const feedsBeforeLateReply = yield* Ref.get(watcher.feeds);
          yield* sendEvent(
            control,
            event("permission.replied", {
              sessionID: "ses_child",
              requestID: "per_archive",
              reply: "once",
            }),
          );
          yield* Effect.promise(() =>
            prepare(
              control,
              [fixture("ses_root", { title: "Root", updated: baseTime + 300_000 }), child, deep],
              {},
            ),
          );
          yield* sendEvent(
            control,
            event("session.metadata.updated", { sessionID: "ses_root", metadata: {} }),
          );
          const afterLateReply = yield* waitForFeed(
            watcher,
            "the root after a late reply",
            (current) => latestView(current, "ses_root")?.time.updated === baseTime + 300_000,
          );
          const feedsAfterBarrier = yield* Ref.get(watcher.feeds);
          recorder.require(
            "archive-late-reply-ignored",
            feedsAfterBarrier.length === feedsBeforeLateReply.length + 1 &&
              present(afterLateReply, "ses_root") &&
              present(afterLateReply, "ses_child") &&
              present(afterLateReply, "ses_deep") &&
              latestView(afterLateReply, "ses_deep")?.status === "idle" &&
              zeroAttention(afterLateReply),
            "the late reply for a forgotten request emitted its own feed or changed the fresh family",
            `feed count went ${feedsBeforeLateReply.length} -> ${feedsAfterBarrier.length}`,
          );

          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_after",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const fresh = yield* waitForFeed(
            watcher,
            "the fresh child permission",
            (current) => latestView(current, "ses_child")?.attention.permissions === 1,
          );
          recorder.require(
            "archive-new-request-counts-once",
            latestView(fresh, "ses_child")?.attention.permissions === 1 &&
              latestView(fresh, "ses_root")?.attention.permissions === 0 &&
              latestView(fresh, "ses_deep")?.attention.permissions === 0,
            "the fresh family request was not counted once on its owner",
          );
        }),
      );
    });

    await scenario(env, "delete-individual", async (recorder) => {
      const root = fixture("ses_root", { title: "Root" });
      const child = fixture("ses_child", { parentID: "ses_root", title: "Child" });
      const deep = fixture("ses_deep", { parentID: "ses_child", title: "Deep child" });
      await controlSessions(control, [root, child, deep], {});
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("delete-individual", "watcher", feed),
          );
          yield* waitForFeed(watcher, "the delete family", (current) =>
            present(current, "ses_deep"),
          );

          yield* Effect.promise(() => prepare(control, [root, child], {}));
          yield* sendEvent(control, event("session.deleted", { sessionID: "ses_deep" }));
          let feed = yield* waitForFeed(watcher, "the deleted deep child", (current) =>
            absent(current, "ses_deep"),
          );
          recorder.require(
            "delete-first-individual",
            absent(feed, "ses_deep") && present(feed, "ses_child") && present(feed, "ses_root"),
            "the first delete removed more than its own session",
          );

          yield* Effect.promise(() => prepare(control, [root], {}));
          yield* sendEvent(control, event("session.deleted", { sessionID: "ses_child" }));
          feed = yield* waitForFeed(watcher, "the deleted child", (current) =>
            absent(current, "ses_child"),
          );
          recorder.require(
            "delete-second-individual",
            absent(feed, "ses_child") && present(feed, "ses_root"),
            "the second delete removed the root",
          );

          yield* Effect.promise(() => prepare(control, [], {}));
          yield* sendEvent(control, event("session.deleted", { sessionID: "ses_root" }));
          feed = yield* waitForFeed(watcher, "the deleted root", (current) =>
            absent(current, "ses_root"),
          );
          recorder.require(
            "delete-final-individual",
            absent(feed, "ses_root"),
            "the final delete left the root visible",
          );
        }),
      );
    });
  })();

export const runLifecycle = (env: FeatureEnv): Promise<void> =>
  (async () => {
    const control = env.state.supervisor.control;
    const url = env.state.server.url;

    await scenario(env, "startup-zero-frontend", async (recorder) => {
      await controlSessions(control, [fixture("ses_root", { title: "Root" })], {});
      await openWatcherUntil(
        env,
        "startup-zero-frontend",
        "settle",
        url,
        (current) => present(current, "ses_root"),
        "the settled root projection",
      );

      const state = await controlState(control);
      recorder.require(
        "startup-one-source-and-seed",
        state.connections === env.state.startupConnections &&
          state.connections === 1 &&
          state.openConnections === 1,
        "the server did not keep one startup source connection",
        `startup ${env.state.startupConnections}, cumulative ${state.connections}, open ${state.openConnections}`,
      );

      await assertWatchAddsNoSourceRequests(recorder, env, "watch-start", () =>
        openWatcherUntil(
          env,
          "startup-zero-frontend",
          "watcher",
          url,
          (current) => present(current, "ses_root") && zeroAttention(current),
          "the root projection on a new watch",
        ),
      );
    });

    await scenario(env, "late-viewer-retains", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Root" }),
          fixture("ses_child", { parentID: "ses_root", title: "Child" }),
          fixture("ses_deep", { parentID: "ses_child", title: "Deep child" }),
        ],
        {},
      );

      const baseline = await controlState(control);
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const first = yield* startWatcher(client, (feed) =>
            env.frame("late-viewer-retains", "first", feed),
          );
          yield* waitForFeed(first, "the first viewer family", (current) =>
            present(current, "ses_deep"),
          );
          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_first",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          yield* waitForFeed(
            first,
            "the first viewer permission",
            (current) => latestView(current, "ses_child")?.attention.permissions === 1,
          );
          yield* Fiber.interrupt(first.fiber);
        }),
      );

      const afterClose = await controlState(control);
      recorder.require(
        "last-cancel-keeps-source",
        afterClose.connections === baseline.connections && afterClose.openConnections === 1,
        "closing the last viewer aborted the source connection",
        `connections ${baseline.connections} -> ${afterClose.connections}, open ${afterClose.openConnections}`,
      );

      await controlEvent(
        control,
        event("permission.asked", {
          id: "per_second",
          sessionID: "ses_child",
          action: "read",
          resources: ["*"],
        }),
      );
      await prepare(
        control,
        [
          fixture("ses_root", { title: "Root", updated: baseTime + 400_000 }),
          fixture("ses_child", { parentID: "ses_root", title: "Child" }),
          fixture("ses_deep", { parentID: "ses_child", title: "Deep child" }),
        ],
        {},
      );
      await controlEvent(
        control,
        event("session.metadata.updated", { sessionID: "ses_root", metadata: {} }),
      );

      const late = await openWatcherUntil(
        env,
        "late-viewer-retains",
        "late",
        url,
        (current) =>
          latestView(current, "ses_root")?.time.updated === baseTime + 400_000 &&
          latestView(current, "ses_child")?.attention.permissions === 2,
        "the retained attention at a late viewer",
      );
      recorder.require(
        "late-viewer-retains-attention",
        latestView(late, "ses_child")?.attention.permissions === 2 &&
          latestView(late, "ses_root")?.attention.permissions === 0 &&
          latestView(late, "ses_deep")?.attention.permissions === 0,
        "a late viewer did not receive attention observed while zero viewers were connected",
        `child permissions were ${latestView(late, "ses_child")?.attention.permissions}`,
      );
      const afterLate = await controlState(control);
      recorder.require(
        "late-viewer-no-new-source",
        afterLate.connections === baseline.connections && afterLate.openConnections === 1,
        "a late viewer opened a second source connection",
        `connections ${baseline.connections} -> ${afterLate.connections}, open ${afterLate.openConnections}`,
      );
    });

    await scenario(env, "two-frontends-shared-projection", async (recorder) => {
      await controlSessions(
        control,
        [
          fixture("ses_root", { title: "Root" }),
          fixture("ses_child", { parentID: "ses_root", title: "Child" }),
        ],
        {},
      );
      const baseline = await controlState(control);
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const first = yield* startWatcher(client, (feed) =>
            env.frame("two-frontends-shared-projection", "first", feed),
          );
          const second = yield* startWatcher(client, (feed) =>
            env.frame("two-frontends-shared-projection", "second", feed),
          );
          yield* Effect.all(
            [
              waitForFeed(first, "the first viewer family", (current) =>
                present(current, "ses_child"),
              ),
              waitForFeed(second, "the second viewer family", (current) =>
                present(current, "ses_child"),
              ),
            ],
            { concurrency: 2 },
          );
          const afterOpen = yield* Effect.promise(() => controlState(control));
          recorder.require(
            "two-frontends-one-source",
            afterOpen.connections === baseline.connections && afterOpen.openConnections === 1,
            "two viewers did not share the existing source connection",
            `connections ${baseline.connections} -> ${afterOpen.connections}, open ${afterOpen.openConnections}`,
          );

          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_shared",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const shared = yield* Effect.forEach(
            [first, second],
            (watcher) =>
              waitForFeed(
                watcher,
                "the shared child permission",
                (current) => latestView(current, "ses_child")?.attention.permissions === 1,
              ),
            { concurrency: 2 },
          );
          recorder.require(
            "two-frontends-same-projection",
            shared.every(
              (feed) =>
                latestView(feed, "ses_child")?.attention.permissions === 1 &&
                latestView(feed, "ses_root")?.attention.permissions === 0,
            ),
            "both viewers must receive the shared projection update",
          );

          yield* Fiber.interrupt(first.fiber);
          yield* sendEvent(
            control,
            event("permission.asked", {
              id: "per_shared_second",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const surviving = yield* waitForFeed(
            second,
            "the surviving viewer permission",
            (current) => latestView(current, "ses_child")?.attention.permissions === 2,
          );
          recorder.require(
            "cancel-one-leaves-other",
            latestView(surviving, "ses_child")?.attention.permissions === 2,
            "the surviving viewer missed an event after the other viewer left",
          );
          const afterCancel = yield* Effect.promise(() => controlState(control));
          recorder.require(
            "cancel-one-keeps-source",
            afterCancel.connections === baseline.connections && afterCancel.openConnections === 1,
            "cancelling one viewer aborted the shared source",
            `connections ${baseline.connections} -> ${afterCancel.connections}, open ${afterCancel.openConnections}`,
          );
        }),
      );
    });
  })();

export const runRpcErrors = (env: FeatureEnv): Promise<void> =>
  (async () => {
    const control = env.state.supervisor.control;
    const url = env.state.server.url;
    const cwd = env.state.worktree;

    await scenario(env, "snapshot", async (recorder) => {
      await controlSessions(control, [fixture("ses_root", { title: "RPC root" })], {});
      const feed = await openWatcherUntil(
        env,
        "snapshot",
        "watcher",
        url,
        (current) => present(current, "ses_root"),
        "the direct RPC projection",
      );
      const ids = [...feedIDs(feed)];
      await env.direct("snapshot", {
        sourceIDs: sourceIDs(feed),
        sessionIDs: ids,
      });
      recorder.require(
        "direct-snapshot-source",
        feed.length === 1 && feed[0]?.id === "local",
        "the typed RPC client did not observe the local source group",
        `source ids were ${sourceIDs(feed).join(", ") || "empty"}`,
      );
      recorder.require(
        "direct-snapshot-root",
        ids.length === 1 && ids[0] === "ses_root",
        "the typed RPC client did not observe the expected root",
        `the snapshot sessions were ${ids.join(", ") || "empty"}`,
      );
    });

    await scenario(env, "raw-protocol", async (recorder) => {
      const probe = await rawProbe(url, "chunk");
      env.rawFrames("raw-protocol", [
        {
          mode: "chunk",
          status: probe.status,
          contentType: probe.contentType,
          body: probe.body,
        },
      ]);
      await env.direct("raw-protocol", {
        status: probe.status,
        contentType: probe.contentType,
        hasChunk: probe.body.includes('"_tag":"Chunk"'),
      });
      recorder.require(
        "raw-http-200",
        probe.status === 200,
        "the raw RPC request did not return HTTP 200",
        `the raw RPC request returned HTTP ${probe.status}`,
      );
      recorder.require(
        "raw-ndjson",
        probe.contentType === "application/x-ndjson",
        "the raw RPC content type was not NDJSON",
        `the raw RPC content type was ${probe.contentType ?? "none"}`,
      );
      recorder.require(
        "raw-chunk-frame",
        probe.body.includes('"_tag":"Chunk"'),
        "the raw RPC response had no Chunk frame",
      );
    });

    await scenario(env, "closed-transport", async (recorder) => {
      const port = await freePort();
      const attempt = await attemptFeed(`http://127.0.0.1:${port}`, 10_000);
      await env.direct("closed-transport", {
        outcome: attempt.outcome,
        sourceIDs: attempt.sourceIDs,
        sessionIDs: attempt.sessionIDs,
        errorTag: attempt.errorTag ?? null,
        cause: attempt.cause === undefined ? null : sanitize(attempt.cause).slice(0, 4_000),
      });
      recorder.require(
        "closed-transport-fails",
        attempt.outcome === "Failure",
        "the direct client reported success against a closed port",
        `outcome ${attempt.outcome} tag ${attempt.errorTag ?? "none"}`,
      );
      recorder.require(
        "closed-transport-no-feed",
        attempt.sourceIDs.length === 0 && attempt.sessionIDs.length === 0,
        "the closed transport produced a feed or a session collection",
        `the native watch ended with ${attempt.outcome} and tag ${attempt.errorTag ?? "none"}`,
      );
    });

    await scenario(env, "missing-credentials", async (recorder) => {
      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("WEAVE_")),
      );
      const result = await runCommand(["bun", "run", "serve"], {
        cwd,
        env: { ...cleanEnv, WEAVE_PORT: "0" },
      });
      const output = `${result.stdout}${result.stderr}`;
      await env.direct("missing-credentials", {
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        output: sanitize(output).slice(-4_000),
      });
      recorder.require(
        "missing-credentials-nonzero",
        result.exitCode !== 0 && !result.timedOut,
        "the server did not exit non-zero without credentials",
        `the server exited ${result.exitCode} without OpenCode credentials`,
      );
      recorder.require(
        "missing-credentials-names-key",
        output.includes("WEAVE_OPENCODE_URL") || output.includes("WEAVE_OPENCODE_PASSWORD"),
        "the server did not name the missing OpenCode credential key",
        `the server exited ${result.exitCode} without naming WEAVE_OPENCODE_URL or WEAVE_OPENCODE_PASSWORD`,
      );
    });

    await scenario(env, "source-recovery", async (recorder) => {
      await controlSessions(control, [fixture("ses_root", { title: "Retained root" })], {});
      const before = await controlState(control);
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("source-recovery", "current", feed),
          );
          yield* waitForFeed(watcher, "the pre-drop projection", (feed) =>
            present(feed, "ses_root"),
          );
          yield* Effect.promise(() => controlEnd(control));
          const outage = yield* waitForFeed(
            watcher,
            "source reconnecting",
            (feed) => feed[0]?.health.kind === "reconnecting",
          );
          recorder.require(
            "drop-retains-sessions",
            present(outage, "ses_root"),
            "the outage cleared the last sessions",
          );
          recorder.require(
            "drop-keeps-watch",
            watcher.fiber.pollUnsafe() === undefined,
            "the watch ended during reconnect",
          );
          yield* Effect.promise(() =>
            controlSessions(control, [fixture("ses_fresh")], {}, { reset: false }),
          );
          const recovered = yield* waitForFeed(
            watcher,
            "fresh connected snapshot",
            (feed) => feed[0]?.health.kind === "connected" && present(feed, "ses_fresh"),
          );
          recorder.require(
            "recovery-replaces-snapshot",
            absent(recovered, "ses_root"),
            "the recovery retained a deleted session",
          );
          const after = yield* Effect.promise(() => controlState(control));
          recorder.require(
            "recovery-one-source",
            after.connections === before.connections + 1 && after.openConnections === 1,
            "recovery did not open exactly one replacement source",
          );
          yield* Effect.promise(() => controlEnd(control));
          const second = yield* waitForFeed(
            watcher,
            "reset retry budget",
            (feed) => feed[0]?.health.kind === "reconnecting",
          );
          recorder.require(
            "seed-resets-budget",
            second[0]?.health.kind === "reconnecting" && second[0].health.retry === 1,
            "a successful seed did not reset the retry budget",
          );
        }),
      );
      await Bun.sleep(1_200);
      const withoutViewers = await controlState(control);
      recorder.require(
        "zero-viewer-source-connected",
        withoutViewers.connections === before.connections + 2 &&
          withoutViewers.openConnections === 1,
        "the source did not reconnect before the next viewer",
      );
      const later = await openWatcherUntil(
        env,
        "source-recovery",
        "later",
        url,
        (feed) => feed[0]?.health.kind === "connected" && present(feed, "ses_fresh"),
        "zero-viewer recovery",
      );
      recorder.require(
        "zero-viewer-recovery",
        present(later, "ses_fresh"),
        "the source did not recover with zero viewers",
      );
    });

    await scenario(env, "source-exhaustion", async (recorder) => {
      const before = await controlState(control);
      await controlSeedFailure(control, true);
      await withClient(url, (client) =>
        Effect.gen(function* () {
          const watcher = yield* startWatcher(client, (feed) =>
            env.frame("source-exhaustion", "current", feed),
          );
          yield* waitForFeed(watcher, "pre-exhaustion sessions", (feed) =>
            present(feed, "ses_fresh"),
          );
          yield* Effect.promise(() => controlEnd(control));
          const exhausted = yield* waitForFeed(
            watcher,
            "bounded source exhaustion",
            (feed) => feed[0]?.health.kind === "unavailable",
            200_000,
          );
          const state = yield* Effect.promise(() => controlState(control));
          recorder.require(
            "exhaustion-ten-retries",
            state.connections === before.connections + 10,
            "the source did not stop after ten retries",
            `connections ${before.connections} -> ${state.connections}`,
          );
          recorder.require(
            "seed-failure-closes-sse",
            state.openConnections === 0,
            "a failed seed leaked an SSE connection",
          );
          recorder.require(
            "exhaustion-retains-sessions",
            present(exhausted, "ses_fresh"),
            "exhaustion cleared retained sessions",
          );
          recorder.require(
            "exhaustion-watch-alive",
            watcher.fiber.pollUnsafe() === undefined,
            "source exhaustion ended the watch",
          );
          const later = yield* startWatcher(client, (feed) =>
            env.frame("source-exhaustion", "later", feed),
          );
          const current = yield* waitForFeed(
            later,
            "later unavailable feed",
            (feed) => feed[0]?.health.kind === "unavailable",
          );
          recorder.require(
            "exhaustion-later-watch",
            present(current, "ses_fresh") && later.fiber.pollUnsafe() === undefined,
            "a later watch did not retain the unavailable source",
          );
          const probe = yield* Effect.promise(() => rawProbe(url, "chunk"));
          env.rawFrames("source-exhaustion", [{ mode: "chunk", ...probe }]);
          recorder.require(
            "exhaustion-raw-chunk",
            probe.status === 200 &&
              probe.contentType === "application/x-ndjson" &&
              probe.body.includes('"_tag":"Chunk"') &&
              !probe.body.includes('"_tag":"Exit"'),
            "source exhaustion was not carried in a live Chunk frame",
          );
          yield* Effect.promise(() => controlSeedFailure(control, false));
          yield* Effect.sleep("1200 millis");
          const final = yield* Effect.promise(() => controlState(control));
          recorder.require(
            "exhaustion-no-more-attempts",
            final.connections === state.connections && final.openConnections === 0,
            "the exhausted source restarted itself",
          );
        }),
      );
      await controlStopUpstream(control);
    });

    await scenario(env, "no-secrets", async (recorder) => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const files = readdirSync(env.state.run, { recursive: true, encoding: "utf8" })
        .map((entry) => join(env.state.run, entry))
        .filter((entry) => statSync(entry).isFile());
      const leaked = files.filter((file) => {
        const text = readFileSync(file, "utf8");
        return hasSecretValue(text);
      });
      recorder.require(
        "no-secret-values-in-evidence",
        leaked.length === 0,
        `secret values appeared in ${leaked.join(", ") || "no files"}`,
        `no controlled secret value in ${files.length} evidence files`,
      );
    });
  })();

export type FeatureRunner = (env: FeatureEnv) => Promise<void>;

export const featureRunners: Readonly<Record<string, FeatureRunner>> = {
  snapshot: runSnapshot,
  "live-updates-attention": runLiveUpdates,
  lifecycle: runLifecycle,
  "rpc-errors": runRpcErrors,
};
