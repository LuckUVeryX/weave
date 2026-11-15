import { Schema } from "effect";

export class RequestFailed extends Schema.TaggedError<RequestFailed, {}>()(
  "OpenCodeSessions.RequestFailed",
  {},
) {}
