import { Session } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/client/effect";
import { Context, Duration, Effect, Layer, Schedule, Sink, Stream, SubscriptionRef } from "effect";
import { RequestFailed } from "../shared/errors.ts";
import { SessionAttention } from "../shared/session.ts";
import type {
  SessionFeed,
  SourceSessions,
  SessionSummary,
  SessionView,
} from "../shared/session.ts";
import * as OpenCodeSessions from "./opencode.ts";
import { toSessionView } from "./session-view.ts";

type Status = SessionView["status"];
type Kind = "permissions" | "questions";

interface Tracked {
  readonly summary: SessionSummary;
  readonly status: Status;
}

interface Pending {
  readonly kind: Kind;
  readonly sessionID: string;
}

interface WatchState {
  readonly records: Map<string, Tracked>;
  readonly pending: Map<string, Pending>;
}

const makeState = (): WatchState => ({
  records: new Map(),
  pending: new Map(),
});

const remember = (state: WatchState, summary: SessionSummary, status?: Status): void => {
  const existing = state.records.get(summary.id);
  state.records.set(summary.id, {
    summary,
    status: status ?? existing?.status ?? "idle",
  });
};

const reachesRoot = (state: WatchState, sessionID: string): boolean => {
  let current = state.records.get(sessionID);

  while (current !== undefined) {
    if (current.summary.time.archived !== undefined) return false;

    const parentID = current.summary.parentID;
    if (parentID === undefined) return true;

    current = state.records.get(parentID);
  }

  return false;
};

const prune = (state: WatchState): void => {
  for (const id of state.records.keys()) {
    if (!reachesRoot(state, id)) state.records.delete(id);
  }
};

const attentionFor = (state: WatchState, sessionID: string): SessionAttention => {
  let permissions = 0;
  let questions = 0;

  for (const pending of state.pending.values()) {
    if (pending.sessionID !== sessionID) continue;

    if (pending.kind === "permissions") permissions += 1;
    else questions += 1;
  }

  return SessionAttention.make({ permissions, questions });
};

const sourceFor = (id: string, state: WatchState): SourceSessions => {
  const sessions: Array<SessionView> = [];

  for (const [id, tracked] of state.records) {
    if (!reachesRoot(state, id)) continue;

    sessions.push(toSessionView(tracked.summary, tracked.status, attentionFor(state, id)));
  }

  return { id, health: { kind: "connected" }, sessions };
};

const getSummary = (
  opencode: OpenCodeSessions.Interface,
  id: string,
): Effect.Effect<SessionSummary | undefined, RequestFailed> =>
  opencode
    .get(Session.ID.make(id))
    .pipe(Effect.catchTag("SessionNotFoundError", () => Effect.undefined));

const resolveRoute = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
  sessionID: string,
  summary?: SessionSummary,
): Effect.Effect<ReadonlyArray<SessionSummary> | undefined, RequestFailed> =>
  Effect.gen(function* () {
    const additions: Array<SessionSummary> = [];
    let currentID = sessionID;
    let current = summary;

    while (true) {
      if (current === undefined) {
        current = yield* getSummary(opencode, currentID);
        if (current === undefined) return undefined;
        if (!state.records.has(currentID)) additions.push(current);
      }

      if (current.time.archived !== undefined) return undefined;
      if (current.parentID === undefined) return additions;

      const parentID = current.parentID;
      const parent = state.records.get(parentID);
      currentID = parentID;
      current = parent?.summary;
    }
  });

const record = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
  summary: SessionSummary,
): Effect.Effect<boolean, RequestFailed> =>
  Effect.gen(function* () {
    const additions = yield* resolveRoute(opencode, state, summary.id, summary);
    if (additions === undefined) return false;

    for (const addition of additions) remember(state, addition);
    remember(state, summary);
    return true;
  });

const transition = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
  id: string,
  status: Status,
): Effect.Effect<boolean, RequestFailed> =>
  Effect.gen(function* () {
    const summary = yield* getSummary(opencode, id);
    if (summary === undefined) return false;

    const additions = yield* resolveRoute(opencode, state, id, summary);
    if (additions === undefined) return false;

    for (const addition of additions) remember(state, addition);
    remember(state, summary, status);
    return true;
  });

const forgetFamily = (state: WatchState, rootID: string): boolean => {
  const root = state.records.get(rootID);
  if (root === undefined || root.summary.parentID !== undefined) return false;

  const family = new Set<string>();

  for (const [id, tracked] of state.records) {
    let current = tracked.summary;

    while (true) {
      if (current.id === rootID) {
        family.add(id);
        break;
      }

      const parentID = current.parentID;
      if (parentID === undefined) break;

      const parent = state.records.get(parentID);
      if (parent === undefined) break;

      current = parent.summary;
    }
  }

  for (const id of family) state.records.delete(id);

  for (const [key, pending] of state.pending) {
    if (family.has(pending.sessionID)) state.pending.delete(key);
  }

  return true;
};

const forgetSession = (state: WatchState, id: string): boolean => {
  const removed = state.records.delete(id);

  for (const [key, pending] of state.pending) {
    if (pending.sessionID === id) state.pending.delete(key);
  }

  return removed;
};

const asked = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
  kind: Kind,
  requestID: string,
  sessionID: string,
): Effect.Effect<boolean, RequestFailed> =>
  Effect.gen(function* () {
    const additions = yield* resolveRoute(opencode, state, sessionID);
    if (additions === undefined) return false;

    for (const addition of additions) remember(state, addition);
    state.pending.set(`${kind}:${requestID}`, { kind, sessionID });
    return true;
  });

const replied = (state: WatchState, kind: Kind, requestID: string): boolean => {
  const key = `${kind}:${requestID}`;
  if (!state.pending.has(key)) return false;

  state.pending.delete(key);
  return true;
};

const apply = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
  event: OpenCodeEvent,
): Effect.Effect<boolean, RequestFailed> => {
  switch (event.type) {
    case "session.created":
    case "session.renamed":
    case "session.moved":
    case "session.metadata.updated":
    case "session.viewed":
      return Effect.gen(function* () {
        const summary = yield* getSummary(opencode, event.data.sessionID);
        if (summary === undefined) return false;
        return yield* record(opencode, state, summary);
      });
    case "session.unarchived":
      return seed(opencode, state).pipe(Effect.as(true));
    case "session.archived":
      return Effect.succeed(forgetFamily(state, event.data.sessionID));
    case "session.deleted":
      return Effect.succeed(forgetSession(state, event.data.sessionID));
    case "session.execution.started":
      return transition(opencode, state, event.data.sessionID, "running");
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
    case "session.idle":
      return transition(opencode, state, event.data.sessionID, "idle");
    case "session.status":
      return transition(
        opencode,
        state,
        event.data.sessionID,
        event.data.status.type === "idle" ? "idle" : "running",
      );
    case "permission.asked":
      return asked(opencode, state, "permissions", event.data.id, event.data.sessionID);
    case "permission.replied":
      return Effect.succeed(replied(state, "permissions", event.data.requestID));
    case "form.created":
      return event.data.form.metadata?.kind === "question"
        ? asked(opencode, state, "questions", event.data.form.id, event.data.form.sessionID)
        : Effect.succeed(false);
    case "form.replied":
    case "form.cancelled":
      return Effect.succeed(replied(state, "questions", event.data.id));
    default:
      return Effect.succeed(false);
  }
};

const seed = (
  opencode: OpenCodeSessions.Interface,
  state: WatchState,
): Effect.Effect<void, RequestFailed> =>
  Effect.gen(function* () {
    const [summaries, activeIDs] = yield* Effect.all(
      [opencode.readSessions, opencode.readActiveIDs],
      { concurrency: "unbounded" },
    );
    const active = new Set<string>(activeIDs);

    for (const summary of summaries) {
      if (summary.time.archived !== undefined) continue;
      remember(state, summary, active.has(summary.id) ? "running" : "idle");
    }

    prune(state);
  });

export interface Interface {
  readonly watchSessions: Stream.Stream<SessionFeed, RequestFailed>;
}

export class Service extends Context.Service<Service, Interface>()("@weave/SessionWatch") {}

const projection = (
  id: string,
  opencode: OpenCodeSessions.Interface,
): Stream.Stream<SourceSessions, RequestFailed> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const [head, rest] = yield* Stream.peel(
        opencode.events.pipe(Stream.buffer({ capacity: 4096 })),
        Sink.take(1),
      );
      const connected = head[0];

      if (connected === undefined || connected.type !== "server.connected") {
        return yield* new RequestFailed();
      }

      const state = makeState();
      yield* seed(opencode, state);
      return Stream.succeed(sourceFor(id, state)).pipe(
        Stream.concat(
          rest.pipe(
            Stream.mapEffect((event) =>
              apply(opencode, state, event).pipe(
                Effect.map((changed) => (changed ? sourceFor(id, state) : undefined)),
              ),
            ),
            Stream.filter((feed) => feed !== undefined),
          ),
        ),
      );
    }),
  );

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sources = yield* OpenCodeSessions.Service;
    const view = yield* SubscriptionRef.make<SessionFeed>(
      sources.map(({ id }) => ({ id, health: { kind: "connecting" }, sessions: [] })),
    );

    for (const { id, client } of sources) {
      const update = (f: (source: SourceSessions) => SourceSessions) =>
        SubscriptionRef.update(view, (feed) =>
          feed.map((source) => (source.id === id ? f(source) : source)),
        );
      const retry = Schedule.exponential("1 second").pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, Duration.seconds(30))),
        ),
        Schedule.upTo({ times: 10 }),
        Schedule.tap(({ attempt, duration }) =>
          update((source) => ({
            id: source.id,
            sessions: source.sessions,
            health: {
              kind: "reconnecting",
              retry: attempt,
              retryDelayMs: Duration.toMillis(duration),
            },
          })),
        ),
      );

      yield* projection(id, client).pipe(
        Stream.retry(retry),
        Stream.runForEach((source) => update(() => source)),
        Effect.catchTag("OpenCodeSessions.RequestFailed", () =>
          update((source) => ({
            id: source.id,
            sessions: source.sessions,
            health: { kind: "unavailable" },
          })),
        ),
        Effect.forkScoped,
      );
    }

    return Service.of({ watchSessions: SubscriptionRef.changes(view) });
  }),
);
