import { useCallback, useEffect, useState } from "react";
import type { BrandProfile } from "@amluto-steps/core";

import type { RecorderBridge } from "../recorder-bridge";
import { applyAppColours, readAppColours, saveAppColours } from "../settings/appColours";
import { parseBrands, syncPolicyBrands } from "../settings/brands";
import { policy } from "../settings/policy";
import type { Theme } from "../settings/preferences";

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

  /** Brands IT deploys from a share come in (or update) before anything is exported. */
  const syncManagedBrands = useCallback(async () => {
    if (!recorder || policy().brandProfiles.length === 0) return;
    const synced = await syncPolicyBrands(
      policy().brandProfiles,
      parseBrands(await recorder.listBrands().catch(() => [])),
      {
        readBrandFile: (path) => recorder.readBrandFile(path),
        checkFont: (bytes) => recorder.checkFont(bytes),
        saveBrand: (profile) => recorder.saveManagedBrand(profile),
      },
    );
    setManagedBrandIds(synced.managedIds);
    if (synced.changed) await refreshBrands();
  }, [recorder, refreshBrands]);

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
