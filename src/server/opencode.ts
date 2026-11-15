import type { SessionNotFoundError } from "@opencode/client";
import {
  OpenCode,
  Session,
  type OpenCodeClient,
  type OpenCodeEvent,
} from "@opencode/client/effect";
import { Config, Context, Effect, Layer, Option, Record, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { RequestFailed } from "../shared/errors.ts";
import { SessionSummary } from "../shared/session.ts";

export interface Interface {
  readonly get: (
    id: Session.ID,
  ) => Effect.Effect<SessionSummary, SessionNotFoundError | RequestFailed>;
  readonly readActiveIDs: Effect.Effect<ReadonlyArray<Session.ID>, RequestFailed>;
  readonly readSessions: Effect.Effect<ReadonlyArray<SessionSummary>, RequestFailed>;
  readonly events: Stream.Stream<OpenCodeEvent, RequestFailed>;
}

export interface Source {
  readonly id: string;
  readonly client: Interface;
}

export class Service extends Context.Service<Service, ReadonlyArray<Source>>()(
  "@weave/OpenCodeSessions",
) {}

const httpURL = Schema.URLFromString.check(
  Schema.makeFilter((url) => url.protocol === "http:" || url.protocol === "https:"),
);

const sourceConfig = Schema.NonEmptyArray(
  Schema.Struct({
    id: Schema.NonEmptyString,
    username: Schema.RedactedFromValue(Schema.String),
    password: Schema.RedactedFromValue(Schema.String),
    url: httpURL,
  }),
).check(
  Schema.makeFilter(
    (sources) => new Set(sources.map((source) => source.id)).size === sources.length,
  ),
);

class InvalidSources extends Schema.TaggedError<
  InvalidSources,
  { readonly brand: unique symbol }
>()("OpenCodeSources.InvalidConfig", {
  message: Schema.String,
}) {}

const sourcesConfig = Effect.gen(function* () {
  const configured = yield* Config.option(Config.Redacted("WEAVE_OPENCODE_SOURCES"));
  if (Option.isSome(configured)) {
    const decoded = yield* Effect.try((): unknown =>
      JSON.parse(Redacted.value(configured.value)),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(sourceConfig)),
      Effect.mapError(
        () =>
          new InvalidSources({
            message:
              "WEAVE_OPENCODE_SOURCES must be a nonempty JSON array with unique nonempty ids, username, password, and HTTP(S) url fields.",
          }),
      ),
    );
    return decoded;
  }

  const url = yield* Config.schema(httpURL, "WEAVE_OPENCODE_URL");
  const password = yield* Config.Redacted("WEAVE_OPENCODE_PASSWORD");
  return [{ id: "local", url, username: Redacted.make("opencode"), password }];
});

const pageSize = 500;

const watchEventTypes = [
  "session.created",
  "session.renamed",
  "session.moved",
  "session.metadata.updated",
  "session.viewed",
  "session.archived",
  "session.unarchived",
  "session.deleted",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.status",
  "session.idle",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
] as const;

const summarize = (session: Session.Info): Effect.Effect<SessionSummary, RequestFailed> =>
  Schema.encodeEffect(SessionSummary.schema)(session).pipe(
    Effect.mapError(() => new RequestFailed()),
  );

const readSessions = Effect.fn("OpenCodeSessions.readSessions")(function* (client: OpenCodeClient) {
  const sessions: Array<SessionSummary> = [];
  let cursor: Session.ListCursor | undefined;

  while (true) {
    const page = yield* client.session
      .list({
        archived: false,
        limit: pageSize,
        order: "desc",
        ...(cursor === undefined ? {} : { cursor }),
      })
      .pipe(Effect.mapError(() => new RequestFailed()));

    for (const session of page.data) sessions.push(yield* summarize(session));

    const next = page.cursor.next;
    if (page.data.length === 0 || next === undefined) break;
    cursor = next;
  }

  return sessions;
});

const readActiveIDs = Effect.fn("OpenCodeSessions.readActiveIDs")(function* (
  client: OpenCodeClient,
) {
  const active = yield* client.session.active().pipe(Effect.mapError(() => new RequestFailed()));

  return Record.keys(active);
});

const getSession = Effect.fn("OpenCodeSessions.get")(function* (
  client: OpenCodeClient,
  id: Session.ID,
) {
  const session = yield* client.session
    .get({ sessionID: id })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "SessionNotFoundError" ? error : new RequestFailed(),
      ),
    );

  return yield* summarize(session);
});

const readEvents = (client: OpenCodeClient): Stream.Stream<OpenCodeEvent, RequestFailed> =>
  client.event.subscribe({ types: watchEventTypes }).pipe(
    Stream.mapError(() => new RequestFailed()),
    Stream.concat(Stream.fail(new RequestFailed())),
  );

const adapter = (client: OpenCodeClient): Interface => ({
  get: (id) => getSession(client, id),
  readActiveIDs: readActiveIDs(client),
  readSessions: readSessions(client),
  events: readEvents(client),
});

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sources = yield* sourcesConfig;
    const http = yield* HttpClient.HttpClient;
    return yield* Effect.forEach(sources, (source) =>
      OpenCode.make({ baseUrl: source.url }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.mapRequest(
            http,
            HttpClientRequest.basicAuth(Redacted.value(source.username), source.password),
          ),
        ),
        Effect.map((client): Source => ({ id: source.id, client: adapter(client) })),
      ),
    );
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
