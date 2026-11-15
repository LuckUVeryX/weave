import { useMemo } from "react";

import { Habitat } from "./habitat/Habitat.tsx";
import { projectFeed } from "./habitat/model.ts";
import { useWatchState } from "./watch.ts";

export function App() {
  const state = useWatchState();
  const model = useMemo(() => projectFeed(state._tag === "Connecting" ? [] : state.feed), [state]);

  return <Habitat model={model} state={state} />;
}
