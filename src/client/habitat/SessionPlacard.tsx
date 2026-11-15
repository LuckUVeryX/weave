import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

import type { CreatureModel } from "./model.ts";
import { directoryName } from "./directory-name.ts";

const RELATIVE_TIME_REFRESH_MS = 30_000;

const attentionText = (item: CreatureModel): string => {
  const { permissions, questions } = item.session.attention;
  return [
    permissions > 0
      ? `${permissions} permission ${permissions === 1 ? "request" : "requests"}`
      : "",
    questions > 0 ? `${questions} ${questions === 1 ? "question" : "questions"} pending` : "",
  ]
    .filter(Boolean)
    .join(", ");
};

function sessionPayload(item: CreatureModel): string {
  const { session } = item;
  const lines = [
    `Title: ${session.title || "Untitled session"}`,
    `Session ID: ${session.id}`,
    `Source ID: ${item.sourceID}`,
    `Directory: ${session.location.directory}`,
  ];
  if (session.parentID !== undefined) lines.push(`Parent ID: ${session.parentID}`);
  lines.push(`Status: ${session.status === "running" ? "Running" : "Idle"}`);
  const attention = attentionText(item);
  if (attention !== "") lines.push(`Attention: ${attention}`);
  lines.push(`Updated: ${new Date(session.time.updated).toISOString()}`);
  const lastRun = session.status === "running" ? session.time.busy : session.time.idle;
  if (lastRun !== undefined) {
    lines.push(
      `Last run: ${session.status === "running" ? "Running since" : "Ended"} ${new Date(lastRun).toISOString()}`,
    );
  }
  if (session.outcome !== undefined) lines.push(`Outcome: ${session.outcome}`);
  return lines.join("\n");
}

const relativeTime = (updated: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - updated) / 60_000));
  return minutes < 1
    ? "now"
    : minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.round(minutes / 60)}h`
        : `${Math.round(minutes / 1440)}d`;
};

export function SessionPlacard({
  item,
  portraitRef,
  onClose,
  onToast,
  toast,
}: {
  readonly item: CreatureModel;
  readonly portraitRef: RefObject<HTMLDivElement | null>;
  readonly onClose: () => void;
  readonly onToast: (message: string) => void;
  readonly toast: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [now, setNow] = useState(Date.now);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement;
    dialog?.show();
    dialog?.focus({ preventScroll: true });
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", escape);
    const timer = window.setInterval(() => setNow(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => {
      window.removeEventListener("keydown", escape);
      window.clearInterval(timer);
    };
  }, []);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(sessionPayload(item));
      onToast("Session context copied");
    } catch {
      onToast("Could not copy session context");
    }
  };

  const attention = attentionText(item);
  const updated = new Date(item.session.time.updated);
  const title = item.session.title || "Untitled session";

  return (
    <dialog
      ref={dialogRef}
      className="session-placard"
      tabIndex={-1}
      aria-labelledby="session-title"
    >
      <div className="specimen-frame">
        <div
          ref={portraitRef}
          className="specimen-window"
          role="img"
          aria-label={`Live close-up of ${title}`}
        />
      </div>
      <header className="sheet-header">
        <div className="sheet-heading">
          <h2 id="session-title">
            <button
              type="button"
              className="sheet-title-button"
              title="Copy session context"
              onClick={() => void copy()}
            >
              {title}
            </button>
          </h2>
          <div className="sheet-context">
            <span
              className="context-folder"
              tabIndex={0}
              role="group"
              aria-label={directoryName(item.session.location.directory)}
              aria-describedby="folder-path"
            >
              <span className="folder-name">{directoryName(item.session.location.directory)}</span>
              <span id="folder-path" role="tooltip" className="folder-tooltip">
                {item.session.location.directory}
              </span>
            </span>
            <span className="context-status">
              {attention === "" ? (
                <span
                  role="img"
                  aria-label={item.session.status === "running" ? "Running" : "Idle"}
                  title={item.session.status === "running" ? "Running" : "Idle"}
                  className="status-dot"
                  data-status={item.session.status}
                />
              ) : (
                <span
                  className="attention-icon"
                  role="img"
                  aria-label={attention}
                  title={attention}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  >
                    <circle cx="12" cy="12" r="8" />
                    <path d="M12 7.6v5.1M12 16.3v.1" />
                  </svg>
                </span>
              )}
            </span>
          </div>
          <div className="sheet-provenance">
            <span className="context-source" title={`Source ${item.sourceID}`}>
              {item.sourceID}
            </span>
            <span
              className="context-time"
              aria-label={`Updated ${updated.toLocaleString()}`}
              title={`Updated ${updated.toLocaleString()}`}
            >
              <time dateTime={updated.toISOString()}>
                {relativeTime(item.session.time.updated, now)}
              </time>
            </span>
          </div>
        </div>
      </header>
      <div role="status" aria-live="polite" className={toast === "" ? "sr-only" : "copy-toast"}>
        {toast}
      </div>
    </dialog>
  );
}
