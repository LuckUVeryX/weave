import { SessionAttention, SessionView } from "../shared/session.ts";
import type { SessionSummary } from "../shared/session.ts";

export const toSessionView = (
  session: SessionSummary,
  status: SessionView["status"],
  attention: SessionAttention,
): SessionView =>
  SessionView.make({
    id: session.id,
    ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.outcome === undefined ? {} : { outcome: session.outcome }),
    time: session.time,
    location: session.location,
    status,
    attention,
  });
