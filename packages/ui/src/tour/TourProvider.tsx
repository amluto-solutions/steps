import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { Icon } from "../components/icons";
import { confetti } from "./confetti";
import { placeCard, type Placement, type Rect } from "./placement";
import { TOUR_STEPS, type TourPlace, type TourStatus, type TourStep } from "./steps";
import { readPillHidden, readTour, setPillHidden, subscribePill, writeTour } from "./store";

/**
 * The product tour (docs/spec/07-settings-and-policy.md#product-tour), ported from the CRM's with
 * the same rules. It floats over the main window: everything is dimmed except the control being
 * explained, which stays usable, and a card beside it says what it is. It moves between screens
 * itself, saves where it has got to on this PC, and shrinks to a "Tour" pill in the bottom-right
 * corner when someone presses Esc or goes to another screen.
 *
 * Only in windows at least 1024px wide. In anything narrower it waits, untouched.
 */

type View = "none" | "welcome" | "step" | "confirm" | "waiting" | "ended" | "finish";

interface State {
  status: TourStatus | null;
  /** -1: the welcome card. */
  index: number;
  view: View;
  /** Which way the tour was going, so a step skipped for a missing target skips the same way. */
  dir: 1 | -1;
  /** The screen this card belongs on. Going elsewhere pauses the tour. */
  pinned: string;
  lastPlace: string;
}

export interface TourContextValue {
  status: TourStatus | null;
  /** "n of N", while the tour is on or paused; null otherwise. */
  progress: string | null;
  /** "Show the tutorial": from the welcome card, wherever the person is. */
  start: () => void;
  /** "Continue the tour" and the pill. */
  resume: () => void;
  /** "Show the tutorial" switched off. */
  turnOff: () => void;
}

const TourContext = createContext<TourContextValue>({
  status: null,
  progress: null,
  start: () => undefined,
  resume: () => undefined,
  turnOff: () => undefined,
});

export const useTour = (): TourContextValue => useContext(TourContext);

const MISSING_TARGET_MS = 2500;
/** A card that isn't a step (the tour ended) is centred when its target isn't on this screen. */
const MISSING_ANCHOR_MS = 300;
const MIN_WIDTH = 1024;
const SETTINGS_BUTTON = '[data-tour="settings"]';
/** The dimmed window around the lit-up control: the brand navy, as behind the app's dialogs. */
const DIM = "color-mix(in srgb, var(--amluto-brand-navy) 55%, transparent)";

const subscribeWidth = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const wideEnough = () => window.innerWidth >= MIN_WIDTH;

/** The first element matching `selector` that's actually on screen. */
function findTarget(selector: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && element.getClientRects().length > 0) return element;
  }
  return null;
}

function toRect(element: HTMLElement): Rect {
  const rect = element.getBoundingClientRect();
  // A target taller than the window (a long guide list) is lit only where it's visible.
  const top = Math.max(rect.top, 0);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  return { left: rect.left, top, width: rect.width, height: Math.max(bottom - top, 0) };
}

const sameRect = (a: Rect | null, b: Rect | null) =>
  !a || !b
    ? a === b
    : Math.abs(a.left - b.left) < 0.5 &&
      Math.abs(a.top - b.top) < 0.5 &&
      Math.abs(a.width - b.width) < 0.5 &&
      Math.abs(a.height - b.height) < 0.5;

function initialState(steps: readonly TourStep[], place: string): State {
  const { status, step } = readTour();
  const index = step ? steps.findIndex((each) => each.id === step) : -1;
  const view: View = status !== "active" ? "none" : index >= 0 ? "step" : "welcome";
  const pinned = view === "step" ? (steps[index]?.place ?? place) : place;
  return { status, index, view, dir: 1, pinned, lastPlace: place };
}

export function TourProvider({
  enabled,
  place,
  onGo,
  firstName,
  children,
}: {
  /** False while something else must come first (the first-run welcome). */
  enabled: boolean;
  /** The screen showing now, e.g. "guides" or "settings:general". */
  place: string;
  /** Shows a screen the tour needs. */
  onGo: (place: TourPlace) => void;
  firstName: string | null;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const steps = TOUR_STEPS;
  const wide = useSyncExternalStore(subscribeWidth, wideEnough);
  const pillHidden = useSyncExternalStore(subscribePill, readPillHidden);
  const [state, setState] = useState<State>(() => initialState(steps, place));

  if (state.lastPlace !== place) {
    // Wandering off: a screen that isn't the one this card belongs on pauses the tour. Adjusted
    // during render rather than in an effect.
    const next: State = { ...state, lastPlace: place };
    const live = state.status === "active" && state.view !== "none" && state.view !== "ended";
    if (live && place !== state.pinned) {
      next.status = "paused";
      next.view = "none";
      // Someone who opened the Export menu and chose a format has done the step.
      if (state.view === "waiting") next.index = Math.min(state.index + 1, steps.length - 1);
    }
    setState(next);
  }

  const current = state.index >= 0 ? (steps[state.index] ?? null) : null;

  // Picking up mid-tour when the app opens somewhere else: go to the step's screen.
  const arrivedRef = useRef(false);
  useEffect(() => {
    if (arrivedRef.current || !enabled || !wide) return;
    arrivedRef.current = true;
    if (state.view === "step" && current && state.pinned !== place) onGo(current.place);
  }, [enabled, wide, state.view, state.pinned, current, place, onGo]);

  const goTo = useCallback(
    (index: number, dir: 1 | -1) => {
      if (index >= steps.length) {
        setState((s) => ({ ...s, status: "finished", view: "finish", index: steps.length }));
        confetti();
        return;
      }
      if (index < 0) {
        setState((s) => ({ ...s, index: -1, view: "welcome", dir, pinned: place }));
        return;
      }
      const step = steps[index];
      if (!step) return;
      setState((s) => ({ ...s, status: "active", index, view: "step", dir, pinned: step.place }));
      if (step.place !== place) onGo(step.place);
    },
    [steps, place, onGo],
  );

  const pause = useCallback(() => setState((s) => ({ ...s, status: "paused", view: "none" })), []);

  const resume = useCallback(() => {
    setPillHidden(false);
    if (state.index < 0)
      setState((s) => ({ ...s, status: "active", view: "welcome", pinned: place }));
    else goTo(Math.min(state.index, steps.length - 1), 1);
  }, [state.index, steps.length, place, goTo]);

  const start = useCallback(() => {
    setPillHidden(false);
    setState((s) => ({
      ...s,
      status: "active",
      index: -1,
      view: "welcome",
      dir: 1,
      pinned: place,
    }));
  }, [place]);

  const endTour = useCallback(
    () => setState((s) => ({ ...s, status: "off", view: "ended", pinned: place })),
    [place],
  );

  const turnOff = useCallback(() => setState((s) => ({ ...s, status: "off", view: "none" })), []);

  // Saved as it changes, so the tour picks up where it was when the app next opens.
  const savedStep =
    state.status === "active" || state.status === "paused" ? (current?.id ?? null) : null;
  const savedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!state.status) return;
    const key = `${state.status}:${savedStep}`;
    if (key === savedRef.current) return;
    savedRef.current = key;
    writeTour({ status: state.status, step: savedStep });
  }, [state.status, savedStep]);

  // --- The lit-up target and where the card sits beside it ---
  // Keyed by the card it belongs to, so a new step never shows the last one's highlight. A null
  // rect means the card has nothing to point at here and is centred.
  const [measured, setMeasured] = useState<{ key: string; rect: Rect | null } | null>(null);
  const [cardSize, setCardSize] = useState({ width: 320, height: 200 });
  const cardRef = useRef<HTMLDivElement>(null);
  const targetSelector =
    state.view === "step" || state.view === "confirm" || state.view === "waiting"
      ? (current?.target ?? null)
      : state.view === "ended"
        ? SETTINGS_BUTTON
        : null;
  const visible = enabled && wide && state.view !== "none" && state.view !== "waiting";
  const onPinnedScreen = state.pinned === place;
  const rectKey = `${state.view === "ended" ? "ended" : state.index}:${targetSelector}`;

  useEffect(() => {
    if (!visible || !targetSelector || !onPinnedScreen) return;
    let frame = 0;
    const started = performance.now();
    let last: Rect | null = null;
    let found = false;
    const tick = () => {
      const element = findTarget(targetSelector);
      const waited = performance.now() - started;
      if (element) {
        const next = toRect(element);
        if (!found || !sameRect(last, next)) {
          found = true;
          last = next;
          setMeasured({ key: rectKey, rect: next });
        }
      } else if (state.view === "step" && !found && waited > MISSING_TARGET_MS) {
        // Not on this screen for this person (no guides yet): the card shows in the middle
        // rather than the tour skipping on by itself, which looked like it had vanished (F008).
        found = true;
        setMeasured({ key: rectKey, rect: null });
      } else if (state.view !== "step" && !found && waited > MISSING_ANCHOR_MS) {
        found = true;
        setMeasured({ key: rectKey, rect: null });
      }
      const card = cardRef.current;
      if (card) {
        const size = { width: card.offsetWidth, height: card.offsetHeight };
        setCardSize((prev) =>
          prev.width === size.width && prev.height === size.height ? prev : size,
        );
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible, targetSelector, onPinnedScreen, rectKey, state.view, state.index, state.dir, goTo]);

  const anchored = targetSelector !== null && onPinnedScreen && measured?.key === rectKey;
  const litRect = anchored ? measured.rect : null;
  // A card that points at something waits, hidden, until that something is found.
  const shown = visible && (!targetSelector || anchored);

  // "Try it" steps move on once the person has used the control and closed what it opened.
  useEffect(() => {
    if (!visible || state.view !== "step" || !current?.tryIt) return;
    const selector = current.target;
    const onClick = (event: MouseEvent) => {
      const element = findTarget(selector);
      if (element && event.target instanceof Node && element.contains(event.target))
        setState((s) => ({ ...s, view: "waiting" }));
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [visible, state.view, current]);

  useEffect(() => {
    if (state.view !== "waiting" || !current) return;
    const selector = current.target;
    const started = performance.now();
    let opened = false;
    const timer = window.setInterval(() => {
      const open = findTarget(selector)?.getAttribute("aria-expanded") === "true";
      if (open) opened = true;
      if (!open && (opened || performance.now() - started > 800)) {
        window.clearInterval(timer);
        goTo(state.index + 1, 1);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [state.view, state.index, current, goTo]);

  // Keyboard: Esc shrinks to the pill (or backs out of the End question), arrows step through.
  // Left alone while a dialog is open or someone is typing.
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const active = document.activeElement;
      const typing =
        active instanceof HTMLElement &&
        (active.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName));
      if (typing || document.querySelector('[aria-modal="true"]')) return;
      const inCard = Boolean(active && cardRef.current?.contains(active));
      if (!inCard && active !== document.body) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (state.view === "confirm") setState((s) => ({ ...s, view: "step" }));
        else if (state.view === "step" || state.view === "welcome") pause();
      } else if (state.view === "step" && event.key === "ArrowRight") {
        event.preventDefault();
        goTo(state.index + 1, 1);
      } else if (state.view === "step" && event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(state.index - 1, -1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [visible, state.view, state.index, goTo, pause]);

  // Focus the card's main button as each card appears, so Enter carries on.
  useLayoutEffect(() => {
    if (!shown) return;
    cardRef.current
      ?.querySelector<HTMLElement>("[data-tour-primary]")
      ?.focus({ preventScroll: true });
  }, [shown, state.view, state.index]);

  const progress = t("tour.progress", {
    current: Math.min(Math.max(state.index + 1, 1), steps.length),
    total: steps.length,
  });
  const ongoing = state.status === "active" || state.status === "paused";
  const pillShowing = enabled && wide && state.status === "paused" && !pillHidden;

  const contextValue = useMemo(
    () => ({
      status: state.status,
      progress: ongoing ? progress : null,
      start,
      resume,
      turnOff,
    }),
    [state.status, ongoing, progress, start, resume, turnOff],
  );

  const placement: Placement | null = litRect
    ? placeCard(litRect, cardSize, { width: window.innerWidth, height: window.innerHeight })
    : null;

  return (
    <TourContext.Provider value={contextValue}>
      {children}
      {shown &&
        createPortal(
          <>
            {litRect ? (
              <div
                aria-hidden="true"
                data-testid="tour-spotlight"
                className="pointer-events-none fixed z-[700] rounded-lg"
                style={{
                  left: litRect.left - 6,
                  top: litRect.top - 6,
                  width: litRect.width + 12,
                  height: litRect.height + 12,
                  boxShadow: `0 0 0 3px var(--color-cyan), 0 0 0 9999px ${DIM}`,
                }}
              />
            ) : (
              <div
                aria-hidden="true"
                className="pointer-events-none fixed inset-0 z-[700]"
                style={{ background: DIM }}
              />
            )}
            <div
              ref={cardRef}
              role="dialog"
              aria-labelledby="tour-card-title"
              data-testid="tour-card"
              className={`fixed z-[701] flex flex-col gap-2 rounded-xl bg-background p-4 text-sm text-body shadow-[0_12px_32px_var(--amluto-shadow)] ${placement ? "w-[320px]" : "w-[360px]"}`}
              style={
                placement
                  ? { left: placement.left, top: placement.top }
                  : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" }
              }
            >
              {placement && placement.side !== "inside" && <Arrow placement={placement} />}
              <TourCardBody
                view={state.view}
                step={current}
                canTry={placement !== null}
                index={state.index}
                total={steps.length}
                progress={progress}
                firstName={firstName}
                onStart={() => goTo(0, 1)}
                onNotNow={endTour}
                onNext={() => goTo(state.index + 1, 1)}
                onBack={() => goTo(state.index - 1, -1)}
                onAskEnd={() => setState((s) => ({ ...s, view: "confirm" }))}
                onKeepGoing={() => setState((s) => ({ ...s, view: "step" }))}
                onEnd={endTour}
                onClose={() => setState((s) => ({ ...s, view: "none" }))}
              />
            </div>
          </>,
          document.body,
        )}
      {pillShowing &&
        createPortal(
          <div
            className="fixed right-3 bottom-3 z-[650] flex items-center rounded-full bg-brand-navy text-sm text-white shadow-[0_4px_14px_var(--amluto-shadow)]"
            data-testid="tour-pill"
          >
            <button
              type="button"
              onClick={resume}
              aria-label={t("tour.pill.continue", { progress })}
              className="flex items-center gap-1.5 rounded-l-full py-1.5 pr-2 pl-3 font-semibold hover:bg-white/10"
            >
              <Icon name="info" size={16} />
              {t("tour.pill.label")}
              <span className="font-normal text-white/70">{progress}</span>
            </button>
            <button
              type="button"
              onClick={() => setPillHidden(true)}
              aria-label={t("tour.pill.hide")}
              title={t("tour.pill.hideTitle")}
              className="rounded-r-full py-1.5 pr-2.5 pl-1 text-white/70 hover:bg-white/10 hover:text-white"
            >
              <Icon name="close" size={14} />
            </button>
          </div>,
          document.body,
        )}
    </TourContext.Provider>
  );
}

function Arrow({ placement }: { placement: Placement }) {
  const style =
    placement.side === "below"
      ? { top: -6, left: placement.arrow - 6 }
      : placement.side === "above"
        ? { bottom: -6, left: placement.arrow - 6 }
        : placement.side === "right"
          ? { left: -6, top: placement.arrow - 6 }
          : { right: -6, top: placement.arrow - 6 };
  return (
    <span aria-hidden="true" className="absolute size-3 rotate-45 bg-background" style={style} />
  );
}

function TourCardBody({
  view,
  step,
  canTry,
  index,
  total,
  progress,
  firstName,
  onStart,
  onNotNow,
  onNext,
  onBack,
  onAskEnd,
  onKeepGoing,
  onEnd,
  onClose,
}: {
  view: View;
  step: TourStep | null;
  /** The step's control is on this screen to try (not when the card is centred without it). */
  canTry: boolean;
  index: number;
  total: number;
  progress: string;
  firstName: string | null;
  onStart: () => void;
  onNotNow: () => void;
  onNext: () => void;
  onBack: () => void;
  onAskEnd: () => void;
  onKeepGoing: () => void;
  onEnd: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const primary = "btn btn-primary h-8 px-3";
  const secondary = "btn h-8 px-3";

  if (view === "welcome") {
    return (
      <>
        <Eyebrow>{t("tour.welcome.eyebrow")}</Eyebrow>
        <Title>
          {firstName ? t("tour.welcome.title", { name: firstName }) : t("tour.welcome.titleNoName")}
        </Title>
        <p className="text-secondary">{t("tour.welcome.body")}</p>
        <Footer>
          <button type="button" onClick={onNotNow} className={secondary}>
            {t("tour.welcome.notNow")}
          </button>
          <span className="flex-1" />
          <button type="button" onClick={onStart} className={primary} data-tour-primary>
            {t("tour.welcome.start")}
          </button>
        </Footer>
      </>
    );
  }

  if (view === "ended") {
    return (
      <>
        <Eyebrow>{t("tour.ended.eyebrow")}</Eyebrow>
        <Title>{t("tour.ended.title")}</Title>
        <p className="text-secondary">{t("tour.ended.body")}</p>
        <Footer>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={primary} data-tour-primary>
            {t("tour.ended.gotIt")}
          </button>
        </Footer>
      </>
    );
  }

  if (view === "finish") {
    return (
      <>
        <Eyebrow>{t("tour.done.eyebrow")}</Eyebrow>
        <Title>{t("tour.done.title")}</Title>
        <p className="text-secondary">{t("tour.done.body")}</p>
        <Footer>
          <span className="flex-1" />
          <button type="button" onClick={onClose} className={primary} data-tour-primary>
            {t("tour.done.finish")}
          </button>
        </Footer>
      </>
    );
  }

  if (!step) return null;

  if (view === "confirm") {
    return (
      <>
        <Eyebrow>{t("tour.step", { progress })}</Eyebrow>
        <Title>{t("tour.confirm.title")}</Title>
        <p className="text-secondary">{t("tour.confirm.body")}</p>
        <Footer>
          <span className="flex-1" />
          <button type="button" onClick={onKeepGoing} className={secondary} data-tour-primary>
            {t("tour.confirm.keepGoing")}
          </button>
          <button type="button" onClick={onEnd} className={`${secondary} btn-danger`}>
            {t("tour.confirm.end")}
          </button>
        </Footer>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{t("tour.step", { progress })}</Eyebrow>
        <button
          type="button"
          onClick={onAskEnd}
          aria-label={t("tour.end")}
          title={t("tour.end")}
          className="grid size-7 shrink-0 place-items-center rounded-full border border-panel text-secondary hover:border-secondary hover:text-navy"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <Title>{t(`tour.steps.${step.id}.title`)}</Title>
      <p className="text-secondary">{t(`tour.steps.${step.id}.body`)}</p>
      {step.tryIt && canTry && (
        <p className="rounded-md bg-cyan/15 px-2 py-1 text-xs text-navy">
          {t(`tour.steps.${step.id}.tryIt`)}
        </p>
      )}
      <div className="h-1 overflow-hidden rounded-full bg-panel" aria-hidden="true">
        <div
          className="h-full rounded-full bg-blue"
          style={{ width: `${((index + 1) / total) * 100}%` }}
        />
      </div>
      <Footer>
        <button type="button" onClick={onBack} className={secondary}>
          {t("tour.back")}
        </button>
        <span className="flex-1" />
        <button type="button" onClick={onNext} className={`${secondary} btn-quiet`}>
          {t("tour.skip")}
        </button>
        <button type="button" onClick={onNext} className={primary} data-tour-primary>
          {index + 1 === total ? t("tour.finish") : t("tour.next")}
        </button>
      </Footer>
    </>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-[11px] font-semibold tracking-wider text-link uppercase">{children}</p>;
}

function Title({ children }: { children: ReactNode }) {
  return (
    <h2 id="tour-card-title" className="font-heading text-lg font-semibold text-balance text-navy">
      {children}
    </h2>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-1 flex items-center gap-2">{children}</div>;
}
