import { useEffect } from "react";

import type { SharedEditing } from "../library-bridge";
import { useLatest } from "../useLatest";

/** How often an open library or read-only guide checks for synced changes. */
export const WATCH_MS = 5_000;

/**
 * Live refresh (docs/spec/03-data-and-sharing.md#shared-libraries-sharepoint--onedrive): while
 * `active`, asks for a fingerprint of `check`'s target every few seconds and calls `onChange`
 * when it differs from the last one, as when a sync client brings someone else's changes.
 */
export function useFingerprintWatch(
  check: (() => Promise<string>) | null,
  active: boolean,
  onChange: () => void,
) {
  const onChangeRef = useLatest(onChange);
  const checkRef = useLatest(check);
  useEffect(() => {
    if (!active || !checkRef.current) return undefined;
    let last: string | null = null;
    let live = true;
    const look = () =>
      checkRef
        .current?.()
        .then((fingerprint) => {
          if (!live) return;
          if (last !== null && fingerprint !== last) onChangeRef.current();
          last = fingerprint;
        })
        .catch(() => undefined);
    void look();
    const timer = window.setInterval(() => void look(), WATCH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [active, checkRef, onChangeRef]);
}

/** The guide list follows synced changes while it's on screen. */
export function useLibraryWatch(
  library: SharedEditing | undefined,
  libraryId: string | null | undefined,
  active: boolean,
  onChange: () => void,
) {
  useFingerprintWatch(
    library && libraryId ? () => library.fingerprint(libraryId) : null,
    active && Boolean(library && libraryId),
    onChange,
  );
}
