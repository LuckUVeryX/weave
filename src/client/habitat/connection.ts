import type { WatchState } from "../watch.ts";
import type { SessionFeed, SourceHealth } from "../../shared/session.ts";

export type ConnectionNotice =
  | { readonly kind: "quiet" }
  | { readonly kind: "transport-lost" }
  | {
      readonly kind: "source-reconnecting";
      readonly sourceIDs: readonly string[];
      readonly sourceCount: number;
    }
  | {
      readonly kind: "source-unavailable";
      readonly sourceIDs: readonly string[];
      readonly sourceCount: number;
    };

const sourceIDsWith = (feed: SessionFeed, health: SourceHealth["kind"]): ReadonlyArray<string> =>
  feed.filter((source) => source.health.kind === health).map((source) => source.id);

export const connectionNotice = (state: WatchState): ConnectionNotice => {
  if (state._tag === "Failed") return { kind: "transport-lost" };
  if (state._tag === "Connecting") return { kind: "quiet" };

  const unavailable = sourceIDsWith(state.feed, "unavailable");
  if (unavailable.length > 0) {
    return { kind: "source-unavailable", sourceIDs: unavailable, sourceCount: state.feed.length };
  }

  const reconnecting = sourceIDsWith(state.feed, "reconnecting");
  if (reconnecting.length > 0) {
    return { kind: "source-reconnecting", sourceIDs: reconnecting, sourceCount: state.feed.length };
  }

  return { kind: "quiet" };
};

export const connectionNoticeText = (notice: ConnectionNotice): string | undefined => {
  switch (notice.kind) {
    case "quiet":
      return undefined;
    case "transport-lost":
      return "Disconnected. Refresh the page.";
    case "source-unavailable": {
      const subject =
        notice.sourceIDs.length === notice.sourceCount ? "OpenCode" : notice.sourceIDs.join(", ");
      return `${subject} unavailable. Restart Weave.`;
    }
    case "source-reconnecting": {
      const subject =
        notice.sourceIDs.length === notice.sourceCount ? "OpenCode" : notice.sourceIDs.join(", ");
      return `${subject} reconnecting`;
    }
  }
};

export const sourceHealth = (feed: SessionFeed): SourceHealth["kind"] => {
  if (feed.some((source) => source.health.kind === "unavailable")) return "unavailable";
  if (feed.some((source) => source.health.kind === "reconnecting")) return "reconnecting";
  if (feed.some((source) => source.health.kind === "connecting")) return "connecting";
  return "connected";
};
