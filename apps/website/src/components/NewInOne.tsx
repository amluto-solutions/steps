import {
  CheckSquareOffset,
  EyeSlash,
  Files,
  FilePdf,
  ShieldCheck,
  Target,
  Translate,
  type Icon,
} from "@phosphor-icons/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useId, useState } from "react";

import { SHOWCASE, TONES, type ShowcaseTone } from "../showcase";
import { Reveal } from "./shared";

/** The rest of 1.0's highlights, beside the languages (CHANGELOG.md has them all). */
const highlights: { icon: Icon; title: string; body: string }[] = [
  {
    icon: Translate,
    title: "Guides in several languages",
    body: "Add a language to a guide and its recorded steps are worded in it for you. Write the title and notes in each, beside the original.",
  },
  {
    icon: FilePdf,
    title: "Export in any language",
    body: "PDF and Word make a file for each language. A web page carries them all, and opens in the reader’s own.",
  },
  {
    icon: Files,
    title: "Select, merge and copy",
    body: "Pick several guides to move, copy, merge, export or bin together, from any library to any other.",
  },
  {
    icon: EyeSlash,
    title: "Blur suggestions, your way",
    body: "Light, Standard or Thorough. Standard also finds your own account names; Thorough adds file names and paths.",
  },
  {
    icon: Target,
    title: "Better step names",
    body: "Clicks in File Explorer, Notepad and Settings are named after what you clicked. Where an app names nothing, the words on screen do.",
  },
  {
    icon: ShieldCheck,
    title: "Tighter on privacy",
    body: "Typing into something Steps can’t name stays out unless you turn it on, and the export review warns about anything that looks like a password.",
  },
];

/**
 * One guide, worded live in the language and tone picked: the same four steps the hero's feed
 * plays, with the app's own wording. The steps are announced politely when they change, so a
 * screen reader hears the new wording without moving focus.
 */
function GuideSwitcher() {
  const reduce = useReducedMotion();
  const base = useId();
  const [code, setCode] = useState("de");
  const [tone, setTone] = useState<ShowcaseTone>("casual");
  const language = SHOWCASE.find((item) => item.code === code) ?? SHOWCASE[0];
  if (!language) return null;

  return (
    <div className="ring-panel overflow-hidden rounded-[var(--radius-panel)]">
      <div className="flex flex-col gap-5 border-b border-line p-6 md:p-8">
        <fieldset>
          <legend className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
            Language
          </legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {SHOWCASE.map((item) => (
              <label
                key={item.code}
                lang={item.code}
                className="cursor-pointer rounded-full border border-line px-3.5 py-1.5 text-sm font-medium transition-colors hover:border-accent has-[:checked]:border-accent has-[:checked]:bg-accent has-[:checked]:text-accent-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent"
              >
                <input
                  type="radio"
                  name={`${base}-language`}
                  value={item.code}
                  checked={item.code === code}
                  onChange={() => setCode(item.code)}
                  className="sr-only"
                />
                {item.name}
              </label>
            ))}
            <span className="px-1 py-1.5 text-sm text-muted">and 29 more</span>
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-xs font-semibold tracking-[0.14em] text-muted uppercase">
            Tone
          </legend>
          <div className="mt-3 inline-flex rounded-full border border-line bg-page p-1">
            {TONES.map((item) => {
              const active = item.id === tone;
              return (
                <label
                  key={item.id}
                  className={`relative cursor-pointer rounded-full px-4 py-1.5 text-sm font-semibold whitespace-nowrap transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent ${active ? "text-accent-ink" : "text-muted hover:text-ink"}`}
                >
                  {active && (
                    <motion.span
                      layoutId={`${base}-tone`}
                      aria-hidden="true"
                      className="absolute inset-0 rounded-full bg-accent"
                      transition={
                        reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }
                      }
                    />
                  )}
                  <input
                    type="radio"
                    name={`${base}-tone`}
                    value={item.id}
                    checked={active}
                    onChange={() => setTone(item.id)}
                    className="sr-only"
                  />
                  <span className="relative">{item.label}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      <div className="bg-page/60 p-6 md:p-8">
        <p className="flex items-center gap-2 font-display text-lg font-semibold">
          <CheckSquareOffset
            size={20}
            weight="duotone"
            className="text-accent"
            aria-hidden="true"
          />
          Add a supplier
        </p>
        {/* The old list fades out in the same grid cell as the new one fades in, so the panel
            never grows by both (with popLayout, the fading list kept its space and pushed the new
            steps down, 02/10/2026). */}
        <div aria-live="polite" className="mt-4 grid">
          <AnimatePresence initial={false}>
            <motion.ol
              key={`${language.code}-${tone}`}
              lang={language.code}
              initial={reduce ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.25 }}
              className="col-start-1 row-start-1 flex flex-col gap-2"
            >
              {language.steps[tone].map((text, index) => (
                <motion.li
                  key={index}
                  initial={reduce ? false : { opacity: 0, x: 14 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.35,
                    delay: reduce ? 0 : index * 0.05,
                    ease: [0.16, 1, 0.3, 1],
                  }}
                  className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2.5"
                >
                  <span
                    aria-hidden="true"
                    className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-xs font-bold text-accent-ink"
                  >
                    {index + 1}
                  </span>
                  <span className="min-w-0 flex-1 text-[15px] leading-snug">{text}</span>
                </motion.li>
              ))}
            </motion.ol>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/** What 1.0 brings: the languages, shown working, then the rest in tiles. */
export function NewInOne() {
  const reduce = useReducedMotion();
  return (
    <section
      id="new"
      aria-labelledby="new-title"
      className="relative isolate overflow-hidden bg-[linear-gradient(195deg,var(--band-from),var(--band-to)_70%)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-56 -left-40 -z-10 size-[44rem] rounded-full bg-[radial-gradient(closest-side,var(--aurora-a),transparent)]"
      />
      <div className="mx-auto max-w-7xl px-4 py-24 md:px-8 md:py-32">
        <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <Reveal>
            <h2
              id="new-title"
              className="max-w-[15ch] font-display text-4xl leading-[1.1] font-semibold tracking-tight text-balance md:text-5xl"
            >
              Steps 1.0 speaks <span className="text-accent">38 languages.</span>
            </h2>
            <p className="mt-6 max-w-[44ch] text-lg leading-relaxed text-muted">
              The app, its setup and every step it writes follow the language Windows uses, or the
              one you choose. Pick a tone too: Casual, Plain language or Formal.
            </p>
            <p className="mt-4 max-w-[44ch] text-sm leading-relaxed text-muted">
              Translated automatically. Spotted a mistake? Tell us at{" "}
              <a
                className="font-semibold text-accent hover:underline"
                href="mailto:steps@amluto.com"
              >
                steps@amluto.com
              </a>
              .
            </p>
          </Reveal>
          <Reveal delay={0.1}>
            <GuideSwitcher />
          </Reveal>
        </div>

        {/*
         * The rest of 1.0 as a list, not more tiles: the features above are tiles already, and
         * these are short notes on what changed.
         */}
        <h3 className="mt-20 font-display text-2xl font-semibold tracking-tight">
          And in the rest of the app
        </h3>
        <ul className="mt-8 grid grid-cols-1 gap-x-10 sm:grid-cols-2 lg:grid-cols-3">
          {highlights.map((item, index) => (
            <motion.li
              key={item.title}
              initial={reduce ? false : { opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.6, delay: (index % 3) * 0.08, ease: [0.16, 1, 0.3, 1] }}
              className="flex gap-4 border-t border-line py-6"
            >
              <item.icon
                size={24}
                weight="duotone"
                className="mt-0.5 shrink-0 text-accent"
                aria-hidden="true"
              />
              <div>
                <h4 className="font-display text-lg font-semibold">{item.title}</h4>
                <p className="mt-1.5 leading-relaxed text-muted">{item.body}</p>
              </div>
            </motion.li>
          ))}
        </ul>
      </div>
    </section>
  );
}
