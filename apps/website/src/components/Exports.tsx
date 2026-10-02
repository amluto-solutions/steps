import {
  ArrowSquareOut,
  ClipboardText,
  FileDoc,
  FilePdf,
  Globe,
  Package,
  type Icon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useRef, useState, type KeyboardEvent } from "react";

import { Reveal, Shot } from "./shared";

interface Format {
  id: string;
  label: string;
  icon: Icon;
  headline: string;
  body: string;
  points: string[];
}

const formats: Format[] = [
  {
    id: "web",
    label: "Web page",
    icon: Globe,
    headline: "A guide that plays itself",
    body: "One HTML file that walks through each step: the pointer moves to the next click and typing appears as it was typed. It opens in any browser, with no internet needed, and in the reader’s own language when the guide has it.",
    points: [
      "Play, pause and speed",
      "Works with a keyboard and a screen reader",
      "Prints as a plain list",
    ],
  },
  {
    id: "pdf",
    label: "PDF",
    icon: FilePdf,
    headline: "Ready to print or attach",
    body: "Your brand's cover, fonts and colours, with each step's screenshot and wording. One step to a page, steps that follow on, or two to a page, with a contents page and a document-control page (version, owner, review date) if you want them. More languages makes one file for each.",
    points: [
      "Tagged for screen readers",
      "A4 or US Letter",
      "Coloured tip and warning boxes",
      "Fonts for every language",
    ],
  },
  {
    id: "word",
    label: "Word",
    icon: FileDoc,
    headline: "Edit it further in Word",
    body: "A .docx with real headings and a numbered list of steps, so it drops into your own documents and reads properly with a screen reader. The same contents and document-control pages are there if you want them.",
    points: [
      "Alt text on every screenshot",
      "Your logo on the cover",
      "Headings for the navigation pane",
    ],
  },
  {
    id: "copy",
    label: "Copy and paste",
    icon: ClipboardText,
    headline: "Straight into an email",
    body: "Copies the whole guide with its screenshots, ready to paste into Outlook, Teams, a SharePoint page or Confluence.",
    points: ["Screenshots stay in place", "Steps stay numbered", "No file to send"],
  },
  {
    id: "amlsteps",
    label: "Steps file",
    icon: Package,
    headline: "Hand it to a colleague",
    body: "The whole guide in one file, for someone else to open and edit in their own Steps. Unblurred originals stay out unless you choose to include them.",
    points: [
      "Steps, notes and blur kept",
      "Unsafe or damaged files refused on import",
      "Import from the library",
    ],
  },
];

/**
 * The exports as tabs. The web page tab frames a real export (public/demo, made by the app's own
 * exporter), so visitors can click through one; the others show the check before exporting.
 */
export function Exports() {
  const reduce = useReducedMotion();
  const base = useId();
  const [selected, setSelected] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const current = formats[selected] ?? formats[0];

  // Arrow keys move between tabs, as tabs do (WAI-ARIA tabs pattern).
  const onKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (selected + step + formats.length) % formats.length;
    setSelected(next);
    tabs.current[next]?.focus();
  };

  return (
    <section id="exports" aria-labelledby="exports-title" className="bg-surface-2/60">
      <div className="mx-auto max-w-7xl px-4 py-24 md:px-8 md:py-32">
        <Reveal>
          <h2
            id="exports-title"
            className="font-display text-4xl leading-[1.1] font-semibold tracking-tight md:text-5xl"
          >
            One guide, five ways to share it.
          </h2>
        </Reveal>

        <div
          role="tablist"
          aria-label="Export formats"
          className="mt-10 flex gap-2 overflow-x-auto pb-2 [scrollbar-width:none]"
        >
          {formats.map((format, index) => {
            const active = index === selected;
            return (
              <button
                key={format.id}
                ref={(element) => {
                  tabs.current[index] = element;
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${format.id}`}
                aria-selected={active}
                aria-controls={`${base}-panel`}
                tabIndex={active ? 0 : -1}
                onKeyDown={onKey}
                onClick={() => setSelected(index)}
                className={`relative inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-5 text-sm font-semibold whitespace-nowrap transition-colors ${active ? "text-accent-ink" : "text-muted hover:text-ink"}`}
              >
                {active && (
                  <motion.span
                    layoutId={`${base}-pill`}
                    className="absolute inset-0 rounded-full bg-accent"
                    transition={
                      reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }
                    }
                  />
                )}
                <format.icon size={18} weight="bold" aria-hidden="true" className="relative" />
                <span className="relative">{format.label}</span>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`${base}-panel`}
          aria-labelledby={`${base}-tab-${current?.id}`}
          className="mt-8 grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={current?.id}
              initial={reduce ? false : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
              transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              <h3 className="font-display text-3xl font-semibold tracking-tight">
                {current?.headline}
              </h3>
              <p className="mt-4 text-lg leading-relaxed text-muted">{current?.body}</p>
              <ul className="mt-6 flex flex-wrap gap-2">
                {current?.points.map((point) => (
                  <li key={point} className="rounded-full border border-line px-3 py-1.5 text-sm">
                    {point}
                  </li>
                ))}
              </ul>
              {current?.id === "web" && (
                <>
                  {/* A phone gets the demo on its own page: framed in this one it was too cramped. */}
                  <a
                    href={__DEMO_URL__}
                    target="_blank"
                    rel="noopener"
                    className="mt-7 inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 font-semibold text-accent-ink active:scale-[0.98] md:hidden"
                  >
                    Open the live demo
                    <ArrowSquareOut size={18} weight="bold" aria-hidden="true" />
                  </a>
                  <a
                    href={__DEMO_URL__}
                    target="_blank"
                    rel="noopener"
                    className="mt-7 hidden items-center gap-2 font-semibold text-accent hover:underline md:inline-flex"
                  >
                    Open the demo on its own
                    <ArrowSquareOut size={17} weight="bold" aria-hidden="true" />
                  </a>
                </>
              )}
            </motion.div>
          </AnimatePresence>

          {current?.id === "web" ? (
            <div className="shot hidden md:block">
              <iframe
                src={__DEMO_URL__}
                title="A real interactive web page made by Steps: how a guide is made"
                loading="lazy"
                allowFullScreen
                className="block h-[560px] w-full bg-surface md:h-[640px]"
              />
            </div>
          ) : (
            <div className="shot">
              <Shot
                name="export-review"
                width={2880}
                height={1800}
                alt="The check before exporting: every screenshot as it will be exported, a checklist, and the brand, page size and layout."
              />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
