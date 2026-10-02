import { isTourStatus, isTourStepId, type TourStatus, type TourStepId } from "./steps";

/**
 * Where the tour has got to, kept in this window's local storage like the other per-PC choices:
 * the CRM keeps it on the account, but Steps has no accounts. `status` null means the tour
 * was never offered here (a PC that had the app before the tour existed); only finishing the
 * first-run welcome starts it.
 */
export interface StoredTour {
  status: TourStatus | null;
  step: TourStepId | null;
}

const KEY = "amluto-steps-tour";
const PILL_HIDDEN = "amluto-steps-tour-pill-hidden";

export function readTour(): StoredTour {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? "null");
    if (raw && typeof raw === "object") {
      const { status, step } = raw as Record<string, unknown>;
      return {
        status: isTourStatus(status) ? status : null,
        step: isTourStepId(step) ? step : null,
      };
    }
  } catch {
    // Unreadable or blocked storage: as if the tour was never offered.
  }
  return { status: null, step: null };
}

export function writeTour(tour: StoredTour) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(tour));
  } catch {
    // Blocked storage: the tour carries on until the app closes, then isn't offered again.
  }
}

/** The first-run welcome is done: the tour greets the person when the guides appear. */
export const startTourAfterWelcome = () => writeTour({ status: "active", step: null });

const pillListeners = new Set<() => void>();

export function subscribePill(listener: () => void) {
  pillListeners.add(listener);
  return () => {
    pillListeners.delete(listener);
  };
}

/**
 * The Tour pill's ✕ hides it for good (F027: it came back at every start), until the person
 * continues the tour from Settings.
 */
export function readPillHidden(): boolean {
  try {
    return window.localStorage.getItem(PILL_HIDDEN) === "1";
  } catch {
    return false;
  }
}

export function setPillHidden(hidden: boolean) {
  try {
    if (hidden) window.localStorage.setItem(PILL_HIDDEN, "1");
    else window.localStorage.removeItem(PILL_HIDDEN);
  } catch {
    // Blocked storage: the pill comes back when the window reloads instead.
  }
  pillListeners.forEach((listener) => listener());
}
