import { useEffect, useRef, useState, type RefObject } from "react";

import type { HabitatModel } from "./model.ts";
import { HabitatScene } from "./scene.ts";

declare global {
  interface Window {
    __weaveHabitat?: HabitatScene;
  }
}

export function useHabitat(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  model: HabitatModel,
  ready: boolean,
): { readonly scene: HabitatScene | undefined; readonly unavailable: boolean } {
  const [scene, setScene] = useState<HabitatScene>();
  const [unavailable, setUnavailable] = useState(false);
  const latest = useRef(model);
  latest.current = model;

  useEffect(() => {
    setUnavailable(false);
    const canvas = canvasRef.current;
    if (canvas === null || !ready) return;

    let cancelled = false;
    let habitat: HabitatScene | undefined;

    void HabitatScene.create(canvas, () => latest.current)
      .then((created) => {
        if (cancelled) {
          void created.dispose();
          return;
        }
        habitat = created;
        created.setModel(latest.current);
        created.start();
        if (import.meta.env.DEV) window.__weaveHabitat = created;
        setScene(created);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });

    return () => {
      cancelled = true;
      setScene(undefined);
      if (import.meta.env.DEV && window.__weaveHabitat === habitat) {
        delete window.__weaveHabitat;
      }
      if (habitat !== undefined) void habitat.dispose();
      habitat = undefined;
    };
  }, [canvasRef, ready]);

  useEffect(() => {
    scene?.setModel(model);
  }, [scene, model]);

  return { scene, unavailable };
}
