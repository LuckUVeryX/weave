import { Session } from "@opencode/client/effect";
import { afterEach, describe, expect, test } from "vitest";
import { ConfigProvider, Effect, Layer, Result, Stream } from "effect";
import * as OpenCodeSessions from "../src/server/opencode.ts";
import * as SessionWatch from "../src/server/session-watch.ts";
import type { RequestFailed } from "../src/shared/errors.ts";
import {
  basicAuthorization,
  cursorForOffset,
  eventFrame,
  startFakeOpenCode,
  testPassword,
  type FakeOpenCode,
  type FakeOpenCodeOptions,
  type FakeResponse,
} from "./support/fake-opencode.ts";

type TestConfig = Record<string, string | undefined>;

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()?.();
  }
});

const startUpstream = (response: FakeResponse, options?: FakeOpenCodeOptions): FakeOpenCode => {
  const upstream = startFakeOpenCode(response, options);
  cleanup.push(upstream.stop);
  return upstream;
};

const upstreamConfig = (
  upstream: FakeOpenCode,
  password: string | null = testPassword,
): TestConfig => ({
  WEAVE_OPENCODE_URL: upstream.url,
  WEAVE_OPENCODE_PASSWORD: password ?? undefined,
});

const run = <A, E>(
  read: (sessions: OpenCodeSessions.Interface) => Effect.Effect<A, E>,
  config: TestConfig = {},
) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const sources = yield* OpenCodeSessions.Service;
        const source = sources[0];
        if (source === undefined) return yield* Effect.die("Expected a configured source");
        return yield* read(source.client);
      }).pipe(
        Effect.provide(OpenCodeSessions.layer, { local: true }),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(config)),
      ),
    ),
  );

const success = async <A, E>(
  read: (sessions: OpenCodeSessions.Interface) => Effect.Effect<A, E>,
  config: TestConfig,
): Promise<A> => {
  const result = await run(read, config);

  if (Result.isFailure(result)) {
    throw new Error(`Expected success, received ${String(result.failure)}`);
  }

  return result.success;
};

const expectRequestFailure = async <A>(
  read: (sessions: OpenCodeSessions.Interface) => Effect.Effect<A, RequestFailed>,
  config: TestConfig,
): Promise<void> => {
  const result = await run(read, config);

  expect(Result.isFailure(result) && result.failure._tag).toBe("OpenCodeSessions.RequestFailed");
};

const sortedIDs = (ids: ReadonlyArray<string>): ReadonlyArray<string> =>
  ids.toSorted((left, right) => left.localeCompare(right));

test("ignores first-token events without reconnecting or losing the next session update", async () => {
  const session = { id: "ses_compatibility", title: "Before", directory: "/work/a" };
  const upstream = startUpstream({ sessions: [session] });
  const feeds = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const watch = yield* SessionWatch.Service;
        return yield* watch.watchSessions.pipe(
          Stream.filter((feed) => feed[0]?.health.kind !== "connecting"),
          Stream.tap((feed) =>
            Effect.sync(() => {
              if (feed[0]?.health.kind !== "connected" || feed[0]?.sessions[0]?.title !== "Before")
                return;
              upstream.setSessions([{ ...session, title: "After" }]);
              upstream.events.send({
                id: "evt_first_token",
                created: 1_700_000_000_000,
                type: "session.step.first-token",
                durable: { aggregateID: session.id, seq: 1, version: 1 },
                data: { sessionID: session.id, assistantMessageID: "msg_compatibility" },
              });
              upstream.events.send(
                eventFrame(
                  "session.renamed",
                  { sessionID: session.id, title: "After" },
                  { id: "evt_renamed", created: 1_700_000_000_001, seq: 2 },
                ),
              );
            }),
          ),
          Stream.take(2),
          Stream.runCollect,
        );
      }).pipe(
        Effect.provide(SessionWatch.layer.pipe(Layer.provide(OpenCodeSessions.layer))),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown(upstreamConfig(upstream)),
        ),
        Effect.timeout("3 seconds"),
      ),
    ),
  );

  expect(feeds.map((feed) => feed[0]?.health)).toEqual([
    { kind: "connected" },
    { kind: "connected" },
  ]);
  expect(feeds.map((feed) => feed[0]?.sessions.map(({ title }) => title))).toEqual([
    ["Before"],
    ["After"],
  ]);
  expect(upstream.events.connections()).toBe(1);
});

describe("OpenCodeSessions.readSessions", () => {
  test("drains the global unarchived list across cursor pages", async () => {
    const password = "weave-roots-fixture-6b2d";
    const timestamp = 1_700_000_000_000;
    const roots = Array.from({ length: 501 }, (_, index) => ({
      id: `ses_root_${String(index).padStart(3, "0")}`,
      title: `Root ${index}`,
      directory: "/work/a",
      updated: timestamp + 1000 - index,
    }));
    const child = {
      id: "ses_child",
      parentID: "ses_root_000",
      directory: "/work/a",
      updated: timestamp + 500,
    };
    const grandchild = {
      id: "ses_grandchild",
      parentID: "ses_child",
      directory: "/work/a",
      updated: timestamp + 400,
    };
    const archivedChild = {
      id: "ses_archived_child",
      parentID: "ses_archived_root",
      directory: "/work/a",
      updated: timestamp + 300,
    };
    const upstream = startUpstream(
      {
        sessions: [
          ...roots,
          child,
          grandchild,
          { id: "ses_archived_root", directory: "/work/a", archived: true },
          archivedChild,
        ],
      },
      { auth: { username: "opencode", password } },
    );

    const sessions = await success(
      (sessions) => sessions.readSessions,
      upstreamConfig(upstream, password),
    );

    expect(sessions).toHaveLength(504);
    expect(sessions.map((session) => session.id)).toEqual(
      expect.arrayContaining([
        ...roots.map((root) => root.id),
        child.id,
        grandchild.id,
        archivedChild.id,
      ]),
    );
    expect(sessions.some((session) => session.id === "ses_archived_root")).toBe(false);
    expect(sessions.find((session) => session.id === "ses_root_000")).toMatchObject({
      title: "Root 0",
      location: { directory: "/work/a" },
    });

    expect(upstream.requests).toHaveLength(3);

    const first = new URL(upstream.requests[0]?.url ?? "");
    expect(first.pathname).toBe("/api/session");
    expect(first.searchParams.get("archived")).toBe("false");
    expect(first.searchParams.get("limit")).toBe("500");
    expect(first.searchParams.get("order")).toBe("desc");
    expect(first.searchParams.has("parentID")).toBe(false);
    expect(first.searchParams.has("cursor")).toBe(false);
    expect(upstream.requests[0]?.authorization).toBe(basicAuthorization("opencode", password));

    const second = new URL(upstream.requests[1]?.url ?? "");
    expect(second.searchParams.get("cursor")).toBe(cursorForOffset(500));
    expect(second.searchParams.get("limit")).toBe("500");
    expect(second.searchParams.has("parentID")).toBe(false);

    const third = new URL(upstream.requests[2]?.url ?? "");
    expect(third.searchParams.get("cursor")).toBe(cursorForOffset(504));
    expect(third.searchParams.get("limit")).toBe("500");
    expect(third.searchParams.has("parentID")).toBe(false);
  });

  test("stops after an empty page", async () => {
    const upstream = startUpstream({ sessions: [] });

    const sessions = await success((sessions) => sessions.readSessions, upstreamConfig(upstream));

    expect(sessions).toEqual([]);
    expect(upstream.requests).toHaveLength(1);
  });

  test.each([
    {
      name: "malformed JSON",
      body: "{ not json",
    },
    {
      name: "a session that does not match the wire contract",
      body: JSON.stringify({
        data: [
          {
            id: "ses_invalid_directory",
            time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
            location: { directory: 42 },
          },
        ],
      }),
    },
  ])("fails on $name", async ({ body }) => {
    const upstream = startUpstream({ body });
    await expectRequestFailure((sessions) => sessions.readSessions, upstreamConfig(upstream));
  });

  test("fails when upstream rejects the request", async () => {
    const upstream = startUpstream({ status: 500, body: "upstream secret detail" });
    await expectRequestFailure((sessions) => sessions.readSessions, upstreamConfig(upstream));
  });
});

describe("OpenCodeSessions.readActiveIDs", () => {
  test("reads the global active map without session metadata", async () => {
    const upstream = startUpstream({
      sessions: [],
      active: {
        ses_active_only: { type: "running" },
        ses_other: { type: "running" },
      },
    });

    const ids = await success((sessions) => sessions.readActiveIDs, upstreamConfig(upstream));

    expect(sortedIDs(ids)).toEqual(sortedIDs(["ses_active_only", "ses_other"]));
    expect(upstream.requests).toHaveLength(1);

    const request = upstream.requests[0];
    expect(new URL(request?.url ?? "").pathname).toBe("/api/session/active");
    expect(new URL(request?.url ?? "").search).toBe("");
    expect(request?.authorization).toBe(basicAuthorization("opencode", testPassword));
  });

  test("fails when upstream rejects the active request", async () => {
    const upstream = startUpstream({ activeStatus: 500, activeBody: "upstream secret detail" });
    await expectRequestFailure((sessions) => sessions.readActiveIDs, upstreamConfig(upstream));
  });
});

describe("OpenCodeSessions.get", () => {
  test("returns one session summary with its canonical timestamps", async () => {
    const upstream = startUpstream({
      sessions: [
        {
          id: "ses_detail_a",
          parentID: "ses_root",
          title: "Detail A",
          directory: "/work/a",
          created: 1_700_000_000_000,
          updated: 1_700_000_200_000,
          busy: 1_700_000_050_000,
          idle: 1_700_000_100_000,
          viewed: 1_700_000_060_000,
          outcome: "succeeded",
          archived: true,
        },
      ],
    });

    const response = await success(
      (sessions) => sessions.get(Session.ID.make("ses_detail_a")),
      upstreamConfig(upstream),
    );

    expect(response).toEqual({
      id: "ses_detail_a",
      parentID: "ses_root",
      title: "Detail A",
      outcome: "succeeded",
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_200_000,
        busy: 1_700_000_050_000,
        idle: 1_700_000_100_000,
        viewed: 1_700_000_060_000,
        archived: 1_700_000_200_000,
      },
      location: { directory: "/work/a" },
    });

    expect(upstream.requests).toHaveLength(1);
    expect(new URL(upstream.requests[0]?.url ?? "").pathname).toBe("/api/session/ses_detail_a");
    expect(upstream.requests[0]?.authorization).toBe(basicAuthorization("opencode", testPassword));
  });

  test("returns SessionNotFoundError for an unknown session", async () => {
    const upstream = startUpstream({ sessions: [] });

    const result = await run(
      (sessions) => sessions.get(Session.ID.make("ses_missing")),
      upstreamConfig(upstream),
    );

    expect(Result.isFailure(result) && result.failure._tag).toBe("SessionNotFoundError");
    expect(upstream.requests).toHaveLength(1);
  });

  test("fails when upstream rejects the request", async () => {
    const upstream = startUpstream({ status: 500, body: "upstream secret detail" });

    const result = await run(
      (sessions) => sessions.get(Session.ID.make("ses_detail_a")),
      upstreamConfig(upstream),
    );

    expect(Result.isFailure(result) && result.failure._tag).toBe("OpenCodeSessions.RequestFailed");
  });
});

describe("OpenCodeSessions.layer", () => {
  const acquire = (config: TestConfig) =>
    Effect.runPromise(
      Effect.result(
        OpenCodeSessions.Service.pipe(
          Effect.provide(OpenCodeSessions.layer, { local: true }),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown(config, { preserveEmptyStrings: true }),
          ),
        ),
      ),
    );

  test("uses explicit sources in input order and ignores legacy settings", async () => {
    const authA = { username: "alice", password: "password-a" };
    const authB = { username: "bob", password: "password-b" };
    const a = startUpstream({ sessions: [] }, { auth: authA });
    const b = startUpstream({ sessions: [] }, { auth: authB });
    const result = await acquire({
      WEAVE_OPENCODE_SOURCES: JSON.stringify([
        { id: "z-first", url: a.url, ...authA },
        { id: "a-second", url: b.url, ...authB },
      ]),
      WEAVE_OPENCODE_URL: "invalid legacy URL",
      WEAVE_OPENCODE_PASSWORD: "ignored",
    });
    if (Result.isFailure(result)) throw result.failure;
    expect(result.success.map((source) => source.id)).toEqual(["z-first", "a-second"]);
    for (const source of result.success) await Effect.runPromise(source.client.readSessions);
    expect(a.requests[0]?.authorization).toBe(basicAuthorization(authA.username, authA.password));
    expect(b.requests[0]?.authorization).toBe(basicAuthorization(authB.username, authB.password));
    expect(JSON.stringify(result.success)).not.toContain("password-a");
  });

  test("falls back to the local source only when the new setting is absent", async () => {
    const upstream = startUpstream({ sessions: [] });
    const result = await acquire(upstreamConfig(upstream));
    expect(Result.isSuccess(result) && result.success.map((source) => source.id)).toEqual([
      "local",
    ]);
  });

  test("accepts an HTTPS source without contacting it during client construction", async () => {
    const result = await acquire({
      WEAVE_OPENCODE_SOURCES: JSON.stringify([
        {
          id: "remote",
          username: "user",
          password: "password",
          url: "https://opencode.example.com",
        },
      ]),
    });
    expect(Result.isSuccess(result) && result.success.map((source) => source.id)).toEqual([
      "remote",
    ]);
  });

  test.each([
    "",
    "not json",
    "null",
    "{}",
    "[]",
    JSON.stringify([
      { id: "", username: "secret-user", password: "secret-password", url: "https://example.com" },
    ]),
    JSON.stringify([
      {
        id: "one",
        username: "secret-user",
        password: "secret-password",
        url: "file:///secret-password",
      },
    ]),
    JSON.stringify([
      { id: "one", username: "secret-user", password: "secret-password", url: "not a URL" },
    ]),
    JSON.stringify([{ id: "one", password: "secret-password", url: "https://example.com" }]),
    JSON.stringify(
      Array.from({ length: 2 }, () => ({
        id: "same",
        username: "secret-user",
        password: "secret-password",
        url: "https://example.com",
      })),
    ),
  ])(
    "rejects invalid authoritative configuration without exposing its input: case %#",
    async (input) => {
      const upstream = startUpstream({ sessions: [] });
      const result = await acquire({ ...upstreamConfig(upstream), WEAVE_OPENCODE_SOURCES: input });
      expect(Result.isFailure(result) && result.failure._tag).toBe("OpenCodeSources.InvalidConfig");
      const rendered = String(Result.isFailure(result) && result.failure);
      expect(rendered).toContain("WEAVE_OPENCODE_SOURCES");
      expect(rendered).not.toContain("secret-user");
      expect(rendered).not.toContain("secret-password");
      expect(upstream.requests).toHaveLength(0);
    },
  );

  test("fails clearly when WEAVE_OPENCODE_URL is missing", async () => {
    const result = await run((sessions) => sessions.readSessions, {
      WEAVE_OPENCODE_PASSWORD: testPassword,
    });

    expect(Result.isFailure(result) && result.failure._tag).toBe("ConfigError");
    expect(Result.isFailure(result) && String(result.failure)).toContain("WEAVE_OPENCODE_URL");
  });

  test("fails clearly when WEAVE_OPENCODE_PASSWORD is missing", async () => {
    const upstream = startUpstream({ sessions: [{ id: "ses_no_auth", directory: "/work/a" }] });
    const result = await run((sessions) => sessions.readSessions, upstreamConfig(upstream, null));

    expect(Result.isFailure(result) && result.failure._tag).toBe("ConfigError");
    expect(Result.isFailure(result) && String(result.failure)).toContain("WEAVE_OPENCODE_PASSWORD");
    expect(upstream.requests).toHaveLength(0);
  });
});
