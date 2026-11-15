import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { RequestFailed } from "../../../../src/shared/errors.ts";
import { Group } from "../../../../src/shared/rpc.ts";
import type { SessionFeed } from "../../../../src/shared/session.ts";

const makeWatchClient = RpcClient.make(Group);

export type WatchClient = Effect.Success<typeof makeWatchClient>;

const protocolLayer = (serverUrl: string) =>
  RpcClient.layerProtocolHttp({ url: new URL("/rpc", serverUrl).toString() }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  );

export const withClient = <A, E>(
  serverUrl: string,
  program: (client: WatchClient) => Effect.Effect<A, E, Scope.Scope>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeWatchClient;
        return yield* program(client);
      }).pipe(Effect.provide(protocolLayer(serverUrl))),
    ),
  );

export interface FeedAttempt {
  readonly outcome: "Success" | "Failure";
  readonly sourceIDs: ReadonlyArray<string>;
  readonly sessionIDs: ReadonlyArray<string>;
  readonly errorTag?: string;
  readonly cause?: string;
}

const emptyFeed: SessionFeed = [];

export const attemptFeed = (serverUrl: string, timeoutMs = 10_000): Promise<FeedAttempt> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* makeWatchClient;
        const exit = yield* client
          .watchSessions()
          .pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeout(Duration.millis(timeoutMs)),
            Effect.exit,
          );

        if (Exit.isSuccess(exit)) {
          const feed = [...exit.value][0];
          const success: FeedAttempt = {
            outcome: "Success",
            sourceIDs: feed?.map((group) => group.id) ?? [],
            sessionIDs: feed?.flatMap((group) => group.sessions.map((item) => item.id)) ?? [],
          };
          return success;
        }

        const failure = Cause.findErrorOption(exit.cause);
        const failed: FeedAttempt = {
          outcome: "Failure",
          sourceIDs: [],
          sessionIDs: [],
          ...(Option.isSome(failure) ? { errorTag: failure.value._tag } : {}),
          cause: Cause.pretty(exit.cause),
        };
        return failed;
      }).pipe(Effect.provide(protocolLayer(serverUrl))),
    ),
  );

export interface Watcher {
  readonly feeds: Ref.Ref<ReadonlyArray<SessionFeed>>;
  readonly ready: Deferred.Deferred<void>;
  readonly fiber: Fiber.Fiber<void, RequestFailed | RpcClientError>;
}

export const startWatcher = (
  client: WatchClient,
  onFeed?: (feed: SessionFeed) => void,
): Effect.Effect<Watcher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const feeds = yield* Ref.make<ReadonlyArray<SessionFeed>>([]);
    const ready = yield* Deferred.make<void>();
    const fiber = yield* client.watchSessions().pipe(
      Stream.tap((feed) =>
        Effect.gen(function* () {
          onFeed?.(feed);
          yield* Ref.update(feeds, (current) => [...current, feed]);
          yield* Deferred.succeed(ready, undefined);
        }),
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );

    return { feeds, ready, fiber };
  });

export const latestFeed = (watcher: Watcher): Effect.Effect<SessionFeed | undefined> =>
  Ref.get(watcher.feeds).pipe(Effect.map((feeds) => feeds[feeds.length - 1]));

export const awaitReady = (watcher: Watcher, timeoutMs = 10_000): Effect.Effect<void, never> =>
  Deferred.await(watcher.ready).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Effect.die(new Error(`The watch did not emit its first feed within ${timeoutMs} ms.`)),
    }),
  );

export const waitForFeed = (
  watcher: Watcher,
  label: string,
  predicate: (feed: SessionFeed) => boolean,
  timeoutMs = 10_000,
): Effect.Effect<SessionFeed, never> =>
  Effect.gen(function* () {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const current = yield* latestFeed(watcher);
      if (current !== undefined && predicate(current)) return current;
      yield* Effect.sleep(Duration.millis(20));
    }

    const current = yield* latestFeed(watcher);
    return yield* Effect.die(
      new Error(`Timed out waiting for ${label}. Last feed: ${JSON.stringify(current)}`),
    );
  });

export const collectFeed = (serverUrl: string, timeoutMs = 10_000): Promise<SessionFeed> =>
  withClient(serverUrl, (client) =>
    client.watchSessions().pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.map((feeds) => [...feeds][0] ?? emptyFeed),
      Effect.timeout(Duration.millis(timeoutMs)),
    ),
  );

export const awaitFailure = (
  watcher: Watcher,
  timeoutMs = 10_000,
): Effect.Effect<RequestFailed | RpcClientError, never> =>
  Fiber.await(watcher.fiber).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Effect.die(new Error(`The watch did not fail within ${timeoutMs} ms.`)),
    }),
    Effect.flatMap((exit) => {
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        if (Option.isSome(failure)) return Effect.succeed(failure.value);
      }

      return Effect.die(new Error(`The watch ended without the typed failure: ${String(exit)}`));
    }),
  );

export interface RawProbe {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
}

const rawTag = (): string => {
  const tag = [...Group.requests.keys()][0];
  if (tag === undefined) throw new Error("The RPC group has no procedures.");
  return tag;
};

export const rawProbe = async (serverUrl: string, mode: "chunk" | "failure"): Promise<RawProbe> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  const body = `${JSON.stringify({
    _tag: "Request",
    id: 1,
    tag: rawTag(),
    payload: null,
    headers: [],
  })}\n`;

  try {
    const response = await fetch(new URL("/rpc", serverUrl), {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body,
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("The raw RPC response had no body.");
    let text = "";

    if (mode === "chunk") {
      while (!text.includes('"_tag":"Chunk"')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      await reader.cancel();
      controller.abort();
    } else {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    }

    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: text,
    };
  } finally {
    clearTimeout(timer);
  }
};
