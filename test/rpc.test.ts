import { expect, test } from "vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Group } from "../src/shared/rpc.ts";
import { eventFrame, startFakeOpenCode, testPassword } from "./support/fake-opencode.ts";

test("keeps slow HTTP watches connected through a batched 700-to-7 update", async () => {
  const sessions = Array.from({ length: 700 }, (_, index) => ({
    id: `ses_bulk_${index}`,
    title: `Session ${index}`,
    directory: "/work/bulk",
  }));
  const upstream = startFakeOpenCode({ sessions });
  const server = Bun.spawn(["bun", "src/server/main.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...process.env,
      WEAVE_HOST: "127.0.0.1",
      WEAVE_PORT: "0",
      WEAVE_OPENCODE_SOURCES: JSON.stringify([
        { id: "local", url: upstream.url, username: "opencode", password: testPassword },
      ]),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  try {
    const ready = async () => {
      let output = "";
      for await (const bytes of server.stdout) {
        output += new TextDecoder().decode(bytes);
        const match = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match !== null) return match[1];
      }
      throw new Error("The owned RPC server exited before listening");
    };
    const url = await Effect.runPromise(
      Effect.tryPromise(ready).pipe(Effect.timeout("10 seconds")),
    );
    const chunks: Array<{ values: number; length: number }> = [];
    const serialization = RpcSerialization.makeNdjson();
    const envelope = Schema.decodeUnknownSync(
      Schema.Struct({ values: Schema.optional(Schema.Array(Schema.Unknown)) }),
    );
    const protocol = RpcClient.layerProtocolHttp({ url: `${url}/rpc` }).pipe(
      Layer.provide(
        Layer.succeed(RpcSerialization.RpcSerialization, {
          ...serialization,
          makeUnsafe: () => {
            const parser = serialization.makeUnsafe();
            return {
              ...parser,
              decode: (bytes) => {
                const frames = parser.decode(bytes);
                for (const frame of frames) {
                  const decoded = envelope(frame);
                  if (decoded.values !== undefined) {
                    chunks.push({
                      values: decoded.values.length,
                      length: JSON.stringify(frame).length,
                    });
                  }
                }
                return frames;
              },
            };
          },
        }),
      ),
      Layer.provide(FetchHttpClient.layer),
    );

    const latest = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(Group);
          const initial = yield* Deferred.make<void>();
          const resume = yield* Deferred.make<void>();
          const slow = yield* client.watchSessions().pipe(
            Stream.tap((feed) =>
              feed[0]?.sessions.length === 700
                ? Deferred.succeed(initial, undefined).pipe(Effect.andThen(Deferred.await(resume)))
                : Effect.void,
            ),
            Stream.filter((feed) => feed[0]?.sessions.length === 7),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Deferred.await(initial);
          upstream.setSessions(sessions.slice(0, 7));
          for (const [index, session] of sessions.slice(7).entries()) {
            upstream.events.send(
              eventFrame(
                "session.deleted",
                { sessionID: session.id },
                { id: `evt_delete_${index}`, created: 1_700_000_000_000, seq: index + 1 },
              ),
            );
          }
          const observer = yield* client.watchSessions().pipe(
            Stream.filter((feed) => feed[0]?.sessions.length === 7),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(observer[0]?.[0]?.health).toEqual({ kind: "connected" });
          yield* Deferred.succeed(resume, undefined);
          return yield* Fiber.join(slow);
        }).pipe(Effect.provide(protocol), Effect.timeout("10 seconds")),
      ),
    );

    expect(latest[0]?.[0]?.health).toEqual({ kind: "connected" });
    expect(latest[0]?.[0]?.sessions.map(({ id }) => id)).toEqual(
      sessions.slice(0, 7).map(({ id }) => id),
    );
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map(({ values }) => values))).toBe(1);
    expect(Math.max(...chunks.map(({ length }) => length))).toBeLessThan(16 * 1024 * 1024);
    expect(upstream.events.connections()).toBe(1);
  } finally {
    server.kill("SIGTERM");
    await server.exited;
    await upstream.stop();
  }
}, 20_000);
