import { Info, ListBullets, Warning } from "@phosphor-icons/react";
import { MotionConfig } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";

import { ReleaseContext, useRelease } from "../release";
import { Footer } from "./Download";
import { Nav } from "./Hero";

/** The parts of a long page of guidance: the IT guide (/it/) and the help page (/help/). */

export interface DocSectionInfo {
  id: string;
  title: string;
}

/** A value, file name, key or setting in running text. */
export function C({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] break-words">
      {children}
    </code>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "warn"; children: ReactNode }) {
  const Icon = tone === "warn" ? Warning : Info;
  return (
    <div className="flex gap-3 rounded-xl bg-accent-soft p-4 text-sm leading-relaxed">
      <Icon size={20} weight="duotone" className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** A reference table that scrolls sideways on its own on a phone, never the page. */
export function Table({
  label,
  head,
  rows,
  minWidth = "40rem",
}: {
  label: string;
  head: string[];
  rows: ReactNode[][];
  minWidth?: string;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      // Focusable so a keyboard can scroll it sideways (WCAG 2.1.1).
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrolling region
      tabIndex={0}
      className="overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <table className="w-full border-collapse text-left text-sm" style={{ minWidth }}>
        <thead className="bg-surface-2 text-xs tracking-wide text-muted uppercase">
          <tr>
            {head.map((cell) => (
              <th key={cell} scope="col" className="px-4 py-3 font-semibold">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, index) => (
            <tr key={index} className="align-top">
              {row.map((cell, column) => (
                <td
                  key={column}
                  className={`px-4 py-3 leading-relaxed ${column === 0 ? "font-medium whitespace-nowrap" : "text-muted"}`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocSection({
  section,
  children,
}: {
  section: DocSectionInfo;
  children: ReactNode;
}) {
  return (
    <section id={section.id} aria-labelledby={`${section.id}-title`} className="scroll-mt-24">
      <h2
        id={`${section.id}-title`}
        className="mb-5 font-display text-3xl leading-tight font-semibold tracking-tight"
      >
        {section.title}
      </h2>
      <div className="flex flex-col gap-5 leading-relaxed text-muted [&_strong]:text-ink">
        {children}
      </div>
    </section>
  );
}

/** Which section is being read, for the contents list: the last heading above a third of the way down. */
function useActiveSection(sections: readonly DocSectionInfo[]): string {
  const [active, setActive] = useState(sections[0]?.id ?? "");
  useEffect(() => {
    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { rootMargin: "-15% 0px -65% 0px" },
    );
    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [sections]);
  return active;
}

function Contents({ sections, active }: { sections: readonly DocSectionInfo[]; active: string }) {
  return (
    <ol className="flex flex-col gap-0.5 text-sm">
      {sections.map((section) => (
        <li key={section.id}>
          <a
            href={`#${section.id}`}
            aria-current={active === section.id ? "location" : undefined}
            className={`block rounded-lg border-l-2 px-3 py-1.5 transition-colors ${
              active === section.id
                ? "border-accent bg-accent-soft font-semibold text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            {section.title}
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * A guidance page: skip link, the site's nav, a header, the contents beside the text (a
 * collapsible list on a phone) and the footer.
 */
export function DocPage({
  header,
  sections,
  aside,
  children,
}: {
  header: ReactNode;
  sections: readonly DocSectionInfo[];
  /** Under the contents on a wide screen, e.g. a download link. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const release = useRelease();
  const active = useActiveSection(sections);
  return (
    <ReleaseContext.Provider value={release}>
      <MotionConfig reducedMotion="user">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-20 focus:rounded-full focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-ink"
        >
          Skip to the content
        </a>
        <Nav />
        <main
          id="main"
          className="overflow-x-clip [&_a:not([class])]:font-semibold [&_a:not([class])]:text-accent [&_a:not([class])]:hover:underline"
        >
          {header}
          <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 md:px-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16">
            <nav aria-label="On this page" className="lg:sticky lg:top-24 lg:self-start">
              <details className="group rounded-[var(--radius-panel)] border border-line bg-surface p-4 lg:hidden">
                <summary className="flex cursor-pointer items-center gap-2 font-semibold">
                  <ListBullets size={18} aria-hidden="true" />
                  On this page
                </summary>
                <div className="mt-3">
                  <Contents sections={sections} active={active} />
                </div>
              </details>
              <div className="hidden lg:block">
                <p className="mb-3 px-3 text-xs font-semibold tracking-wide text-muted uppercase">
                  On this page
                </p>
                <Contents sections={sections} active={active} />
                {aside}
              </div>
            </nav>
            <div className="max-w-3xl min-w-0">
              <div className="flex flex-col gap-20">{children}</div>
            </div>
          </div>
        </main>
        <Footer />
      </MotionConfig>
    </ReleaseContext.Provider>
  );
}
