import { Rpc, RpcGroup } from "effect/rpc";
import { RequestFailed } from "./errors.ts";
import { SessionFeed } from "./session.ts";

const WatchSessions = Rpc.make("watchSessions", {
  success: SessionFeed,
  error: RequestFailed,
  stream: true,
});

export const Group = RpcGroup.make(WatchSessions);
