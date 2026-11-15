import { RegistryProvider } from "@effect/atom-react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { App } from "../../src/client/App.tsx";
import "../../src/client/styles.css";
import { useWatchState } from "../../src/client/watch.ts";

function FeedReadout() {
  const state = useWatchState();
  return <p data-feed-state>{state._tag}</p>;
}

function SceneHarness() {
  const [mounted, setMounted] = useState(true);
  return (
    <main className="probe">
      <button type="button" data-toggle-consumers onClick={() => setMounted((value) => !value)}>
        {mounted ? "Unmount App" : "Mount App"}
      </button>
      <FeedReadout />
      <div className="stage">{mounted ? <App /> : null}</div>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing #root element.");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <SceneHarness />
    </RegistryProvider>
  </StrictMode>,
);
