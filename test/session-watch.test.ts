import { afterEach, describe, expect, test } from "vitest";
import {
  ConfigProvider,
  Context,
  Effect,
  Fiber,
  Layer,
  Queue,
  Result,
  Schema,
  Stream,
} from "effect";
import * as OpenCodeSessions from "../src/server/opencode.ts";
import * as SessionWatch from "../src/server/session-watch.ts";
import type { RequestFailed } from "../src/shared/errors.ts";
import { SessionFeed } from "../src/shared/session.ts";
import type { SessionView, SourceSessions } from "../src/shared/session.ts";
import {
  eventFrame,
  startFakeOpenCode,
  testPassword,
  type FakeOpenCode,
  type FakeResponse,
  type SessionFixture,
} from "./support/fake-opencode.ts";

type TestConfig = Record<string, string | undefined>;

const cleanup: Array<() => Promise<void> | void> = [];
let eventSequence = 0;

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

const startUpstream = (response: FakeResponse): FakeOpenCode => {
  const upstream = startFakeOpenCode(response);
  cleanup.push(upstream.stop);
  return upstream;
};

const configFor = (upstream: FakeOpenCode): TestConfig => ({
  WEAVE_OPENCODE_URL: upstream.url,
  WEAVE_OPENCODE_PASSWORD: testPassword,
});

const event = (type: string, data: Readonly<Record<string, unknown>>): unknown => {
  eventSequence += 1;
  return eventFrame(type, data, {
    id: `evt_${eventSequence}`,
    created: 1_700_000_000_000 + eventSequence,
    seq: eventSequence,
  });
};

const runWatch = <A>(
  config: TestConfig,
  effect: Effect.Effect<A, RequestFailed, SessionWatch.Service>,
) =>
  Effect.runPromise(
    Effect.result(
      effect.pipe(
        Effect.provide(SessionWatch.layer.pipe(Layer.provide(OpenCodeSessions.layer)), {
          local: true,
        }),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
      ),
    ),
  );

const unwrap = <A>(result: Result.Result<A, unknown>): A => {
  if (Result.isFailure(result)) {
    throw new Error(`Expected a watch value, received ${String(result.failure)}`);
  }

  return result.success;
};

const startWatch = (service: SessionWatch.Interface) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SessionFeed>();
    const fiber = yield* Effect.forkScoped(
      service.watchSessions.pipe(
        Stream.filter((feed) => localSource(feed).health.kind === "connected"),
        Stream.runForEach((feed) => Queue.offer(queue, feed)),
      ),
    );

    return { queue, fiber };
  });

const nextFeed = (queue: Queue.Dequeue<SessionFeed>): Effect.Effect<SessionFeed, never, never> =>
  Queue.take(queue);

const localSource = (feed: SessionFeed): SourceSessions => {
  const source = feed.find((item) => item.id === "local");

  if (source === undefined) {
    throw new Error("Expected the local source");
  }

  return source;
};

const sessionIDs = (feed: SessionFeed): Array<string> =>
  localSource(feed).sessions.map((session) => session.id);

const viewOf = (feed: SessionFeed, id: string): SessionView => {
  const session = localSource(feed).sessions.find((item) => item.id === id);

  if (session === undefined) {
    throw new Error(`Expected a session view for ${id}`);
  }

  return session;
};

const attentionOf = (feed: SessionFeed, id: string): SessionView["attention"] =>
  viewOf(feed, id).attention;

const expectWire = (feed: SessionFeed): void => {
  expect(Schema.decodeSync(SessionFeed)(feed)).toEqual(feed);
};

const requestCount = (upstream: FakeOpenCode, pathname: string): number =>
  upstream.requests.filter((request) => new URL(request.url).pathname === pathname).length;

const seedReads = (
  upstream: FakeOpenCode,
): { readonly lists: number; readonly active: number } => ({
  lists: requestCount(upstream, "/api/session"),
  active: requestCount(upstream, "/api/session/active"),
});

const waitFor = (description: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (predicate()) return;
      yield* Effect.sleep("10 millis");
    }

    throw new Error(`Timed out waiting for ${description}.`);
  });

describe("SessionWatch.watchSessions", () => {
  test("seeds one local feed with every reachable descendant and own attention", async () => {
    const upstream = startUpstream({
      sessions: [
        { id: "ses_root", title: "Root", directory: "/work/a" },
        { id: "ses_child", parentID: "ses_root", directory: "/work/a", outcome: "failed" },
        { id: "ses_grandchild", parentID: "ses_child", directory: "/work/a" },
        { id: "ses_idle_root", directory: "/work/b" },
        { id: "ses_orphan", parentID: "ses_missing", directory: "/work/a" },
        { id: "ses_archived", directory: "/work/a", archived: true },
        { id: "ses_archived_child", parentID: "ses_archived", directory: "/work/a" },
      ],
      active: {
        ses_root: { type: "running" },
        ses_child: { type: "running" },
      },
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          const initial = yield* nextFeed(watch.queue);

          expectWire(initial);

          const source = localSource(initial);
          expect(source.id).toBe("local");
          expect(source.sessions.map((session) => session.id).toSorted()).toEqual([
            "ses_child",
            "ses_grandchild",
            "ses_idle_root",
            "ses_root",
          ]);

          expect(viewOf(initial, "ses_root")).toMatchObject({
            title: "Root",
            status: "running",
            attention: { permissions: 0, questions: 0 },
          });
          expect(viewOf(initial, "ses_child")).toMatchObject({
            parentID: "ses_root",
            outcome: "failed",
            status: "running",
            attention: { permissions: 0, questions: 0 },
          });
          expect(viewOf(initial, "ses_grandchild")).toMatchObject({
            parentID: "ses_child",
            status: "idle",
            attention: { permissions: 0, questions: 0 },
          });
          expect(viewOf(initial, "ses_idle_root").status).toBe("idle");
        }),
      ),
    );

    unwrap(result);
  });

  test("drains the global list across pages and keeps idle children and grandchildren", async () => {
    const timestamp = 1_700_000_000_000;
    const roots: ReadonlyArray<SessionFixture> = Array.from({ length: 501 }, (_, index) => ({
      id: `ses_root_${String(index).padStart(3, "0")}`,
      directory: "/work/a",
      updated: timestamp + 1000 - index,
    }));
    const upstream = startUpstream({
      sessions: [
        ...roots,
        {
          id: "ses_child",
          parentID: "ses_root_000",
          directory: "/work/a",
          updated: timestamp + 500,
        },
        {
          id: "ses_grandchild",
          parentID: "ses_child",
          directory: "/work/a",
          updated: timestamp + 400,
        },
        {
          id: "ses_archived_child",
          parentID: "ses_archived_root",
          directory: "/work/a",
          updated: timestamp + 300,
        },
        { id: "ses_archived_root", directory: "/work/a", archived: true },
      ],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          const initial = yield* nextFeed(watch.queue);
          const ids = sessionIDs(initial);

          expect(ids).toHaveLength(503);
          expect(ids).toContain("ses_root_000");
          expect(ids).toContain("ses_root_500");
          expect(ids).toContain("ses_child");
          expect(ids).toContain("ses_grandchild");
          expect(ids).not.toContain("ses_archived_child");
          expect(viewOf(initial, "ses_child").status).toBe("idle");
          expect(viewOf(initial, "ses_grandchild").status).toBe("idle");
        }),
      ),
    );

    unwrap(result);
  });

  test("preserves status across summary replacement and clears omitted fields", async () => {
    const root: SessionFixture = {
      id: "ses_root",
      title: "Before",
      directory: "/work/a",
      updated: 100,
      outcome: "succeeded",
    };
    const upstream = startUpstream({
      sessions: [
        root,
        {
          id: "ses_idle_child",
          parentID: "ses_root",
          directory: "/work/a",
          outcome: "failed",
        },
      ],
      active: { ses_root: { type: "running" } },
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          yield* nextFeed(watch.queue);

          upstream.setSessions([
            { id: "ses_root", directory: "/work/a", updated: 200 },
            {
              id: "ses_idle_child",
              parentID: "ses_root",
              directory: "/work/a",
              outcome: "failed",
            },
          ]);
          upstream.events.send(
            event("session.renamed", {
              sessionID: "ses_root",
              title: "After",
            }),
          );
          const renamed = yield* nextFeed(watch.queue);
          const renamedRoot = viewOf(renamed, "ses_root");

          expect(renamedRoot.status).toBe("running");
          expect(renamedRoot.title).toBeUndefined();
          expect(renamedRoot.outcome).toBeUndefined();
          expect(renamedRoot.time.updated).toBe(200);

          upstream.setSessions([
            {
              id: "ses_root",
              directory: "/work/a",
              updated: 300,
              outcome: "failed",
            },
            {
              id: "ses_idle_child",
              parentID: "ses_root",
              directory: "/work/a",
              outcome: "failed",
            },
          ]);
          upstream.events.send(
            event("session.execution.failed", {
              sessionID: "ses_root",
              error: { type: "unknown", message: "execution failed" },
            }),
          );
          const failed = yield* nextFeed(watch.queue);
          const failedRoot = viewOf(failed, "ses_root");

          expect(failedRoot.status).toBe("idle");
          expect(failedRoot.outcome).toBe("failed");
          expect(failedRoot.time.updated).toBe(300);
          expect(viewOf(failed, "ses_idle_child")).toMatchObject({
            status: "idle",
            outcome: "failed",
          });
        }),
      ),
    );

    unwrap(result);
  });

  test("counts requests on the session that owns them without a family rollup", async () => {
    const upstream = startUpstream({
      sessions: [
        { id: "ses_root", directory: "/work/a" },
        { id: "ses_child", parentID: "ses_root", directory: "/work/a" },
      ],
      active: { ses_child: { type: "running" } },
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          yield* nextFeed(watch.queue);

          upstream.events.send(
            event("permission.asked", {
              id: "per_1",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const first = yield* nextFeed(watch.queue);
          expect(attentionOf(first, "ses_child")).toEqual({ permissions: 1, questions: 0 });
          expect(attentionOf(first, "ses_root")).toEqual({ permissions: 0, questions: 0 });

          upstream.events.send(
            event("permission.replied", {
              sessionID: "ses_child",
              requestID: "per_missing",
              reply: "once",
            }),
          );
          upstream.events.send(
            event("permission.asked", {
              id: "per_2",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const second = yield* nextFeed(watch.queue);
          expect(attentionOf(second, "ses_child")).toEqual({ permissions: 2, questions: 0 });

          upstream.events.send(
            event("form.created", {
              form: {
                id: "frm_1",
                sessionID: "ses_child",
                title: "Question",
                metadata: { kind: "question" },
                fields: [{ key: "answer", type: "string" }],
              },
            }),
          );
          const third = yield* nextFeed(watch.queue);
          expect(attentionOf(third, "ses_child")).toEqual({ permissions: 2, questions: 1 });
          expect(attentionOf(third, "ses_root")).toEqual({ permissions: 0, questions: 0 });

          upstream.events.send(
            event("form.replied", {
              id: "frm_1",
              sessionID: "ses_child",
              answer: {},
            }),
          );
          const fourth = yield* nextFeed(watch.queue);
          expect(attentionOf(fourth, "ses_child")).toEqual({ permissions: 2, questions: 0 });

          upstream.events.send(
            event("form.created", {
              form: {
                id: "frm_2",
                sessionID: "ses_root",
                title: "Question",
                metadata: { kind: "question" },
                fields: [{ key: "answer", type: "string" }],
              },
            }),
          );
          const fifth = yield* nextFeed(watch.queue);
          expect(attentionOf(fifth, "ses_root")).toEqual({ permissions: 0, questions: 1 });

          upstream.events.send(
            event("form.cancelled", {
              id: "frm_2",
              sessionID: "ses_root",
            }),
          );
          const sixth = yield* nextFeed(watch.queue);
          expect(attentionOf(sixth, "ses_root")).toEqual({ permissions: 0, questions: 0 });
        }),
      ),
    );

    unwrap(result);
  });

  test("fetches a missing route for a late request and keeps idle descendants", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          yield* nextFeed(watch.queue);

          upstream.setSessions([
            { id: "ses_root", directory: "/work/a" },
            { id: "ses_child", parentID: "ses_root", directory: "/work/a" },
            { id: "ses_grandchild", parentID: "ses_child", directory: "/work/a" },
          ]);
          upstream.events.send(
            event("permission.asked", {
              id: "per_late",
              sessionID: "ses_grandchild",
              action: "read",
              resources: ["*"],
            }),
          );
          const late = yield* nextFeed(watch.queue);

          expect(sessionIDs(late).toSorted()).toEqual(["ses_child", "ses_grandchild", "ses_root"]);
          expect(attentionOf(late, "ses_grandchild")).toEqual({
            permissions: 1,
            questions: 0,
          });
          expect(attentionOf(late, "ses_child")).toEqual({ permissions: 0, questions: 0 });
          expect(attentionOf(late, "ses_root")).toEqual({ permissions: 0, questions: 0 });
          expect(viewOf(late, "ses_child").status).toBe("idle");
          expect(viewOf(late, "ses_grandchild").status).toBe("idle");
        }),
      ),
    );

    unwrap(result);
  });

  test("archives a whole root family and unarchives at zero", async () => {
    const root: SessionFixture = { id: "ses_root", directory: "/work/a" };
    const child: SessionFixture = {
      id: "ses_child",
      parentID: "ses_root",
      directory: "/work/a",
    };
    const grandchild: SessionFixture = {
      id: "ses_grandchild",
      parentID: "ses_child",
      directory: "/work/a",
    };
    const otherRoot: SessionFixture = { id: "ses_other_root", directory: "/work/b" };
    const otherChild: SessionFixture = {
      id: "ses_other_child",
      parentID: "ses_other_root",
      directory: "/work/b",
    };
    const upstream = startUpstream({
      sessions: [root, child, grandchild, otherRoot, otherChild],
      active: { ses_child: { type: "running" } },
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          yield* nextFeed(watch.queue);

          upstream.events.send(
            event("permission.asked", {
              id: "per_other",
              sessionID: "ses_other_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const otherAsked = yield* nextFeed(watch.queue);
          expect(attentionOf(otherAsked, "ses_other_child")).toEqual({
            permissions: 1,
            questions: 0,
          });

          upstream.events.send(
            event("permission.asked", {
              id: "per_1",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const asked = yield* nextFeed(watch.queue);
          expect(attentionOf(asked, "ses_child")).toEqual({ permissions: 1, questions: 0 });

          upstream.setSessions([
            { ...root, archived: true },
            child,
            grandchild,
            otherRoot,
            otherChild,
          ]);
          upstream.events.send(event("session.archived", { sessionID: "ses_root" }));
          const archived = yield* nextFeed(watch.queue);
          expect(sessionIDs(archived).toSorted()).toEqual(["ses_other_child", "ses_other_root"]);
          expect(attentionOf(archived, "ses_other_child")).toEqual({
            permissions: 1,
            questions: 0,
          });

          upstream.setSessions([root, child, grandchild, otherRoot, otherChild]);
          upstream.events.send(event("session.unarchived", { sessionID: "ses_root" }));
          const unarchived = yield* nextFeed(watch.queue);
          expect(sessionIDs(unarchived).toSorted()).toEqual([
            "ses_child",
            "ses_grandchild",
            "ses_other_child",
            "ses_other_root",
            "ses_root",
          ]);
          expect(attentionOf(unarchived, "ses_root")).toEqual({
            permissions: 0,
            questions: 0,
          });
          expect(attentionOf(unarchived, "ses_child")).toEqual({
            permissions: 0,
            questions: 0,
          });
          expect(attentionOf(unarchived, "ses_grandchild")).toEqual({
            permissions: 0,
            questions: 0,
          });
          expect(viewOf(unarchived, "ses_grandchild").status).toBe("idle");
          expect(attentionOf(unarchived, "ses_other_child")).toEqual({
            permissions: 1,
            questions: 0,
          });

          upstream.events.send(
            event("permission.asked", {
              id: "per_2",
              sessionID: "ses_child",
              action: "read",
              resources: ["*"],
            }),
          );
          const fresh = yield* nextFeed(watch.queue);
          expect(sessionIDs(fresh).toSorted()).toEqual([
            "ses_child",
            "ses_grandchild",
            "ses_other_child",
            "ses_other_root",
            "ses_root",
          ]);
          expect(attentionOf(fresh, "ses_child")).toEqual({ permissions: 1, questions: 0 });
          expect(attentionOf(fresh, "ses_root")).toEqual({ permissions: 0, questions: 0 });
          expect(attentionOf(fresh, "ses_other_child")).toEqual({
            permissions: 1,
            questions: 0,
          });
        }),
      ),
    );

    unwrap(result);
  });

  test("deletes native child-first without removing sibling state", async () => {
    const upstream = startUpstream({
      sessions: [
        { id: "ses_root", directory: "/work/a" },
        { id: "ses_mid", parentID: "ses_root", directory: "/work/a" },
        { id: "ses_grandchild", parentID: "ses_mid", directory: "/work/a" },
        { id: "ses_sibling", parentID: "ses_root", directory: "/work/a" },
      ],
      active: { ses_grandchild: { type: "running" } },
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          yield* nextFeed(watch.queue);

          upstream.events.send(
            event("permission.asked", {
              id: "per_grand",
              sessionID: "ses_grandchild",
              action: "read",
              resources: ["*"],
            }),
          );
          const asked = yield* nextFeed(watch.queue);
          expect(attentionOf(asked, "ses_grandchild")).toEqual({
            permissions: 1,
            questions: 0,
          });

          upstream.events.send(event("session.deleted", { sessionID: "ses_grandchild" }));
          const grandDeleted = yield* nextFeed(watch.queue);
          expect(sessionIDs(grandDeleted).toSorted()).toEqual([
            "ses_mid",
            "ses_root",
            "ses_sibling",
          ]);

          upstream.events.send(event("session.deleted", { sessionID: "ses_mid" }));
          const midDeleted = yield* nextFeed(watch.queue);
          expect(sessionIDs(midDeleted).toSorted()).toEqual(["ses_root", "ses_sibling"]);

          upstream.events.send(event("session.deleted", { sessionID: "ses_root" }));
          const rootDeleted = yield* nextFeed(watch.queue);
          expect(sessionIDs(rootDeleted)).toEqual([]);
        }),
      ),
    );

    unwrap(result);
  });

  test("emits a live empty feed after an empty seed", async () => {
    const upstream = startUpstream({ sessions: [] });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const watch = yield* startWatch(service);
          const initial = yield* nextFeed(watch.queue);

          expectWire(initial);
          expect(initial).toEqual([{ id: "local", health: { kind: "connected" }, sessions: [] }]);
        }),
      ),
    );

    unwrap(result);
  });

  test("starts one upstream and one seed before the first viewer", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;

          yield* waitFor(
            "the startup connection and seed",
            () =>
              upstream.events.connections() === 1 &&
              upstream.events.open() === 1 &&
              requestCount(upstream, "/api/session") >= 2 &&
              requestCount(upstream, "/api/session/active") === 1,
          );

          const before = seedReads(upstream);
          const watch = yield* startWatch(service);
          const initial = yield* nextFeed(watch.queue);

          expect(sessionIDs(initial)).toEqual(["ses_root"]);
          expect(seedReads(upstream)).toEqual(before);
          expect(upstream.events.connections()).toBe(1);
          expect(upstream.events.open()).toBe(1);
        }),
      ),
    );

    unwrap(result);
  });

  test("serves retained attention to a later viewer after the last viewer closes", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const first = yield* startWatch(service);
          const initial = yield* nextFeed(first.queue);
          expect(attentionOf(initial, "ses_root")).toEqual({ permissions: 0, questions: 0 });

          upstream.events.send(
            event("permission.asked", {
              id: "per_first",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          const asked = yield* nextFeed(first.queue);
          expect(attentionOf(asked, "ses_root")).toEqual({ permissions: 1, questions: 0 });

          yield* Fiber.interrupt(first.fiber);

          const before = seedReads(upstream);
          upstream.events.send(
            event("permission.asked", {
              id: "per_second",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          yield* Effect.sleep("100 millis");

          const second = yield* startWatch(service);
          const retained = yield* nextFeed(second.queue);
          expect(attentionOf(retained, "ses_root")).toEqual({ permissions: 2, questions: 0 });
          expect(seedReads(upstream)).toEqual(before);
          expect(upstream.events.connections()).toBe(1);
          expect(upstream.events.open()).toBe(1);
        }),
      ),
    );

    unwrap(result);
  });

  test("keeps one upstream while viewers come and go", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;

          yield* waitFor(
            "the startup connection and seed",
            () =>
              upstream.events.connections() === 1 &&
              upstream.events.open() === 1 &&
              requestCount(upstream, "/api/session") >= 2 &&
              requestCount(upstream, "/api/session/active") === 1,
          );

          const before = seedReads(upstream);
          const first = yield* startWatch(service);
          const second = yield* startWatch(service);

          yield* nextFeed(first.queue);
          yield* nextFeed(second.queue);
          expect(seedReads(upstream)).toEqual(before);
          expect(upstream.events.connections()).toBe(1);

          yield* Fiber.interrupt(first.fiber);

          upstream.events.send(
            event("permission.asked", {
              id: "per_first",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          const update = yield* nextFeed(second.queue);
          expect(attentionOf(update, "ses_root")).toEqual({ permissions: 1, questions: 0 });

          yield* Fiber.interrupt(second.fiber);
          upstream.events.send(
            event("permission.asked", {
              id: "per_second",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          yield* Effect.sleep("100 millis");

          const third = yield* startWatch(service);
          const retained = yield* nextFeed(third.queue);
          expect(attentionOf(retained, "ses_root")).toEqual({ permissions: 2, questions: 0 });
          expect(seedReads(upstream)).toEqual(before);
          expect(upstream.events.connections()).toBe(1);
          expect(upstream.events.open()).toBe(1);
        }),
      ),
    );

    unwrap(result);
  });

  test("reseeds current and later watches after the upstream drops", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });

    const result = await runWatch(
      configFor(upstream),
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* SessionWatch.Service;
          const first = yield* startWatch(service);
          yield* nextFeed(first.queue);

          upstream.events.send(
            event("permission.asked", {
              id: "per_first",
              sessionID: "ses_root",
              action: "read",
              resources: ["*"],
            }),
          );
          const asked = yield* nextFeed(first.queue);
          expect(attentionOf(asked, "ses_root")).toEqual({ permissions: 1, questions: 0 });

          upstream.events.end();

          upstream.setSessions([{ id: "ses_fresh", directory: "/work/b" }]);
          const recovered = yield* nextFeed(first.queue);
          expect(sessionIDs(recovered)).toEqual(["ses_fresh"]);
          expect(upstream.events.connections()).toBe(2);
          expect(upstream.events.open()).toBe(1);

          const second = yield* startWatch(service);
          const retained = yield* nextFeed(second.queue);
          expect(retained).toEqual(recovered);
          expect(upstream.events.connections()).toBe(2);
        }),
      ),
    );

    unwrap(result);
  });

  test("closes the upstream when the layer scope closes", async () => {
    const upstream = startUpstream({
      sessions: [{ id: "ses_root", directory: "/work/a" }],
    });
    const watchLayer = SessionWatch.layer.pipe(Layer.provide(OpenCodeSessions.layer));

    const result = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const context = yield* Layer.build(watchLayer);
              const service = Context.get(context, SessionWatch.Service);
              const watch = yield* startWatch(service);

              yield* nextFeed(watch.queue);
              expect(upstream.events.open()).toBe(1);
            }),
          );

          yield* waitFor("the upstream to close", () => upstream.events.open() === 0);
        }).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(configFor(upstream)),
          ),
        ),
      ),
    );

    unwrap(result);
  });
});
