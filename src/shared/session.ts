import { Session } from "@opencode/client/effect";
import { Schema } from "effect";

const SessionSummaryFields = {
  id: Session.Info.fields.id,
  parentID: Session.Info.fields.parentID,
  title: Session.Info.fields.title,
  outcome: Session.Info.fields.outcome,
  time: Session.Info.fields.time,
  location: Schema.Struct({
    directory: Session.Info.fields.location.fields.directory,
  }),
};

export const SessionSummary = Schema.toEncoded(Schema.Struct(SessionSummaryFields)).annotate({
  identifier: "SessionSummary",
});

export interface SessionSummary extends Schema.Schema.Type<typeof SessionSummary> {}

export const SessionAttention = Schema.Struct({
  permissions: Schema.Int,
  questions: Schema.Int,
}).annotate({ identifier: "SessionAttention" });

export interface SessionAttention extends Schema.Schema.Type<typeof SessionAttention> {}

export const SessionView = Schema.toEncoded(
  Schema.Struct({
    ...SessionSummaryFields,
    status: Schema.Literals(["idle", "running"]),
    attention: SessionAttention,
  }),
).annotate({ identifier: "SessionView" });

export interface SessionView extends Schema.Schema.Type<typeof SessionView> {}

export const SourceHealth = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("connecting") }),
  Schema.Struct({ kind: Schema.Literal("connected") }),
  Schema.Struct({
    kind: Schema.Literal("reconnecting"),
    retry: Schema.Int,
    retryDelayMs: Schema.Int,
  }),
  Schema.Struct({ kind: Schema.Literal("unavailable") }),
]).annotate({ identifier: "SourceHealth" });

export type SourceHealth = typeof SourceHealth.Type;

export const SourceSessions = Schema.Struct({
  id: Schema.String,
  health: SourceHealth,
  sessions: Schema.Array(SessionView),
}).annotate({ identifier: "SourceSessions" });

export interface SourceSessions extends Schema.Schema.Type<typeof SourceSessions> {}

export const SessionFeed = Schema.Array(SourceSessions).annotate({
  identifier: "SessionFeed",
});

export interface SessionFeed extends Schema.Schema.Type<typeof SessionFeed> {}
