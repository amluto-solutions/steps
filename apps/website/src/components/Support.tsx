import { Buildings, Coffee, Heart } from "@phosphor-icons/react";

import { Reveal, SUPPORT_URL } from "./shared";

/**
 * Funding what comes next: Buy Me a Coffee for anyone, and sponsorship for a company, as Handy does
 * (handy.computer; 02/10/2026: "it's way too discrete ... we should plug it more"). Support
 * pays for future work, not for Steps staying free ("Money drives future work, not keeping existing
 * free"). It goes to Amluto Solutions Ltd, and the page says so.
 */
export function Support() {
  return (
    <section id="support" aria-labelledby="support-title" className="px-4 pb-24 md:px-8 md:pb-32">
      <Reveal className="ring-panel relative mx-auto max-w-5xl overflow-hidden rounded-[var(--radius-panel)]">
        {/* A glow from the button's side, so the panel reads as a call to act, not more reading. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-24 -right-24 size-96 rounded-full bg-accent opacity-15 blur-3xl"
        />
        <div className="relative grid grid-cols-1 items-center gap-10 px-6 py-8 sm:px-8 md:p-12 lg:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col gap-4">
            <span className="inline-flex w-fit items-center gap-2 rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent">
              <Heart size={15} weight="fill" aria-hidden="true" />
              Support Steps
            </span>
            <h2
              id="support-title"
              className="font-display text-4xl font-semibold tracking-tight text-balance"
            >
              Help build what&rsquo;s next
            </h2>
            <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
              Steps is free and open source, and stays that way. Support pays for the next releases:
              the features people ask for, more apps it can read, and quicker fixes. If Steps saves
              you or your team time, buy us a coffee.
            </p>
            <p className="text-sm text-muted">
              Steps is made by Amluto Solutions Ltd, a UK software company. Our client work pays the
              running costs; support goes to Amluto and pays for more time on Steps.
            </p>
          </div>
          <div className="flex flex-col items-stretch gap-3 sm:flex-row lg:flex-col">
            <a
              href={SUPPORT_URL}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full bg-accent px-6 text-base font-semibold whitespace-nowrap text-accent-ink transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_12px_32px_-10px_var(--accent)] active:translate-y-0 active:scale-[0.98]"
            >
              <Coffee size={20} weight="bold" aria-hidden="true" />
              Buy us a coffee
            </a>
            <a
              href="mailto:steps@amluto.com?subject=Sponsoring%20Steps"
              className="inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line px-6 text-base font-semibold whitespace-nowrap transition-transform hover:-translate-y-0.5 hover:border-accent active:scale-[0.98]"
            >
              <Buildings size={20} weight="bold" aria-hidden="true" />
              Sponsor as a company
            </a>
          </div>
        </div>
      </Reveal>
    </section>
  );
}
