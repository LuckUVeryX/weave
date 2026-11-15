import { BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Config, ConfigProvider, Effect, Layer, Stream } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { Group } from "../shared/rpc.ts";
import * as OpenCodeSessions from "./opencode.ts";
import * as SessionWatch from "./session-watch.ts";

const handlers = Group.toLayer(
  Effect.gen(function* () {
    const watch = yield* SessionWatch.Service;
    return { watchSessions: () => watch.watchSessions.pipe(Stream.rechunk(1)) };
  }),
);

const dependencies = SessionWatch.layer.pipe(Layer.provide(OpenCodeSessions.layer));

const layer = HttpRouter.serve(
  RpcServer.layerHttp({ group: Group, path: "/rpc", protocol: "http" }).pipe(
    Layer.provide(handlers),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(dependencies),
  ),
).pipe(
  Layer.provide(
    BunHttpServer.layerConfig({
      hostname: Config.String("WEAVE_HOST").pipe(Config.withDefault("127.0.0.1")),
      port: Config.Int("WEAVE_PORT").pipe(Config.withDefault(4310)),
    }),
  ),
);

BunRuntime.runMain(
  Layer.launch(layer).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnv({ preserveEmptyStrings: true }),
    ),
  ),
);
