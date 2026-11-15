import { useEffect, useLayoutEffect, useMemo, useReducer, useRef } from "react";

import type { WatchState } from "../watch.ts";
import { connectionNotice, connectionNoticeText } from "./connection.ts";
import { directoryName } from "./directory-name.ts";
import { initialInteraction, presentation, reduceInteraction } from "./interaction.ts";
import type { CreatureModel, HabitatModel } from "./model.ts";
import type { HabitatScene } from "./scene.ts";
import { SessionPlacard } from "./SessionPlacard.tsx";
import { SourceControls } from "./SourceControls.tsx";
import { useHabitat } from "./useHabitat.ts";
import { useCopyFeedback } from "./useCopyFeedback.ts";

const DEBUG_REFRESH_MS = 500;
const POINTER_PICK_INTERVAL_MS = 90;
const CAPTION_MARGIN_PX = 8;
const CAPTION_OFFSET_PX = 18;

interface Props {
  readonly model: HabitatModel;
  readonly state: WatchState;
}

const debugSpsRequested = (): boolean => {
  const value = new URLSearchParams(window.location.search).get("debug");
  return value === "1" || value === "sps";
};

function FrameRate({ scene }: { readonly scene: HabitatScene | undefined }) {
  const detailed = debugSpsRequested();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (scene === undefined || node === null) return;

    const paint = (): void => {
      const sample = scene.cycleStats();
      const fps = sample.seconds === 0 ? "FPS --" : `FPS ${Math.round(sample.fps)}`;
      const detail =
        sample.seconds === 0
          ? "SPS -- · FPS --"
          : `SPS ${Math.round(sample.sps)} · FPS ${Math.round(sample.fps)} · ${sample.frameMilliseconds.toFixed(1)} ms`;
      const text = detailed ? detail : fps;
      if (node.textContent !== text) node.textContent = text;
    };

    paint();
    const timer = window.setInterval(paint, DEBUG_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [detailed, scene]);

  return (
    <div
      ref={ref}
      className="habitat-debug"
      data-debug={detailed ? "sps" : "fps"}
      aria-hidden="true"
      title={
        detailed
          ? "SPS: completed fixed simulation steps per wall-clock second. FPS: rendered frames per second. ms: mean frame interval."
          : "FPS: rendered frames per second."
      }
    >
      {detailed ? "SPS -- · FPS --" : "FPS --"}
    </div>
  );
}

export function Habitat({ model, state }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const portraitRef = useRef<HTMLDivElement>(null);
  const tetherRef = useRef<SVGPathElement>(null);
  const markerRef = useRef<SVGCircleElement>(null);
  const { scene, unavailable: rendererUnavailable } = useHabitat(
    canvasRef,
    model,
    state._tag !== "Connecting",
  );
  const [interaction, dispatch] = useReducer(reduceInteraction, initialInteraction);
  const feedback = useCopyFeedback();
  const lastPointerPickAtMs = useRef(0);

  const creatures = useMemo(() => {
    const map = new Map<string, CreatureModel>();
    for (const creature of model.creatures) map.set(creature.key, creature);
    return map;
  }, [model]);

  const view = presentation(interaction, creatures);
  const parent =
    view.kind === "inspecting" && view.creature.parentKey !== undefined
      ? creatures.get(view.creature.parentKey)
      : undefined;
  const openedKey = view.kind === "inspecting" ? view.creature.key : undefined;
  const previewKey = view.kind === "preview" ? view.creature.key : undefined;
  const pointerTarget =
    interaction.hoveredKey !== undefined && creatures.has(interaction.hoveredKey);

  useLayoutEffect(() => {
    scene?.setSelection(openedKey);
    const aperture = portraitRef.current;
    const tether = tetherRef.current;
    const marker = markerRef.current;
    scene?.setSpecimenWindow(
      openedKey === undefined || aperture === null || tether === null || marker === null
        ? undefined
        : { key: openedKey, aperture, tether, marker },
    );
  }, [scene, openedKey]);

  useEffect(() => () => scene?.setSpecimenWindow(undefined), [scene]);

  useEffect(() => {
    dispatch({ kind: "reconcile", creatures });
  }, [creatures]);

  useEffect(() => {
    if (scene === undefined) return;
    if (previewKey === undefined) {
      scene.setAnchorListener(undefined, () => {});
      return;
    }

    scene.setAnchorListener(previewKey, (point) => {
      const card = cardRef.current;
      if (card === null) return;
      if (point === undefined) {
        card.style.visibility = "hidden";
        return;
      }

      const pad = CAPTION_MARGIN_PX;
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      let left = point.x + CAPTION_OFFSET_PX;
      let top = point.y - height * 0.5;
      if (left + width > window.innerWidth - pad) left = point.x - width - CAPTION_OFFSET_PX;
      left = Math.min(Math.max(pad, left), Math.max(pad, window.innerWidth - width - pad));
      top = Math.min(Math.max(pad, top), Math.max(pad, window.innerHeight - height - pad));
      card.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      card.style.visibility = "visible";
    });

    return () => scene.setAnchorListener(undefined, () => {});
  }, [scene, previewKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      if (openedKey !== undefined) return;
      dispatch({ kind: "escape" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openedKey]);

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (event.pointerType !== "mouse") return;
    const now = performance.now();
    if (now - lastPointerPickAtMs.current < POINTER_PICK_INTERVAL_MS) return;
    lastPointerPickAtMs.current = now;
    dispatch({ kind: "hover", key: scene?.pickAt(event.clientX, event.clientY) });
  };

  const onPointerLeave = (): void => {
    dispatch({ kind: "hover", key: undefined });
  };

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const key = scene?.pickAt(event.clientX, event.clientY);
    dispatch({ kind: "toggle", key });
  };

  const notice = connectionNotice(state);
  const noticeText = connectionNoticeText(notice);

  return (
    <div className="fixed inset-0 overflow-hidden bg-background">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 size-full touch-manipulation"
        style={{ cursor: pointerTarget ? "pointer" : undefined }}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
      />

      {view.kind !== "inspecting" ? null : (
        <svg className="specimen-tether" aria-hidden="true">
          <path ref={tetherRef} />
          <circle ref={markerRef} r="3" />
        </svg>
      )}

      <div
        ref={cardRef}
        className="habitat-caption"
        style={{ visibility: "hidden" }}
        hidden={view.kind !== "preview"}
        data-focused={view.kind === "preview" && view.source === "keyboard" ? "true" : undefined}
      >
        {view.kind === "preview" ? view.creature.session.title || "Untitled session" : undefined}
      </div>

      {view.kind !== "inspecting" ? null : (
        <SessionPlacard
          item={view.creature}
          parent={
            parent === undefined
              ? undefined
              : {
                  title: parent.session.title || "Untitled session",
                  onSelect: () => dispatch({ kind: "toggle", key: parent.key }),
                }
          }
          portraitRef={portraitRef}
          onClose={() => dispatch({ kind: "close" })}
          onToast={feedback.show}
          toast={feedback.message}
        />
      )}

      <div className="sr-only">
        <p role="status" aria-live="polite">
          {view.kind === "idle"
            ? ""
            : `${view.creature.session.title || "Untitled session"}, ${directoryName(view.creature.session.location.directory)}`}
        </p>
        <ul aria-label="Sessions">
          {model.creatures.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                onFocus={() => dispatch({ kind: "focus", key: item.key })}
                onBlur={() => dispatch({ kind: "blur", key: item.key })}
                onClick={() => dispatch({ kind: "toggle", key: item.key })}
              >
                {item.session.title || "Untitled session"},{" "}
                {directoryName(item.session.location.directory)}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="habitat-hud">
        <FrameRate scene={scene} />
        {state._tag === "Failed" ? null : (
          <SourceControls feed={state._tag === "Live" ? state.feed : []} />
        )}
        {rendererUnavailable ? (
          <p className="connection-notice" data-renderer="unavailable" role="status">
            Unable to start rendering. Check WebGPU support in your browser.
          </p>
        ) : null}
        {noticeText === undefined ? null : (
          <p className="connection-notice" data-kind={notice.kind} role="status">
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            >
              <circle cx="8" cy="8" r="6.2" />
              <path d="M8 4.8v4.2M8 11.4v.1" />
            </svg>
            <span>{noticeText}</span>
          </p>
        )}
      </div>
    </div>
  );
}
