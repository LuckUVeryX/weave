import { Session } from "@opencode/client/effect";

export interface SessionFixture {
  readonly id: string;
  readonly parentID?: string;
  readonly title?: string;
  readonly directory: string;
  readonly created?: number;
  readonly updated?: number;
  readonly busy?: number;
  readonly idle?: number;
  readonly viewed?: number;
  readonly outcome?: "succeeded" | "failed" | "interrupted";
  readonly archived?: boolean;
}

const createdAt = 1_700_000_000_000;
const updatedAt = 1_700_000_100_000;

const sessionInfo = (fixture: SessionFixture): unknown => ({
  id: fixture.id,
  ...(fixture.parentID === undefined ? {} : { parentID: fixture.parentID }),
  ...(fixture.title === undefined ? {} : { title: fixture.title }),
  ...(fixture.outcome === undefined ? {} : { outcome: fixture.outcome }),
  projectID: "prj_fixture",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  metadata: { fixture: "not-for-output" },
  permissions: [{ action: "read", resource: "*", effect: "allow" }],
  time: {
    created: fixture.created ?? createdAt,
    updated: fixture.updated ?? updatedAt,
    ...(fixture.busy === undefined ? {} : { busy: fixture.busy }),
    ...(fixture.idle === undefined ? {} : { idle: fixture.idle }),
    ...(fixture.viewed === undefined ? {} : { viewed: fixture.viewed }),
    ...(fixture.archived === true ? { archived: fixture.updated ?? updatedAt } : {}),
  },
  location: { directory: fixture.directory },
});

export interface FakePage {
  readonly sessions?: ReadonlyArray<SessionFixture>;
  readonly status?: number;
  readonly body?: string;
}

export interface FakeResponse extends FakePage {
  readonly active?: FakeActive;
  readonly activeStatus?: number;
  readonly activeBody?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

export type FakeActive = Readonly<Record<string, { readonly type: "running" }>>;

export interface FakeEvents {
  readonly send: (event: unknown) => void;
  readonly end: () => void;
  readonly connections: () => number;
  readonly open: () => number;
}

export interface FakeOpenCode {
  readonly url: string;
  readonly requests: ReadonlyArray<RecordedRequest>;
  readonly events: FakeEvents;
  readonly setSessions: (sessions: ReadonlyArray<SessionFixture>) => void;
  readonly stop: () => Promise<void>;
}

export const testPassword = "weave-controlled-test-password";

export interface FakeOpenCodeOptions {
  readonly auth?: { readonly username: string; readonly password: string };
  readonly beforeRequest?: (url: URL) => Promise<void>;
}

export const basicAuthorization = (username: string, password: string): string =>
  `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

export const eventFrame = (
  type: string,
  data: Readonly<Record<string, unknown>>,
  frame: { readonly id: string; readonly created: number; readonly seq: number },
): unknown => {
  const definition = Session.Event.DurableDefinitions.find((candidate) => candidate.type === type);

  if (definition === undefined) {
    return { id: frame.id, created: frame.created, type, data };
  }

  const sessionID = data[definition.durable.aggregate];

  if (typeof sessionID !== "string") {
    throw new Error(`The ${type} event needs a sessionID for its durable envelope.`);
  }

  return {
    id: frame.id,
    created: frame.created,
    type,
    durable: {
      aggregateID: sessionID,
      seq: frame.seq,
      version: definition.durable.version,
    },
    data,
  };
};

const serverURL = (server: { readonly port?: number | undefined }): string => {
  if (server.port === undefined) {
    throw new Error("The test server did not report a port.");
  }

  return `http://127.0.0.1:${server.port}`;
};

const defaultLimit = 50;

export const cursorForOffset = (offset: number): string =>
  Buffer.from(String(offset)).toString("base64url");

const cursorOffset = (cursor: string | null): number => {
  if (cursor === null) return 0;

  const offset = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isInteger(offset) && offset >= 0 ? offset : 0;
};

const pageResponse = (
  page: FakePage,
  url: URL,
  sessions: ReadonlyArray<SessionFixture>,
): Response => {
  if (page.status !== undefined) {
    return new Response(page.body ?? "upstream failed", {
      status: page.status,
    });
  }

  if (page.body !== undefined) {
    return new Response(page.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const archived = url.searchParams.get("archived");
  const parentID = url.searchParams.get("parentID");
  const requestedLimit = Number(url.searchParams.get("limit") ?? defaultLimit);
  const limit =
    Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : defaultLimit;
  const filtered = sessions
    .filter((session) => {
      if (archived === "true") return session.archived === true;
      if (archived === "false") return session.archived !== true;
      return true;
    })
    .filter((session) => {
      if (parentID === "null") return session.parentID === undefined;
      if (parentID !== null) return session.parentID === parentID;
      return true;
    });
  const ordered = filtered.toSorted(
    (left, right) => (right.updated ?? updatedAt) - (left.updated ?? updatedAt),
  );
  const offset = cursorOffset(url.searchParams.get("cursor"));
  const data = ordered.slice(offset, offset + limit);
  const next = data.length === 0 ? undefined : cursorForOffset(offset + data.length);

  return Response.json({
    data: data.map(sessionInfo),
    cursor: next === undefined ? {} : { next },
  });
};

export const startFakeOpenCode = (
  response: FakeResponse,
  options: FakeOpenCodeOptions = {},
): FakeOpenCode => {
  const requests: Array<RecordedRequest> = [];
  const auth = options.auth ?? { username: "opencode", password: testPassword };
  const expectedAuthorization = basicAuthorization(auth.username, auth.password);
  const encoder = new TextEncoder();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let sessions = response.sessions ?? [];
  let connections = 0;
  let sequence = 0;

  const frame = (event: unknown): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  const send = (event: unknown): void => {
    for (const stream of streams) {
      try {
        stream.enqueue(frame(event));
      } catch {
        streams.delete(stream);
      }
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      requests.push({ method: request.method, url: request.url, authorization });

      if (authorization !== expectedAuthorization) {
        return new Response("unauthorized", { status: 401 });
      }

      await options.beforeRequest?.(url);

      if (url.pathname === "/api/event") {
        connections += 1;
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(next) {
            controller = next;
            streams.add(next);
            sequence += 1;
            next.enqueue(
              frame({
                id: `evt_connected_${sequence}`,
                created: Date.now(),
                type: "server.connected",
                data: {},
              }),
            );
          },
          cancel() {
            if (controller !== undefined) streams.delete(controller);
          },
        });

        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      }

      if (url.pathname === "/api/session/active") {
        if (response.activeStatus !== undefined) {
          return new Response(response.activeBody ?? "upstream failed", {
            status: response.activeStatus,
          });
        }

        return Response.json({ data: response.active ?? {} });
      }

      const sessionMatch = /^\/api\/session\/([^/]+)$/.exec(url.pathname);

      if (sessionMatch !== null) {
        if (response.status !== undefined) {
          return new Response(response.body ?? "upstream failed", {
            status: response.status,
          });
        }

        const sessionID = decodeURIComponent(sessionMatch[1] ?? "");
        const session = sessions.find((candidate) => candidate.id === sessionID);

        if (session === undefined) {
          return Response.json(
            { _tag: "SessionNotFoundError", sessionID, message: `Session ${sessionID} not found` },
            { status: 404 },
          );
        }

        return Response.json({ data: sessionInfo(session) });
      }

      if (url.pathname !== "/api/session") {
        return new Response("not found", { status: 404 });
      }

      return pageResponse(response, url, sessions);
    },
  });

  return {
    url: serverURL(server),
    requests,
    events: {
      send,
      end: () => {
        for (const stream of streams) {
          try {
            stream.close();
          } catch {}
        }
        streams.clear();
      },
      connections: () => connections,
      open: () => streams.size,
    },
    setSessions: (next) => {
      sessions = next;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
};
