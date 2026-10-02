import { ArrowsClockwise, IdentificationCard, ShieldCheck, WifiSlash } from "@phosphor-icons/react";
import { useInView } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Reveal, Shot } from "./shared";

const promises = [
  {
    icon: IdentificationCard,
    title: "No account",
    body: "Nothing to sign up for. Install it and record.",
  },
  {
    icon: WifiSlash,
    title: "Works offline",
    body: "Recording, editing and exporting need no connection.",
  },
  {
    icon: ShieldCheck,
    title: "Nothing sent to us",
    body: "Guides, screenshots and settings never leave your computer.",
  },
  {
    icon: ArrowsClockwise,
    title: "Signed updates",
    body: "It only goes online to ask for a new version, and checks its signature.",
  },
];

/**
 * The privacy promise, stated plainly, with the four facts behind it: a band of the brand's blue
 * with its own light, the promise on one side and the facts as tiles on the other.
 */
export function Offline() {
  return (
    <section
      aria-labelledby="offline-title"
      className="relative isolate overflow-hidden bg-[linear-gradient(165deg,var(--band-from),var(--band-to)_72%)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-48 right-[-12%] -z-10 size-[46rem] rounded-full bg-[radial-gradient(closest-side,var(--aurora-b),transparent)]"
      />
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 py-24 md:px-8 md:py-32 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <Reveal>
          <h2
            id="offline-title"
            className="max-w-[14ch] font-display text-4xl leading-[1.1] font-semibold tracking-tight md:text-6xl"
          >
            Your screenshots stay on <span className="text-accent">your PC.</span>
          </h2>
          <p className="mt-6 max-w-[44ch] text-lg leading-relaxed text-muted">
            Steps saves only where you tell it to: this PC, or a OneDrive or SharePoint folder your
            team already uses.
          </p>
        </Reveal>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {promises.map((item, index) => (
            <Reveal key={item.title} delay={index * 0.08}>
              <div className="h-full rounded-[var(--radius-panel)] border border-line bg-[var(--tile-glass)] p-6 backdrop-blur-md transition-[transform,border-color] duration-300 ease-out hover:-translate-y-1 hover:border-accent motion-reduce:transition-none motion-reduce:hover:translate-y-0">
                <span className="brand-chip">
                  <item.icon size={24} weight="duotone" aria-hidden="true" />
                </span>
                <h3 className="mt-5 font-display text-xl font-semibold">{item.title}</h3>
                <p className="mt-2 leading-relaxed text-muted">{item.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

interface Chapter {
  id: string;
  title: string;
  body: ReactNode;
  shot: string;
  alt: string;
}

const chapters: Chapter[] = [
  {
    id: "record",
    title: "Record",
    body: (
      <>
        Press New recording and do the task as you normally would. Each click becomes a step with a
        screenshot and plain wording, like &lsquo;Click &ldquo;Save&rdquo;&rsquo;.
      </>
    ),
    shot: "library",
    alt: "The Steps library: guides as cards with their first screenshot, tags down the left, and New recording at the top.",
  },
  {
    id: "tidy",
    title: "Tidy up",
    body: (
      <>
        Reword steps, add notes and coloured boxes, draw arrows and crop. Emails, phone numbers and
        names are found in the screenshots, and Blur all hides them in one go.
      </>
    ),
    shot: "editor",
    alt: "The editor, with the drawing tools, Blur all and Export along the top.",
  },
  {
    id: "share",
    title: "Share",
    body: (
      <>
        See every screenshot as it will look, pick a brand and a language, and export to PDF, Word
        or a web page. A checklist names anything still to check first.
      </>
    ),
    shot: "export-review",
    alt: "The check before exporting: every screenshot as it will be exported, with a checklist and the brand and page options.",
  },
];

/**
 * One chapter of the story; tells the pinned picture when it is the one being read: the chapter
 * across the middle of the window. The chapters touch, so one is there at a time (at a boundary,
 * the one just arrived), and the picture doesn't flip back and forth.
 */
function ChapterText({
  chapter,
  index,
  onActive,
}: {
  chapter: Chapter;
  index: number;
  onActive: (index: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A band 1% high across the middle: a line with no height never counts as crossed.
  const inView = useInView(ref, { margin: "-49% 0px -50% 0px" });
  useEffect(() => {
    if (inView) onActive(index);
  }, [inView, index, onActive]);
  return (
    <div
      ref={ref}
      id={`chapter-${chapter.id}`}
      className="flex scroll-mt-[30dvh] flex-col justify-center py-12 lg:min-h-[58dvh]"
    >
      <h3 className="flex items-center gap-4 font-display text-3xl font-semibold tracking-tight md:text-4xl">
        <span
          aria-hidden="true"
          className="grid size-11 shrink-0 place-items-center rounded-full bg-accent font-sans text-lg font-bold text-accent-ink"
        >
          {index + 1}
        </span>
        {chapter.title}
      </h3>
      <p className="mt-4 max-w-[46ch] text-lg leading-relaxed text-muted">{chapter.body}</p>
      {/* On narrow screens there is no pinned picture: each chapter carries its own. */}
      <div className="shot mt-8 lg:hidden">
        <Shot name={chapter.shot} width={2880} height={1800} alt={chapter.alt} />
      </div>
    </div>
  );
}

/**
 * How a guide is made, as a scroll story: the text scrolls, the app's screen stays pinned beside
 * it and changes to the one each chapter describes. The three screens are stacked and loaded
 * together, and the one being read fades in over the others: nothing is added, removed or resized
 * while scrolling, so the picture doesn't jump or flash empty (30/09/2026).
 */
export function HowItWorks() {
  const [active, setActive] = useState(0);
  return (
    <section id="how" aria-labelledby="how-title" className="bg-surface-2/60">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 py-24 md:px-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
        <div>
          <h2
            id="how-title"
            className="font-display text-4xl leading-[1.1] font-semibold tracking-tight md:text-5xl"
          >
            How a recording becomes a guide.
          </h2>
          {chapters.map((chapter, index) => (
            <ChapterText key={chapter.id} chapter={chapter} index={index} onActive={setActive} />
          ))}
        </div>
        <div className="hidden lg:block">
          <div className="sticky top-[calc(50dvh-min(28vw,380px)/2-2rem)]">
            <div className="shot grid shadow-[0_50px_140px_-50px_var(--glow)]">
              {chapters.map((chapter, index) => (
                <div
                  key={chapter.id}
                  aria-hidden={index !== active}
                  className={`[grid-area:1/1] transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none ${index === active ? "scale-100 opacity-100" : "scale-[0.98] opacity-0"}`}
                >
                  <Shot name={chapter.shot} width={2880} height={1800} alt={chapter.alt} />
                </div>
              ))}
            </div>
            {/* Where you are, and a way to jump to any part of the story. */}
            <ol className="mt-5 grid grid-cols-3 gap-3" aria-label="Where you are in the story">
              {chapters.map((chapter, index) => (
                <li key={chapter.id}>
                  <a
                    href={`#chapter-${chapter.id}`}
                    aria-current={index === active ? "step" : undefined}
                    className="group flex flex-col gap-2 text-sm font-semibold text-muted transition-colors hover:text-ink aria-[current=step]:text-ink"
                  >
                    <span
                      className={`h-1.5 rounded-full transition-colors duration-500 ${index <= active ? "bg-[linear-gradient(90deg,var(--brand-blue),var(--brand-cyan))]" : "bg-line group-hover:bg-muted"}`}
                    />
                    {chapter.title}
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}
