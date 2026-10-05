import { useCallback, useEffect, useState } from "react";
import type { BrandProfile } from "@amluto-steps/core";

import type { RecorderBridge } from "../recorder-bridge";
import { applyAppColours, readAppColours, saveAppColours } from "../settings/appColours";
import { parseBrands, syncPolicyBrands } from "../settings/brands";
import { policy } from "../settings/policy";
import type { Theme } from "../settings/preferences";

/** How often a policy brand file that couldn't be read is tried again. */
const BRAND_RETRY_MS = 3 * 60_000;

/**
 * The brand profiles on this PC, the ones IT deployed (read-only), and the one whose colours theme
 * the app (docs/spec/06-brands-and-theming.md).
 */
export function useBrands(recorder: RecorderBridge | undefined, theme: Theme) {
  const [brands, setBrands] = useState<BrandProfile[]>([]);
  /** Brands deployed by IT policy: shown read-only in Settings. */
  const [managedBrandIds, setManagedBrandIds] = useState<string[]>([]);
  /** The profile whose colours theme the app (Settings > Appearance, or IT policy). */
  const [appColours, setAppColours] = useState(readAppColours);

  // A client brand's colours on the app, redone when the brand, the theme or Windows' own
  // light/dark setting changes (docs/spec/06-brands-and-theming.md#app-theming).
  useEffect(() => {
    const profile = brands.find((item) => item.id === appColours) ?? null;
    applyAppColours(profile);
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const redo = () => applyAppColours(profile);
    query.addEventListener("change", redo);
    return () => query.removeEventListener("change", redo);
  }, [brands, appColours, theme]);

  const refreshBrands = useCallback(async () => {
    if (!recorder) return;
    try {
      setBrands(parseBrands(await recorder.listBrands()));
    } catch {
      setBrands([]);
    }
  }, [recorder]);

  /** Policy brand files that couldn't be read last time (the share out of reach). */
  const [unread, setUnread] = useState(0);

  /**
   * Brands IT deploys from a share come in (or update) before anything is exported. One imported
   * before stays IT's, read-only, even while the share can't be reached (04/10/2026).
   */
  const syncManagedBrands = useCallback(async () => {
    if (!recorder) return;
    const synced =
      policy().brandProfiles.length > 0
        ? await syncPolicyBrands(
            policy().brandProfiles,
            parseBrands(await recorder.listBrands().catch(() => [])),
            {
              readBrandFile: (path) => recorder.readBrandFile(path),
              checkFont: (bytes) => recorder.checkFont(bytes),
              saveBrand: (profile) => recorder.saveManagedBrand(profile),
            },
          )
        : { managedIds: [], changed: false, unread: 0 };
    const marked = await (recorder.managedBrandIds?.() ?? Promise.resolve([])).catch(() => []);
    setManagedBrandIds([...new Set([...synced.managedIds, ...marked])]);
    setUnread(synced.unread);
    if (synced.changed) await refreshBrands();
  }, [recorder, refreshBrands]);

  // A share that wasn't reachable (the VPN not up yet) is tried again every few minutes and when
  // the window comes forward, until every brand file has been read.
  useEffect(() => {
    if (unread === 0) return undefined;
    const retry = () => void syncManagedBrands().catch(() => undefined);
    const timer = window.setInterval(retry, BRAND_RETRY_MS);
    window.addEventListener("focus", retry);
    window.addEventListener("online", retry);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", retry);
      window.removeEventListener("online", retry);
    };
  }, [unread, syncManagedBrands]);

  const chooseAppColours = useCallback((id: string) => {
    saveAppColours(id);
    setAppColours(id);
  }, []);

  return {
    brands,
    refreshBrands,
    managedBrandIds,
    syncManagedBrands,
    appColours,
    chooseAppColours,
  };
}
