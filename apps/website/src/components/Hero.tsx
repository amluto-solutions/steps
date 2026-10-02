import { ArrowRight, Camera, Sparkle, Translate } from "@phosphor-icons/react";
import {
  AnimatePresence,
  motion,
  useInView,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import logoColour from "../assets/logo/logo-horizontal-colour.svg";
import logoWhite from "../assets/logo/logo-horizontal-white.svg";
import stepsMark from "../assets/logo/steps-mark.svg";
import { SHOWCASE } from "../showcase";
import { Aurora, DownloadButton, Shot, SupportButton } from "./shared";

/** The steps in the showcase guide. */
const STEPS_IN_GUIDE = 4;

export function Nav() {
  // How far down the page the reader is, as a line under the bar (follows the scroll, no timer).
  const { scrollYProgress } = useScroll();
  return (
    <header className="sticky top-0 z-10 border-b border-line/60 bg-page/80 backdrop-blur-md">
      <motion.div
        aria-hidden="true"
        style={{ scaleX: scrollYProgress }}
        className="absolute inset-x-0 -bottom-px h-0.5 origin-left bg-[linear-gradient(90deg,var(--brand-blue),var(--brand-cyan))]"
      />
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 md:gap-8 md:px-8"
      >
        <a href="/" className="flex shrink-0 items-center gap-2" aria-label="Steps home">
          <img src={stepsMark} alt="" width={28} height={28} className="size-7" />
          <span className="font-display text-xl font-semibold tracking-tight">Steps</span>
          <span className="hidden items-center gap-1 text-xs text-muted sm:flex">
            by
            <picture>
              <source srcSet={logoWhite} media="(prefers-color-scheme: dark)" />
              <img src={logoColour} alt="Amluto" width={66} height={14} className="h-3 w-auto" />
            </picture>
          </span>
        </a>
        {/* In the page's order, so following the links never jumps back up (02/10/2026). */}
        <ul className="hidden items-center gap-7 text-sm text-muted md:flex">
          <li>
            <a className="hover:text-ink" href="/#how">
              How it works
            </a>
          </li>
          <li>
            <a className="hover:text-ink" href="/#features">
              Features
            </a>
          </li>
          <li>
            <a className="hover:text-ink" href="/#exports">
              Exports
            </a>
          </li>
          <li>
            <a className="hover:text-ink" href="/#new">
              New in 1.0
            </a>
          </li>
          <li>
            <a className="hover:text-ink" href="/help/">
              Help
            </a>
          </li>
          <li>
            <a className="hover:text-ink" href="/it/">
              For IT
            </a>
          </li>
        </ul>
        <span className="flex-1" />
        <span className="flex items-center gap-2">
          <SupportButton />
          <DownloadButton />
        </span>
      </nav>
    </header>
  );
}

/**
 * Steps arriving as the recording runs, rising from the recording bar: what the page is about,
 * shown rather than said. Each run of the guide is in the next language, worded as Steps words it
 * (showcase.ts), with the language named above it. Only while the hero is in view; under reduced
 * motion, three English steps sit still. An illustration (hidden from screen readers): the
 * screenshot's alt text says what's there. Not on a phone, where the steps' words wouldn't fit
 * beside the screenshot.
 */
function StepFeed() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  // How far through the guide (1 to 5: the last is a beat with every step shown), and which run.
  const [feed, setFeed] = useState({ count: 1, run: 0 });
  useEffect(() => {
    if (reduce || !inView) return undefined;
    // One more step every 1.7 s; after the last, a beat, then the guide again in the next language.
    const timer = window.setInterval(
      () =>
        setFeed(({ count, run }) =>
          count > STEPS_IN_GUIDE ? { count: 1, run: run + 1 } : { count: count + 1, run },
        ),
      1700,
    );
    return () => window.clearInterval(timer);
  }, [reduce, inView]);
  const language = SHOWCASE[reduce ? 0 : feed.run % SHOWCASE.length] ?? SHOWCASE[0];
  if (!language) return null;
  const recorded = reduce ? 3 : Math.min(feed.count, STEPS_IN_GUIDE);
  const shown = language.steps.casual
    .slice(0, recorded)
    .map((text, index) => ({ text, n: index + 1 }))
    .slice(-3);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none absolute bottom-12 -left-8 z-[1] hidden w-[min(330px,62%)] flex-col gap-1.5 sm:flex"
    >
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={language.code}
          layout
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
          className="mb-0.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-line bg-surface/92 px-2.5 py-1 text-[11px] font-semibold text-accent shadow-[0_10px_24px_-16px_var(--shadow)] backdrop-blur-md"
        >
          <Translate size={13} weight="bold" />
          {language.name}
        </motion.span>
        {shown.map((step) => (
          <motion.div
            key={`${language.code}-${step.n}`}
            layout
            initial={{ opacity: 0, y: 18, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -14, scale: 0.94 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            lang={language.code}
            className="flex items-center gap-2.5 rounded-xl border border-line bg-surface/92 px-2.5 py-2 shadow-[0_18px_40px_-20px_var(--shadow)] backdrop-blur-md"
          >
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-[11px] font-bold text-accent-ink">
              {step.n}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{step.text}</span>
            <Camera size={15} weight="duotone" className="shrink-0 text-accent" />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

const rise = (delay: number) => ({
  initial: { opacity: 0, y: 24 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.8, delay, ease: [0.16, 1, 0.3, 1] as const },
});

/**
 * The first screen: what it does in one line, the download, and the app itself. The window tilts
 * a little with the pointer and the recording bar slides in over it, to show a recording under way.
 */
export function Hero() {
  const reduce = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-5, 5]), { stiffness: 120, damping: 20 });
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [4, -4]), { stiffness: 120, damping: 20 });
  const track = (event: PointerEvent<HTMLDivElement>) => {
    if (reduce) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set((event.clientX - box.left) / box.width - 0.5);
    y.set((event.clientY - box.top) / box.height - 0.5);
  };
  const still = () => {
    x.set(0);
    y.set(0);
  };

  return (
    // The light runs the full width; the content keeps the page's column.
    <div className="relative isolate overflow-hidden">
      <Aurora />
      <section
        id="top"
        className="relative mx-auto grid min-h-[calc(100dvh-4rem)] max-w-7xl grid-cols-1 items-center gap-12 px-4 pt-12 pb-20 md:px-8 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:pt-16"
      >
        <div className="flex flex-col items-start gap-7">
          <motion.a
            {...(reduce ? {} : rise(0))}
            href="#new"
            className="group inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 py-1 pr-3 pl-1 text-sm font-semibold backdrop-blur-md transition-colors hover:border-accent"
          >
            <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2.5 py-0.5 text-xs text-accent-ink">
              <Sparkle size={12} weight="fill" aria-hidden="true" />
              New
            </span>
            Steps 1.0, in 38 languages
            <ArrowRight
              size={14}
              weight="bold"
              aria-hidden="true"
              className="text-accent transition-transform group-hover:translate-x-0.5"
            />
          </motion.a>
          <motion.h1
            {...(reduce ? {} : rise(0.06))}
            className="font-display text-5xl leading-[1.05] font-semibold tracking-tight md:text-6xl"
          >
            Do it once.
            <br />
            <span className="text-accent">Get the guide.</span>
          </motion.h1>
          <motion.p
            {...(reduce ? {} : rise(0.12))}
            className="max-w-[34ch] text-lg leading-relaxed text-muted"
          >
            Steps turns each click into a step with a screenshot, worded in your language and ready
            to tidy, brand and share.
          </motion.p>
          <motion.div {...(reduce ? {} : rise(0.24))} className="flex flex-wrap items-center gap-3">
            <DownloadButton size="lg" />
            <a
              href="#exports"
              className="group inline-flex h-12 items-center gap-2 rounded-full border border-line px-6 text-base font-semibold whitespace-nowrap transition-colors hover:border-accent hover:text-accent"
            >
              Try the live demo
              <ArrowRight
                size={18}
                weight="bold"
                aria-hidden="true"
                className="transition-transform group-hover:translate-x-1"
              />
            </a>
          </motion.div>
        </div>

        <div
          className="hero-light relative -mx-2 [perspective:1600px] sm:mx-0 lg:w-[124%]"
          onPointerMove={track}
          onPointerLeave={still}
        >
          <motion.div
            style={reduce ? {} : { rotateX, rotateY }}
            initial={reduce ? false : { opacity: 0, y: 40, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 1, delay: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="shot"
          >
            <Shot
              name="editor"
              eager
              width={2880}
              height={1800}
              alt="The Steps editor: a guide's steps down the left, and the first step's screenshot with its click highlighted and the drawing tools above it."
            />
          </motion.div>
          <motion.div
            initial={reduce ? false : { opacity: 0, x: -40 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ type: "spring", stiffness: 90, damping: 18, delay: 0.9 }}
            className="absolute -bottom-6 left-2 w-[62%] max-w-[420px] drop-shadow-2xl sm:-left-6"
          >
            <Shot
              name="recorder-bar"
              eager
              width={1018}
              height={160}
              alt="The recording bar: Recording, 14 steps, Keys recorded, with Capture now, Pause and Stop."
            />
          </motion.div>
          <StepFeed />
        </div>
      </section>
    </div>
  );
}
