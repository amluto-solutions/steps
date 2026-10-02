import { ArrowRight, Lifebuoy } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { C, DocPage, DocSection, Note, Table } from "../components/doc";

/**
 * steps.amluto.com/help/: how to use Steps, for the people recording guides. Every claim here
 * matches the app as released and its specs (docs/spec/02-capture.md, 04-editor.md, 05-export.md,
 * 03-data-and-sharing.md, 07-settings-and-policy.md, 09-accessibility.md); change them together.
 */

const SECTIONS = [
  { id: "install", title: "Install" },
  { id: "record", title: "Record a guide" },
  { id: "edit", title: "Edit a guide" },
  { id: "private", title: "Keep private things out" },
  { id: "export", title: "Export and share" },
  { id: "team", title: "Share a library with your team" },
  { id: "keys", title: "Keyboard shortcuts" },
  { id: "accessibility", title: "Accessibility" },
  { id: "help", title: "Getting help" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const section = SECTIONS.find((found) => found.id === id) ?? { id, title: "" };
  return <DocSection section={section}>{children}</DocSection>;
}

/** Numbered steps, for the tasks people follow along with. */
function Steps({ children }: { children: ReactNode }) {
  return <ol className="flex list-decimal flex-col gap-2 pl-6 marker:text-accent">{children}</ol>;
}

function Header() {
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="hero-light pointer-events-none absolute inset-0" aria-hidden="true" />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto flex max-w-7xl flex-col gap-6 px-4 py-16 md:px-8 md:py-24"
      >
        <p className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-accent uppercase">
          <Lifebuoy size={18} weight="duotone" aria-hidden="true" />
          Help
        </p>
        <h1 className="max-w-[18ch] font-display text-4xl leading-[1.05] font-semibold tracking-tight md:text-6xl">
          Using Steps
        </h1>
        <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
          Record a task once, tidy it up, and send it as a PDF, a Word document or a web page. This
          page covers each part, the keyboard shortcuts, and the accessibility features.
        </p>
      </motion.div>
    </section>
  );
}

function Guide() {
  return (
    <>
      <Section id="install">
        <p>
          Download Steps from the <a href="/#download">download section</a>. The setup installs it
          for you alone, needs no admin rights, and keeps it up to date. The portable program runs
          without installing, and updates itself once you switch on Update automatically in Settings
          &gt; About. The Microsoft Store version is waiting for its listing.
        </p>
        <p>
          Windows may say it doesn&rsquo;t recognise the app yet: choose <strong>More info</strong>,
          then <strong>Run anyway</strong>. The first time Steps opens, it asks your name (it goes
          on the guides you make) and where to keep them.
        </p>
        <p>
          Setting it up for a whole team? The <a href="/it/">IT guide</a> covers the MSI, Group
          Policy and Intune.
        </p>
      </Section>

      <Section id="record">
        <Steps>
          <li>
            Choose <strong>New recording</strong>, or press <C>Ctrl+Alt+Shift+N</C> from any app.
          </li>
          <li>
            Give it a title and choose what to record. Tick{" "}
            <strong>Record what&rsquo;s typed</strong> only if the guide needs what you type;
            passwords are never kept.
          </li>
          <li>
            Do the task as normal. Each click becomes a step with a screenshot, and the recording
            bar counts them.
          </li>
          <li>
            Press <strong>Stop</strong> on the bar, or <C>Ctrl+Alt+Shift+X</C>. The guide opens for
            you to check, then <strong>Save</strong> puts it in your library.
          </li>
        </Steps>
        <p>
          <strong>Pause</strong> (<C>Ctrl+Alt+Shift+R</C>) stops recording while you do something
          that shouldn&rsquo;t be in the guide. <strong>Capture now</strong> (
          <C>Ctrl+Alt+Shift+S</C>) takes a screenshot step without a click. The bar&rsquo;s{" "}
          <strong>More</strong> menu has <strong>Show a keyboard shortcut</strong>,{" "}
          <strong>Never record this app</strong>, <strong>Move the bar</strong> and{" "}
          <strong>Start again</strong>.
        </p>
        <Note>
          The recording bar isn&rsquo;t in your screenshots: they show what&rsquo;s behind it. You
          can change that in Settings &gt; Recording.
        </Note>
      </Section>

      <Section id="edit">
        <p>
          The steps are down the left; the one you choose is on the right, with its wording and
          screenshot. Every change saves by itself, and <C>Ctrl+Z</C> undoes it.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Wording:</strong> click the step text to change it. <strong>Add a note</strong>{" "}
            puts more detail, a tip or a warning under a step.
          </li>
          <li>
            <strong>Screenshot:</strong> draw arrows, boxes and labels, blur parts of it, or crop
            it. Click or drag with a tool; each mark can be moved and resized after.
          </li>
          <li>
            <strong>Order:</strong> drag a step in the list, or use its menu to move it up or down
            or delete it.
          </li>
          <li>
            <strong>Tidy guide</strong> (in the guide&rsquo;s menu) suggests steps to merge or drop,
            such as double clicks.
          </li>
          <li>
            <strong>Before you start</strong> and <strong>You&rsquo;re done</strong> take an
            introduction and closing notes.
          </li>
        </ul>
      </Section>

      <Section id="private">
        <p>
          Steps keeps everything on your PC, or in library folders you choose. It sends nothing.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Suggested blurs:</strong> Steps reads the text in each screenshot and suggests
            blurring email addresses, UK phone numbers, postcodes, card numbers, National Insurance
            numbers and IBANs. <strong>Blur all</strong> accepts them for the whole guide.
            Suggestions can miss things, so look over the screenshots before you share.
          </li>
          <li>
            <strong>Find &amp; Blur</strong> (guide menu) finds a word in every screenshot and blurs
            it everywhere at once.
          </li>
          <li>
            <strong>Words to always blur</strong> go in Settings &gt; Privacy, for names or account
            numbers you never want to show.
          </li>
          <li>
            <strong>Never record this app</strong>, on the bar or in Settings &gt; Recording, keeps
            an app out of every recording.
          </li>
        </ul>
        <Note tone="warn">
          Blur hides text in what you export. In a shared library, people with access to the folder
          can still open the original screenshots, unless you choose{" "}
          <strong>Apply blur permanently</strong> in the guide&rsquo;s menu.
        </Note>
      </Section>

      <Section id="export">
        <p>
          <strong>Export</strong> checks the guide first (steps that might show personal details,
          screenshots without alt text of their own) and then makes:
        </p>
        <Table
          label="Export formats"
          minWidth="30rem"
          head={["Format", "Best for"]}
          rows={[
            ["PDF", "printing or sending as it is"],
            ["Word", "editing further; the most accessible"],
            ["Copy", "pasting into an email, Teams or SharePoint"],
            ["Web page", "a walkthrough that plays step by step in any browser"],
            ["Steps file", "sending the guide to another Steps user to edit"],
          ]}
        />
        <p>
          Brand profiles (Settings &gt; Brand profiles) set the logo, colours and fonts on exports.
        </p>
      </Section>

      <Section id="team">
        <p>
          Add a folder that OneDrive or SharePoint syncs in Settings &gt; Libraries, and everyone
          who adds the same folder sees the same guides.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>One editor at a time:</strong> when someone else has a guide open, you see who
            and read it as they work. <strong>Take over editing</strong> is there if they&rsquo;ve
            left it open.
          </li>
          <li>
            <strong>Nothing lost:</strong> if two people change the same step anyway, both versions
            are kept and the guide asks which to keep. Changes someone couldn&rsquo;t save are kept
            as a draft on the guide.
          </li>
          <li>
            <strong>Comments:</strong> <strong>Comments</strong> in the editor opens threads on a
            step or the whole guide, with replies and Resolve. Anyone can comment, even while
            someone else is editing. Comments are never exported.
          </li>
        </ul>
      </Section>

      <Section id="keys">
        <p>
          These work from any app. Change or turn off each one in Settings &gt; Keyboard shortcuts.
        </p>
        <Table
          label="Shortcuts that work from any app"
          minWidth="28rem"
          head={["Keys", "Does"]}
          rows={[
            [<C key="n">Ctrl+Alt+Shift+N</C>, "start a recording"],
            [<C key="r">Ctrl+Alt+Shift+R</C>, "pause or resume"],
            [<C key="x">Ctrl+Alt+Shift+X</C>, "stop"],
            [<C key="s">Ctrl+Alt+Shift+S</C>, "capture now: a screenshot step"],
            [<C key="k">Ctrl+Alt+Shift+K</C>, "show a keyboard shortcut as a step"],
          ]}
        />
        <p>In the editor:</p>
        <Table
          label="Shortcuts in the editor"
          minWidth="28rem"
          head={["Keys", "Does"]}
          rows={[
            [<C key="z">Ctrl+Z</C>, "undo"],
            [<C key="y">Ctrl+Y</C>, "redo"],
            [<C key="v">Ctrl+V</C>, "add a copied picture as a new step"],
            [<C key="d">Delete</C>, "delete the step chosen in the list"],
            [
              <C key="e">Enter</C>,
              "on the screenshot, with a drawing tool chosen: add that mark in the middle",
            ],
            [
              <C key="p">Page Up / Page Down</C>,
              "on the screenshot: choose the previous or next mark",
            ],
            [<C key="a">Arrow keys</C>, "move the chosen mark; with Shift, resize it"],
          ]}
        />
      </Section>

      <Section id="accessibility">
        <p>
          What Steps does for people who use a keyboard, zoom, a screen reader or other Windows
          settings. A full accessibility conformance report is being prepared.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-6">
          <li>
            <strong>Keyboard:</strong> everything works without a mouse, including drawing on
            screenshots, reordering steps and moving the recording bar (its More menu). Nothing
            needs dragging.
          </li>
          <li>
            <strong>Zoom:</strong> <C>Ctrl</C> with <C>+</C> or <C>&minus;</C> makes everything
            bigger or smaller, and <C>Ctrl+0</C> puts it back. Steps also follows Windows&rsquo;
            display scaling.
          </li>
          <li>
            <strong>Light and dark:</strong> Settings &gt; Appearance, or match Windows. Steps turns
            off its animations when Windows is set to show fewer.
          </li>
          <li>
            <strong>Screen readers:</strong> controls are labelled, and Steps says what changes: the
            step count while recording, search results, the mark chosen on a screenshot. We&rsquo;re
            testing with NVDA and Narrator.
          </li>
          <li>
            <strong>Accessible guides:</strong> Word and web-page exports have real headings and alt
            text on every screenshot, which you can edit per step. PDF exports aren&rsquo;t tagged
            for screen readers yet, so use Word for anything that must be accessible.
          </li>
        </ul>
        <p>
          Something getting in your way? Tell us at{" "}
          <a href="mailto:steps@amluto.com">steps@amluto.com</a>.
        </p>
      </Section>

      <Section id="help">
        <p>
          Email <a href="mailto:steps@amluto.com">steps@amluto.com</a>. In the app, Settings &gt;
          About &gt; <strong>Get help</strong> makes a support file with the logs, with names and
          folders taken out, and starts the email for you. You see what&rsquo;s in it first.
        </p>
      </Section>
    </>
  );
}

export function HelpGuide() {
  return (
    <DocPage
      header={<Header />}
      sections={SECTIONS}
      aside={
        <a
          href="/it/"
          className="mt-6 inline-flex items-center gap-1.5 px-3 text-sm font-semibold text-accent hover:underline"
        >
          IT guide
          <ArrowRight size={14} weight="bold" aria-hidden="true" />
        </a>
      }
    >
      <Guide />
    </DocPage>
  );
}
