import type { SVGProps } from "react";

/** Stroke icons drawn inline (no icon font, nothing fetched), sized by `size`. */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const paths = {
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  clock: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM12 7v5l3 2",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  trash: "M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5",
  settings:
    "M4 7h9M17 7h3M4 17h3M11 17h9M13 7a2 2 0 1 0 4 0a2 2 0 1 0-4 0zM7 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0z",
  help: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM9.5 9.3a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.4M12 17h.01",
  search: "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0zM20 20l-4-4",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14",
  upload: "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14",
  back: "M15 18l-6-6 6-6",
  forward: "M9 18l6-6-6-6",
  chevronDown: "M6 9l6 6 6-6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  zoomIn: "M4 11a7 7 0 1 0 14 0a7 7 0 1 0-14 0zM20 20l-4-4M8 11h6M11 8v6",
  close: "M6 6l12 12M18 6L6 18",
  more: "M12 5h.01M12 12h.01M12 19h.01",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  camera: "M4 8h3l2-3h6l2 3h3v11H4zM8.5 13a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0z",
  pause: "M8 5v14M16 5v14",
  play: "M7 4.5v15l13-7.5z",
  stop: "M5 5h14v14H5z",
  restart: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v5h5",
  ban: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM5.6 5.6l12.8 12.8",
  keyboard: "M2.5 6h19v12h-19zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10",
  pointer: "M4 3l7.5 17 2.2-7.3L21 10.5z",
  arrow: "M5 19L19 5M10 5h9v9",
  box: "M4 5h16v14H4z",
  text: "M5 7V4h14v3M12 4v16M9 20h6",
  blur: "M3 6h18v12H3zM7 10h2M11 10h2M15 10h2M7 14h2M11 14h2M15 14h2",
  crop: "M6 2v14a2 2 0 0 0 2 2h14M2 6h14a2 2 0 0 1 2 2v14",
  image: "M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15.5 9.5h.01",
  copy: "M8 8h12v12H8zM4 16V4h12",
  split: "M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4",
  merge: "M8 4v6a4 4 0 0 0 4 4 4 4 0 0 1 4 4v2M16 4v6a4 4 0 0 1-4 4",
  up: "M12 19V5M6 11l6-6 6 6",
  down: "M12 5v14M6 13l6 6 6-6",
  note: "M5 6h14M5 12h14M5 18h9",
  bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z",
  italic: "M10 5h8M6 19h8M14 5l-4 14",
  bulletList: "M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01",
  numberList: "M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 13.5a1.5 1.5 0 1 1 2.6 1L3.5 18h3",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  folder:
    "M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z",
  people:
    "M6 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0zM14.7 9a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0zM3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6M15 14.5c2.6-.3 4.8 1 5.5 4",
  lock: "M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3",
  gear: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6zM12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1",
  droplet: "M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z",
  record: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0z",
  shield: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z",
  contrast: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM12 3v18",
  info: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0zM12 11v5M12 8h.01",
  file: "M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8zM14 3v5h5M8.5 13h7M8.5 16.5h5",
  tag: "M3 12V4h8l9 9-8 8zM7.5 7.5h.01",
  history: "M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v5h5M12 8v4l3 2",
  undo: "M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3",
  redo: "M15 14l5-5-5-5M20 9H10a6 6 0 0 0 0 12h3",
  warning: "M12 3l10 18H2zM12 10v5M12 18h.01",
  check: "M5 12.5l4.5 4.5L19 7",
  comment: "M4 5h16v11H10l-5 4v-4H4z",
} as const;

export type IconName = keyof typeof paths;

/** Decorative unless given an `aria-label`, when it becomes an image with that name. */
export function Icon({ name, size = 18, ...props }: IconProps & { name: IconName }) {
  const named = Boolean(props["aria-label"]);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={named ? undefined : true}
      role={named ? "img" : undefined}
      focusable="false"
      {...props}
    >
      <path d={paths[name]} />
    </svg>
  );
}
