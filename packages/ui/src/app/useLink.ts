import { useCallback, useEffect, useState } from "react";

import { isBrowserEdition, type LinkStatus, type RecorderBridge } from "../recorder-bridge";
import { readBrowserLink, saveBrowserLink } from "../settings/preferences";

export interface Link {
  /** Null until the app or the extension has said. */
  status: LinkStatus | null;
  set: (on: boolean) => Promise<void>;
}

/**
 * The link between Steps for Windows and Steps for Chrome and Edge
 * (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together). The desktop switches its
 * side on or off as the app opens, from the person's choice (or the app's default); the browser's
 * side is kept by its background worker, so the page only reads and changes it.
 */
export function useLink(recorder: RecorderBridge | undefined): Link {
  const [status, setStatus] = useState<LinkStatus | null>(null);

  useEffect(() => {
    if (!recorder?.getLink) return undefined;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const first =
      !isBrowserEdition(recorder) && recorder.setLink
        ? recorder.setLink(readBrowserLink())
        : recorder.getLink();
    first.then((value) => !cancelled && setStatus(value)).catch(() => undefined);
    recorder
      .onLink?.((value) => setStatus(value))
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [recorder]);

  const set = useCallback(
    async (on: boolean) => {
      if (!recorder?.setLink) return;
      // Straight from the click: the browser asks for Chrome's permission before anything else.
      const next = recorder.setLink(on);
      if (!isBrowserEdition(recorder)) saveBrowserLink(on);
      setStatus(await next);
    },
    [recorder],
  );

  return { status, set };
}
