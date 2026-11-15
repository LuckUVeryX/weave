import { useEffect, useRef, useState } from "react";

const TOAST_DURATION_MS = 2400;

export function useCopyFeedback() {
  const [message, setMessage] = useState("");
  const dismissTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (dismissTimer.current !== undefined) window.clearTimeout(dismissTimer.current);
    },
    [],
  );

  const show = (next: string): void => {
    if (dismissTimer.current !== undefined) window.clearTimeout(dismissTimer.current);
    setMessage(next);
    dismissTimer.current = window.setTimeout(() => setMessage(""), TOAST_DURATION_MS);
  };

  return { message, show };
}
