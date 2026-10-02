import {
  AMLUTO_BRAND_ID,
  contrast,
  ensureContrast,
  mix,
  type BrandProfile,
} from "@amluto-steps/core";

import { policy } from "./policy";

/**
 * "App colours": a brand profile themes the app itself (docs/spec/06-brands-and-theming.md#app-theming).
 * Only the colours a brand owns change; surfaces, text greys and warnings stay the app's own.
 * Every colour is checked against what it actually sits on: text at 4.6:1 on the page and on the
 * selected tint (a selected nav item, a chip), lines and focus rings at 3:1, and the sidebar's grey
 * labels on the branded sidebar. The dark versions are worked out the same way unless the brand
 * sets its own.
 */
const LIGHT_SURFACE = "#FFFFFF";
const DARK_SURFACE = "#111C2E";
const SIDEBAR_TEXT = "#D7E1EE";
const SIDEBAR_MUTED = "#A9B8CC";

/**
 * The sidebar: the brand's colour, darkened until its text reads on it — the grey labels at
 * 4.5:1, and the light text on the highlighted row (12% white over the sidebar) at 4.6:1.
 */
function sidebarColour(start: string): string {
  let colour = start;
  for (let step = 0; step < 40; step += 1) {
    if (
      contrast(SIDEBAR_MUTED, colour) >= 4.5 &&
      contrast(SIDEBAR_TEXT, mix(colour, "#FFFFFF", 0.12)) >= 4.6
    )
      return colour;
    colour = mix(colour, "#000000", 0.08);
  }
  return "#000000";
}
const KEY = "amluto-steps-app-colours";

/** The CSS variables a brand sets, for one mode. */
export function appColourVariables(
  profile: BrandProfile,
  mode: "light" | "dark",
): Record<string, string> {
  if (mode === "light") {
    // The selected tint is darker than the page, so text that reads on it reads on the page too.
    const selected = mix(profile.accent, LIGHT_SURFACE, 0.88);
    return {
      "--amluto-navy": ensureContrast(profile.primary, selected, 4.6),
      "--amluto-brand-navy": ensureContrast(profile.primary, LIGHT_SURFACE, 4.6),
      "--amluto-blue": ensureContrast(profile.accent, LIGHT_SURFACE, 3),
      "--amluto-link": ensureContrast(profile.accent, selected, 4.6),
      "--amluto-selected": selected,
      "--amluto-highlight": ensureContrast(profile.highlight, LIGHT_SURFACE, 3),
      "--amluto-sidebar": sidebarColour(mix(profile.primary, "#000000", 0.25)),
    };
  }
  const own = profile.dark ?? {};
  const primary = own.primary ?? mix(profile.primary, "#FFFFFF", 0.8);
  const accent = own.accent ?? mix(profile.accent, "#FFFFFF", 0.35);
  const highlight = own.highlight ?? mix(profile.highlight, "#FFFFFF", 0.3);
  // Lighter than the dark page, so light text that reads on it reads on the page too.
  const selected = mix(profile.accent, DARK_SURFACE, 0.72);
  return {
    "--amluto-navy": ensureContrast(primary, selected, 4.6),
    "--amluto-brand-navy": ensureContrast(profile.primary, "#FFFFFF", 4.6),
    "--amluto-blue": ensureContrast(accent, DARK_SURFACE, 3),
    "--amluto-link": ensureContrast(accent, selected, 4.6),
    "--amluto-selected": selected,
    "--amluto-highlight": ensureContrast(highlight, DARK_SURFACE, 3),
    "--amluto-sidebar": sidebarColour(mix(profile.primary, "#000000", 0.65)),
  };
}

/** Every variable a brand may set, so switching back to Amluto removes them all. */
export const APP_COLOUR_VARIABLES = [
  "--amluto-navy",
  "--amluto-brand-navy",
  "--amluto-blue",
  "--amluto-link",
  "--amluto-selected",
  "--amluto-highlight",
  "--amluto-sidebar",
] as const;

/** The profile chosen for the app's colours (IT policy wins). */
export function readAppColours(): string {
  const managed = policy().appColoursBrand;
  if (managed) return managed;
  try {
    return window.localStorage.getItem(KEY) ?? AMLUTO_BRAND_ID;
  } catch {
    return AMLUTO_BRAND_ID;
  }
}

export function saveAppColours(id: string) {
  try {
    window.localStorage.setItem(KEY, id);
  } catch {
    // Storage can be unavailable; the choice still applies until the app closes.
  }
}

const isDark = () => {
  const chosen = document.documentElement.getAttribute("data-theme");
  if (chosen) return chosen === "dark";
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
};

/**
 * Puts a profile's colours on the page for the current mode, or takes them off for Amluto's own.
 * Called again whenever the theme or the system's light/dark setting changes.
 */
export function applyAppColours(profile: BrandProfile | null) {
  const style = document.documentElement.style;
  for (const name of APP_COLOUR_VARIABLES) style.removeProperty(name);
  if (!profile || profile.id === AMLUTO_BRAND_ID) return;
  for (const [name, value] of Object.entries(
    appColourVariables(profile, isDark() ? "dark" : "light"),
  ))
    style.setProperty(name, value);
}
