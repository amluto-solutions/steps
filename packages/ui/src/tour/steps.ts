/**
 * The tour's steps, in order (docs/spec/07-settings-and-policy.md#product-tour). The words are in
 * `locales/en.json` under `tour.steps.<id>`.
 *
 * A step points at the first element on screen matching `target`. When nothing matches (no
 * guides yet, so no Export button) the step is skipped, the way the tour was going.
 */
export const TOUR_STEP_IDS = [
  "record",
  "guides",
  "search",
  "export",
  "import",
  "views",
  "bin",
  "settings",
] as const;
export type TourStepId = (typeof TOUR_STEP_IDS)[number];

/** The screens the tour shows on. Only the guides home for now; Settings shows the welcome. */
export type TourPlace = "guides";

export interface TourStep {
  id: TourStepId;
  place: TourPlace;
  target: string;
  /** Using the lit-up control moves the tour on, once whatever it opened is closed again. */
  tryIt?: boolean;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { id: "record", place: "guides", target: '[data-tour="record"]' },
  { id: "guides", place: "guides", target: '[data-tour="guides"]' },
  { id: "search", place: "guides", target: '[data-tour="search"]' },
  { id: "export", place: "guides", target: '[data-tour="export"]', tryIt: true },
  { id: "import", place: "guides", target: '[data-tour="import"]' },
  { id: "views", place: "guides", target: '[data-tour="views"]' },
  { id: "bin", place: "guides", target: '[data-tour="bin"]' },
  { id: "settings", place: "guides", target: '[data-tour="settings"]' },
];

export const TOUR_STATUSES = ["active", "paused", "finished", "off"] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];

export const isTourStepId = (value: unknown): value is TourStepId =>
  typeof value === "string" && (TOUR_STEP_IDS as readonly string[]).includes(value);
export const isTourStatus = (value: unknown): value is TourStatus =>
  typeof value === "string" && (TOUR_STATUSES as readonly string[]).includes(value);
