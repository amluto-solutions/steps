import { Check, Coffee, Copy, DownloadSimple } from "@phosphor-icons/react";
import { motion, useReducedMotion } from "motion/react";
import { useState, type PointerEvent, type ReactNode } from "react";

/** Slow light in the brand's colours behind a section (the section must be `relative isolate`). */
export function Aurora() {
  return (
    <div className="aurora" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

/** Moves a `.spotlight` card's light to the pointer, straight on the element: no re-render. */
export function spotlightAt(event: PointerEvent<HTMLElement>) {
  const box = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
  event.currentTarget.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
}

/** The screenshots, found by name: `library` gives library-light.webp and library-dark.webp. */
const shots = import.meta.glob<string>("../assets/shots/*.webp", {
  eager: true,
  import: "default",
});
const shot = (name: string, theme: "light" | "dark") =>
  shots[`../assets/shots/${name}-${theme}.webp`] ?? "";

/** A screenshot of the app in the visitor's own light or dark theme, as the app would show it. */
export function Shot({
  name,
  alt,
  width,
  height,
  className = "",
  eager = false,
}: {
  name: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  eager?: boolean;
}) {
  return (
    <picture>
      <source srcSet={shot(name, "dark")} media="(prefers-color-scheme: dark)" />
      <img
        src={shot(name, "light")}
        alt={alt}
        width={width}
        height={height}
        loading={eager ? "eager" : "lazy"}
        decoding="async"
        className={`block h-auto w-full ${className}`}
      />
    </picture>
  );
}

/**
 * Part of a 2880 x 1800 screenshot, given as percentages of it: a tile shows only the part of the
 * screen it talks about, at a size that can be read.
 */
export function ShotCrop({
  name,
  alt,
  area,
  className = "",
}: {
  name: string;
  alt: string;
  area: { x: number; y: number; w: number; h: number };
  className?: string;
}) {
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ aspectRatio: `${area.w * 2880} / ${area.h * 1800}` }}
    >
      <picture>
        <source srcSet={shot(name, "dark")} media="(prefers-color-scheme: dark)" />
        <img
          src={shot(name, "light")}
          alt={alt}
          width={2880}
          height={1800}
          loading="lazy"
          decoding="async"
          className="absolute h-auto max-w-none"
          style={{
            width: `${10000 / area.w}%`,
            left: `${(-area.x * 100) / area.w}%`,
            top: `${(-area.y * 100) / area.h}%`,
          }}
        />
      </picture>
    </div>
  );
}

/**
 * The one download action, labelled the same everywhere on the page. It goes to the download
 * section, where the version and checksum are shown before anything is downloaded.
 */
/**
 * Support for Steps, on Buy Me a Coffee: it goes to Amluto Solutions Ltd (02/10/2026). Plain
 * links, as the site loads nothing from another site (its widget script would).
 */
export const SUPPORT_URL = "https://buymeacoffee.com/amluto";

/** Beside Download in the menu, as Handy's "donate" is: the words from a small phone up. */
export function SupportButton() {
  return (
    <a
      href={SUPPORT_URL}
      aria-label="Support Steps on Buy Me a Coffee"
      className="inline-flex h-10 items-center gap-2 rounded-full border border-line px-3 text-sm font-semibold whitespace-nowrap transition-transform duration-200 ease-out hover:-translate-y-0.5 hover:border-accent active:scale-[0.98] sm:px-4"
    >
      <Coffee size={17} weight="bold" className="text-accent" aria-hidden="true" />
      <span className="hidden min-[400px]:inline">Support</span>
    </a>
  );
}

export function DownloadButton({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <a
      href="/#download"
      className={`inline-flex items-center gap-2 rounded-full bg-accent font-semibold whitespace-nowrap text-accent-ink transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-10px_var(--accent)] active:translate-y-0 active:scale-[0.98] ${size === "lg" ? "h-12 px-6 text-base" : "h-10 px-4 text-sm"}`}
    >
      <DownloadSimple size={size === "lg" ? 20 : 17} weight="bold" aria-hidden="true" />
      Download
    </a>
  );
}

/** Brings a block up into place as it scrolls into view, so each section arrives in order. */
export function Reveal({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className={className}
      initial={reduce ? false : { opacity: 0, y: 28 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25 }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/** A code block as the app exports one, with a Copy that works. */
export function CodeBlock({
  language,
  code,
  className = "mx-7 mb-7",
  wrap = false,
}: {
  language: string;
  code: string;
  className?: string;
  /** Long lines wrap instead of scrolling sideways (the Copy still copies them as one). */
  wrap?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={`overflow-hidden rounded-xl border border-line bg-[#0b1626] text-[#dbe7f5] ${className}`}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2 text-xs">
        <span className="font-semibold tracking-wide text-[#8fb3d9]">{language}</span>
        <button
          type="button"
          aria-label={`Copy the ${language}`}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-semibold text-[#48cdeb] hover:bg-white/10"
        >
          {copied ? (
            <Check size={14} weight="bold" aria-hidden="true" />
          ) : (
            <Copy size={14} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre
        className={`overflow-x-auto px-4 py-4 font-mono text-[13px] leading-relaxed ${wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : ""}`}
        // Focusable so a keyboard can scroll a long line sideways (WCAG 2.1.1).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region
        tabIndex={0}
      >
        <code>{code}</code>
      </pre>
    </div>
  );
}
