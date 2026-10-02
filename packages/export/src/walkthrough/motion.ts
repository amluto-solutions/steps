/**
 * Every timing and easing in the walkthrough, in one place (docs/spec/05-export.md#motion), so the
 * feel can be tuned without touching anything else. They become CSS custom properties.
 */
export const MOTION = {
  /** The screenshot crossfade. */
  fade: "320ms",
  /** The camera easing from the wider view into a smart-zoom crop. */
  cameraDelay: "120ms",
  camera: "650ms",
  cameraEase: "cubic-bezier(0.45, 0, 0.2, 1)",
  /** The cursor gliding from the last click to this one. */
  glide: "450ms",
  glideEase: "cubic-bezier(0.22, 1, 0.36, 1)",
  /** The press: the cursor dips, then the ripple expands and fades. */
  pressDelay: "420ms",
  press: "180ms",
  ripple: "650ms",
  /** The highlight traced on, then arrows, boxes and labels after it. */
  drawDelay: "520ms",
  draw: "300ms",
  marksDelay: "820ms",
  marks: "220ms",
  /** The step card rising in with a slight overshoot. */
  card: "340ms",
  cardEase: "cubic-bezier(0.34, 1.4, 0.64, 1)",
} as const;

export const motionProperties = () =>
  Object.entries(MOTION)
    .map(
      ([name, value]) =>
        `--wt-${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value};`,
    )
    .join("");
