import { describe, expect, test } from "vitest";

import {
  connectionNotice,
  connectionNoticeText,
  sourceHealth,
} from "../src/client/habitat/connection.ts";
import type { WatchState } from "../src/client/watch.ts";
import type { SessionFeed, SourceHealth } from "../src/shared/session.ts";

const source = (id: string, health: SourceHealth["kind"]): SessionFeed[number] => ({
  id,
  health:
    health === "reconnecting" ? { kind: health, retry: 1, retryDelayMs: 1_000 } : { kind: health },
  sessions: [],
});

const live = (feed: SessionFeed): WatchState => ({ _tag: "Live", feed });

describe("connection notice", () => {
  test("transport failure wins over a retained healthy-looking feed", () => {
    const state: WatchState = { _tag: "Failed", feed: [source("local", "connected")] };
    const notice = connectionNotice(state);

    expect(notice).toEqual({ kind: "transport-lost" });
    expect(connectionNoticeText(notice)).toBe("Disconnected. Refresh the page.");
  });

  test("initial connecting and a healthy feed are quiet", () => {
    expect(connectionNotice({ _tag: "Connecting" })).toEqual({ kind: "quiet" });
    expect(connectionNotice(live([source("local", "connected")]))).toEqual({ kind: "quiet" });
    expect(connectionNotice(live([source("local", "connecting")]))).toEqual({ kind: "quiet" });
  });

  test("unavailable wins over a reconnecting sibling and over stale connected sources", () => {
    expect(
      connectionNotice(live([source("local", "connected"), source("offline", "unavailable")])),
    ).toEqual({
      kind: "source-unavailable",
      sourceIDs: ["offline"],
      sourceCount: 2,
    });
    expect(
      connectionNotice(
        live([source("starting", "reconnecting"), source("offline", "unavailable")]),
      ),
    ).toEqual({
      kind: "source-unavailable",
      sourceIDs: ["offline"],
      sourceCount: 2,
    });
    expect(
      connectionNotice(live([source("offline", "unavailable"), source("local", "connected")])),
    ).toEqual({
      kind: "source-unavailable",
      sourceIDs: ["offline"],
      sourceCount: 2,
    });
  });

  test("affected source names distinguish all-source copy from a subset", () => {
    const all = connectionNotice(live([source("local", "reconnecting")]));
    const subset = connectionNotice(
      live([source("local", "connected"), source("laptop", "reconnecting")]),
    );

    expect(connectionNoticeText(all)).toBe("OpenCode reconnecting");
    expect(connectionNoticeText(subset)).toBe("laptop reconnecting");
    expect(
      connectionNoticeText(
        connectionNotice(live([source("laptop", "unavailable"), source("remote", "unavailable")])),
      ),
    ).toBe("OpenCode unavailable. Restart Weave.");
    expect(
      connectionNoticeText(
        connectionNotice(live([source("local", "connected"), source("laptop", "unavailable")])),
      ),
    ).toBe("laptop unavailable. Restart Weave.");
  });

  test("the source icon reports connecting instead of a false green", () => {
    expect(sourceHealth([source("local", "connected")])).toBe("connected");
    expect(sourceHealth([source("local", "connecting")])).toBe("connecting");
    expect(sourceHealth([source("local", "connected"), source("remote", "reconnecting")])).toBe(
      "reconnecting",
    );
    expect(sourceHealth([source("local", "reconnecting"), source("remote", "unavailable")])).toBe(
      "unavailable",
    );
  });
});
