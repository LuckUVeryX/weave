import { useAtomValue } from "@effect/atom-react";
import { Effect, Layer, Stream, SubscriptionRef } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Atom from "effect/reactivity/Atom";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Group } from "../shared/rpc.ts";
import type { SessionFeed } from "../shared/session.ts";

export type WatchState =
  | { readonly _tag: "Connecting" }
  | { readonly _tag: "Live"; readonly feed: SessionFeed }
  | { readonly _tag: "Failed"; readonly feed: SessionFeed };

const initial: WatchState = { _tag: "Connecting" };

const protocol = RpcClient.layerProtocolHttp({
  url: new URL("/rpc", window.location.origin).toString(),
}).pipe(Layer.provide(RpcSerialization.layerNdjson), Layer.provide(FetchHttpClient.layer));

const makeClient = RpcClient.make(Group);

export const watchSessions = Atom.keepAlive(
  Atom.subscriptionRef(
    Effect.gen(function* () {
      const state = yield* SubscriptionRef.make<WatchState>(initial);
      const client = yield* makeClient;

      yield* client.watchSessions().pipe(
        Stream.runForEach((feed) => SubscriptionRef.set(state, { _tag: "Live", feed })),
        Effect.matchCauseEffect({
          onFailure: () =>
            SubscriptionRef.update(state, (current): WatchState => ({
              _tag: "Failed",
              feed: current._tag === "Connecting" ? [] : current.feed,
            })),
          onSuccess: () =>
            SubscriptionRef.update(state, (current): WatchState => ({
              _tag: "Failed",
              feed: current._tag === "Connecting" ? [] : current.feed,
            })),
        }),
        Effect.forkScoped,
      );

      return state;
    }).pipe(Effect.provide(protocol)),
  ),
);

export const useWatchState = (): WatchState => {
  const result = useAtomValue(watchSessions);
  return result._tag === "Success" ? result.value : initial;
};
