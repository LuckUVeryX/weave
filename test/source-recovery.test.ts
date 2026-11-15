import { expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import { Event, Session, type OpenCodeEvent } from "@opencode/client/effect";
import * as OpenCodeSessions from "../src/server/opencode.ts";
import * as SessionWatch from "../src/server/session-watch.ts";
import { RequestFailed } from "../src/shared/errors.ts";
import type { SessionFeed } from "../src/shared/session.ts";

it.effect("initializes every ordered source group before waiting for network readiness", () =>
  Effect.gen(function* () {
    const client: OpenCodeSessions.Interface = {
      get: () => Effect.die("Unexpected get"),
      readActiveIDs: Effect.die("Unexpected active read"),
      readSessions: Effect.die("Unexpected seed"),
      events: Stream.never,
    };
    const feed = yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          SessionWatch.layer.pipe(
            Layer.provide(
              Layer.succeed(OpenCodeSessions.Service, [
                { id: "z-first", client },
                { id: "a-second", client },
              ]),
            ),
          ),
        );
        return yield* Context.get(context, SessionWatch.Service).watchSessions.pipe(
          Stream.take(1),
          Stream.runCollect,
        );
      }),
    );
    expect(feed).toEqual([
      [
        { id: "z-first", health: { kind: "connecting" }, sessions: [] },
        { id: "a-second", health: { kind: "connecting" }, sessions: [] },
      ],
    ]);
  }),
);

for (const failure of ["connect", "seed"] as const) {
  it.effect(`bounds ${failure} failures at eleven attempts and keeps watches alive`, () =>
    Effect.gen(function* () {
      let attempts = 0;
      let open = 0;
      let seeds = 0;
      const upstream: OpenCodeSessions.Interface = {
        get: () => Effect.die("Unexpected session read"),
        readActiveIDs: Effect.succeed([]),
        readSessions: Effect.suspend(() => {
          seeds += 1;
          return Effect.fail(new RequestFailed());
        }),
        events: Stream.unwrap(
          Effect.gen(function* () {
            attempts += 1;
            if (failure === "connect") return Stream.fail(new RequestFailed());
            open += 1;
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                open -= 1;
              }),
            );
            const connected: OpenCodeEvent = {
              id: Event.ID.make("evt_connected"),
              type: "server.connected",
              data: {},
            };
            return Stream.succeed(connected).pipe(Stream.concat(Stream.never));
          }),
        ),
      };
      const feeds = yield* Queue.unbounded<SessionFeed>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            SessionWatch.layer.pipe(
              Layer.provide(
                Layer.succeed(OpenCodeSessions.Service, [{ id: "local", client: upstream }]),
              ),
            ),
          );
          const service = Context.get(context, SessionWatch.Service);
          const watcher = yield* service.watchSessions.pipe(
            Stream.runForEach((feed) => Queue.offer(feeds, feed)),
            Effect.forkScoped,
          );
          let feed = yield* Queue.take(feeds);
          if (feed[0]?.health.kind === "connecting") feed = yield* Queue.take(feeds);
          for (let retry = 1; retry <= 10; retry += 1) {
            const delay = Math.min(2 ** (retry - 1), 30) * 1000;
            expect(feed).toEqual([
              {
                id: "local",
                health: { kind: "reconnecting", retry, retryDelayMs: delay },
                sessions: [],
              },
            ]);
            expect(attempts).toBe(retry);
            expect(open).toBe(0);
            yield* TestClock.adjust(delay);
            feed = yield* Queue.take(feeds);
          }
          expect(feed).toEqual([{ id: "local", health: { kind: "unavailable" }, sessions: [] }]);
          expect(attempts).toBe(11);
          expect(seeds).toBe(failure === "seed" ? 11 : 0);
          expect(open).toBe(0);
          const later = yield* service.watchSessions.pipe(Stream.take(1), Stream.runCollect);
          expect(later).toEqual([feed]);
          yield* TestClock.adjust("10 minutes");
          expect(attempts).toBe(11);
          expect(watcher.pollUnsafe()).toBeUndefined();
        }),
      );
    }),
  );
}

it.effect("closing the layer during backoff cancels future attempts", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const upstream: OpenCodeSessions.Interface = {
      get: () => Effect.die("Unexpected get"),
      readSessions: Effect.die("Unexpected seed"),
      readActiveIDs: Effect.die("Unexpected active read"),
      events: Stream.suspend(() => {
        attempts += 1;
        return Stream.fail(new RequestFailed());
      }),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          SessionWatch.layer.pipe(
            Layer.provide(
              Layer.succeed(OpenCodeSessions.Service, [{ id: "local", client: upstream }]),
            ),
          ),
        );
        const feed = yield* Context.get(context, SessionWatch.Service).watchSessions.pipe(
          Stream.filter((feed) => feed[0]?.health.kind === "reconnecting"),
          Stream.take(1),
          Stream.runCollect,
        );
        expect(feed[0]?.[0]?.health).toEqual({
          kind: "reconnecting",
          retry: 1,
          retryDelayMs: 1000,
        });
      }),
    );
    yield* TestClock.adjust("10 minutes");
    expect(attempts).toBe(1);
  }),
);

it.effect("subscribes before seeding and replays events received during the seed", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OpenCodeEvent>();
    const seeding = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const upstream: OpenCodeSessions.Interface = {
      get: () => Effect.die("Unexpected get"),
      readActiveIDs: Effect.succeed([]),
      readSessions: Effect.gen(function* () {
        yield* Deferred.succeed(seeding, undefined);
        yield* Deferred.await(release);
        return [
          { id: "ses_root", time: { created: 1, updated: 1 }, location: { directory: "/work" } },
          { id: "ses_other", time: { created: 1, updated: 1 }, location: { directory: "/work" } },
        ];
      }),
      events: Stream.succeed<OpenCodeEvent>({
        id: Event.ID.make("evt_connected"),
        type: "server.connected",
        data: {},
      }).pipe(Stream.concat(Stream.fromQueue(events))),
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          SessionWatch.layer.pipe(
            Layer.provide(
              Layer.succeed(OpenCodeSessions.Service, [{ id: "local", client: upstream }]),
            ),
          ),
        );
        const feeds = yield* Queue.unbounded<SessionFeed>();
        yield* Context.get(context, SessionWatch.Service).watchSessions.pipe(
          Stream.runForEach((feed) => Queue.offer(feeds, feed)),
          Effect.forkScoped,
        );
        expect(yield* Queue.take(feeds)).toEqual([
          { id: "local", health: { kind: "connecting" }, sessions: [] },
        ]);
        yield* Deferred.await(seeding);
        yield* Queue.offerAll(
          events,
          ["ses_root", "ses_other"].map((id): OpenCodeEvent => ({
            id: Event.ID.make("evt_deleted"),
            created: 1,
            durable: {
              aggregateID: id,
              seq: Event.Seq.make(1),
              version: Event.Version.make(1),
            },
            type: "session.deleted",
            data: { sessionID: Session.ID.make(id) },
          })),
        );
        yield* Deferred.succeed(release, undefined);
        const initial = yield* Queue.take(feeds);
        expect(initial[0]?.sessions.map((session) => session.id)).toEqual([
          "ses_root",
          "ses_other",
        ]);
        const replayed = yield* Queue.take(feeds);
        expect(replayed[0]?.sessions.map((session) => session.id)).toEqual(["ses_other"]);
        const final = yield* Queue.take(feeds);
        expect(final[0]?.sessions).toEqual([]);
      }),
    );
  }),
);
