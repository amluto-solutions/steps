import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { applyTheme, type Theme } from "./preferences";

const DARK_QUERY = "(prefers-color-scheme: dark)";

const deviceIsDark = () =>
  typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;

const reducedMotion = () =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => {
    finished: Promise<void>;
    skipTransition?: () => void;
  };
};

/** The reveal takes 700 ms; past this it is skipped (see `choose`). */
const REVEAL_LIMIT_MS = 1_500;

/**
 * Light and dark mode (docs/spec/06-brands-and-theming.md#app-theming), after the CRM's switch: a
 * small day sky with a sun among clouds that slides across to a moon among stars, and the new
 * theme spreading out in a circle from the switch (the View Transition API). With reduced motion
 * on, or without that API, the theme just changes. "Match my device" shows once a theme is picked,
 * to go back to following Windows.
 */
export function ThemeSwitch({
  theme,
  onTheme,
  labelledBy,
}: {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  labelledBy: string;
}) {
  const { t } = useTranslation();
  const [deviceDark, setDeviceDark] = useState(deviceIsDark);
  const following = theme === "system";
  const dark = theme === "dark" || (following && deviceDark);

  // While following the device, follow it live too.
  useEffect(() => {
    if (!following || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setDeviceDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [following]);

  const choose = (next: Theme, from: HTMLElement) => {
    const nextDark = next === "dark" || (next === "system" && deviceIsDark());
    // Inside the transition the page must already show the new theme, so it is set here as well
    // as by the settings hook's effect (which runs after React has rendered).
    const update = () => {
      applyTheme(next);
      flushSync(() => onTheme(next));
    };
    const root = document.documentElement;
    const transitions = document as ViewTransitionDocument;
    if (nextDark === dark || reducedMotion() || !transitions.startViewTransition) {
      update();
      return;
    }
    const rect = from.getBoundingClientRect();
    root.style.setProperty(
      "--theme-reveal-origin",
      `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2}px`,
    );
    root.dataset.themeReveal = "";
    const transition = transitions.startViewTransition(update);
    // The animation only moves while the window draws; if it's hidden part-way (say, minimised),
    // the reveal is dropped rather than left frozen over the page.
    const timer = window.setTimeout(() => transition.skipTransition?.(), REVEAL_LIMIT_MS);
    void transition.finished.finally(() => {
      window.clearTimeout(timer);
      delete root.dataset.themeReveal;
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={dark}
        aria-labelledby={labelledBy}
        onClick={(event) =>
          choose(
            dark ? "light" : "dark",
            event.currentTarget.querySelector<HTMLElement>(".sky-switch") ?? event.currentTarget,
          )
        }
        className="flex items-center gap-2.5 rounded-full py-1 pr-1 pl-3 text-sm text-body hover:bg-panel"
      >
        <span>{dark ? t("settings.appearance.dark") : t("settings.appearance.light")}</span>
        <SkySwitch dark={dark} />
      </button>
      {following ? (
        <span className="text-xs text-secondary">{t("settings.appearance.following")}</span>
      ) : (
        <button
          type="button"
          className="text-xs font-semibold text-link hover:underline"
          onClick={(event) => choose("system", event.currentTarget)}
        >
          {t("settings.appearance.system")}
        </button>
      )}
    </div>
  );
}

/** A four-pointed sparkle centred on (x, y). */
function sparkle(x: number, y: number, r: number): string {
  const w = r * 0.28;
  return `M${x} ${y - r}L${x + w} ${y - w}L${x + r} ${y}L${x + w} ${y + w}L${x} ${y + r}L${x - w} ${y + w}L${x - r} ${y}L${x - w} ${y - w}Z`;
}

const CLOUD = (
  <svg viewBox="0 0 60 30" aria-hidden="true">
    <circle cx="11" cy="21" r="9" />
    <circle cx="23" cy="13" r="10" />
    <circle cx="36" cy="16" r="9" />
    <circle cx="48" cy="21" r="8" />
    <rect x="11" y="20" width="38" height="10" />
  </svg>
);

/** The picture: day sky and sun, or night sky and moon. The button around it carries the state. */
function SkySwitch({ dark }: { dark: boolean }) {
  return (
    <span className="sky-switch" data-dark={dark ? "" : undefined} aria-hidden="true">
      <span className="sky-switch-sky">
        <span className="sky-switch-stars">
          <svg viewBox="0 0 40 26">
            <path d={sparkle(6, 7, 2.6)} />
            <path d={sparkle(17, 15, 2)} />
            <path d={sparkle(9, 20, 1.5)} />
            <path d={sparkle(28, 6, 1.8)} />
            <path d={sparkle(24, 21, 1.2)} />
            <circle cx="14" cy="4" r="0.7" />
            <circle cx="31" cy="14" r="0.7" />
            <circle cx="3" cy="14" r="0.6" />
          </svg>
        </span>
        <span className="sky-switch-cloud sky-switch-cloud-back">{CLOUD}</span>
        <span className="sky-switch-cloud sky-switch-cloud-front">{CLOUD}</span>
      </span>
      <span className="sky-switch-orb" />
    </span>
  );
}
