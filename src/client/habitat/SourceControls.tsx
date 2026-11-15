import { useId, useRef, useState } from "react";

import type { SessionFeed } from "../../shared/session.ts";
import { sourceHealth } from "./connection.ts";

const statusNames = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  unavailable: "Unavailable",
};

export function SourceControls({ feed }: { readonly feed: SessionFeed }) {
  const id = useId();
  const details = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pinned = useRef(false);
  const [open, setOpen] = useState(false);
  const health = sourceHealth(feed);

  const preview = (): void => details.current?.showPopover();
  const dismissPreview = (): void => {
    if (!pinned.current && !button.current?.matches(":focus-visible")) {
      details.current?.hidePopover();
    }
  };
  const leave = (event: React.PointerEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    dismissPreview();
  };

  if (feed.length === 0) return null;

  return (
    <div className="source-controls" onPointerLeave={leave}>
      <button
        ref={button}
        type="button"
        className="source-control"
        data-health={health}
        aria-label={`Servers: ${statusNames[health]}`}
        aria-expanded={open}
        aria-controls={id}
        popoverTarget={id}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") preview();
        }}
        onFocus={preview}
        onBlur={() => {
          if (!pinned.current) details.current?.hidePopover();
        }}
        onClick={(event) => {
          event.preventDefault();
          if (pinned.current) {
            details.current?.hidePopover();
          } else {
            pinned.current = true;
            preview();
          }
        }}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="6" rx="1.5" />
          <path d="M12 14H4.5A1.5 1.5 0 0 1 3 12.5V10M7 7h.01M7 13h.01" />
          {health === "connected" ? <path d="m15 17 2 2 4-5" /> : null}
          {health === "reconnecting" ? <path d="M21 17a3 3 0 1 1-1-2.2M21 13v3h-3" /> : null}
          {health === "unavailable" ? <path d="m16 15 4 4m0-4-4 4" /> : null}
        </svg>
      </button>
      <div
        ref={details}
        id={id}
        popover="auto"
        className="source-details"
        role="list"
        aria-label="Servers"
        onBeforeToggle={(event) => {
          const visible = event.newState === "open";
          setOpen(visible);
          if (!visible) pinned.current = false;
        }}
      >
        {feed.map((source) => (
          <div
            key={source.id}
            role="listitem"
            className="source-row"
            data-health={source.health.kind}
            aria-label={`${source.id}: ${statusNames[source.health.kind]}`}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {source.health.kind === "connected" ? <path d="m3 8 3 3 7-7" /> : null}
              {source.health.kind === "connecting" ? <circle cx="8" cy="8" r="5" /> : null}
              {source.health.kind === "reconnecting" ? (
                <path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v4H9" />
              ) : null}
              {source.health.kind === "unavailable" ? <path d="m4 4 8 8m0-8-8 8" /> : null}
            </svg>
            <span>{source.id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
