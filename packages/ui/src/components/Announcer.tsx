import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type Announce = (text: string) => void;

const AnnounceContext = createContext<Announce>(() => undefined);

/**
 * Says something to screen readers without moving focus (WCAG 4.1.3): progress, search results,
 * a comment saved, the mark selected in the image editor. Outside an `AnnouncerProvider` (a
 * component on its own in a test) it does nothing.
 */
export const useAnnounce = (): Announce => useContext(AnnounceContext);

/**
 * The one polite live region for the window. It is always in the page, empty until there's
 * something to say: a region added together with its words is often not read at all.
 */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const announce = useCallback((text: string) => {
    // Emptied first, so the same words twice in a row (two nudges) are read twice.
    setMessage("");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMessage(text), 50);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <AnnounceContext.Provider value={announce}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {message}
      </div>
    </AnnounceContext.Provider>
  );
}
