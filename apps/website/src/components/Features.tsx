import {
  ArrowRight,
  Buildings,
  EyeSlash,
  FolderSimpleUser,
  Keyboard,
  Palette,
  TerminalWindow,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";

import { useReleaseState } from "../release";
import { CodeBlock, Reveal, ShotCrop, spotlightAt } from "./shared";

/** Each tile's own light, in the brand's colours from a different corner, so no two look alike. */
const TINTS = {
  topLeft: "bg-[radial-gradient(120%_90%_at_0%_0%,var(--accent-soft),transparent_55%)]",
  topRight: "bg-[radial-gradient(110%_100%_at_100%_0%,var(--aurora-b),transparent_60%)]",
  bottomRight: "bg-[radial-gradient(90%_80%_at_100%_100%,var(--accent-soft),transparent_70%)]",
  bottomLeft: "bg-[radial-gradient(100%_90%_at_0%_100%,var(--aurora-a),transparent_65%)]",
  band: "bg-[linear-gradient(160deg,var(--accent-soft),transparent_60%)]",
  none: "",
} as const;

function Tile({
  icon,
  title,
  children,
  className = "",
  tint = "none",
  visual,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  className?: string;
  tint?: keyof typeof TINTS;
  visual: ReactNode;
}) {
  return (
    <Reveal className={className}>
      <div
        onPointerMove={spotlightAt}
        className={`spotlight flex h-full flex-col overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface ${TINTS[tint]}`}
      >
        <div className="flex flex-col gap-3 p-7">
          <span className="brand-chip" aria-hidden="true">
            {icon}
          </span>
          <h3 className="mt-2 font-display text-2xl font-semibold tracking-tight">{title}</h3>
          <p className="max-w-[52ch] leading-relaxed text-muted">{children}</p>
        </div>
        <div className="mt-auto">{visual}</div>
      </div>
    </Reveal>
  );
}

/** A picture in a tile: part of the real screen, framed at the tile's bottom edge. */
function TileShot(props: Parameters<typeof ShotCrop>[0]) {
  return (
    <div className="mx-7 overflow-hidden rounded-t-xl border border-b-0 border-line">
      <ShotCrop {...props} />
    </div>
  );
}

/** The silent install, with the current MSI's real name once the release has loaded. */
function InstallCommand() {
  const state = useReleaseState();
  const msi = state.kind === "ready" ? state.release.msi.name : "amluto-steps-x64.msi";
  return (
    <CodeBlock language="Command Prompt" code={`msiexec /i ${msi} /quiet DISABLEKEYSTROKES=1`} />
  );
}

export function Features() {
  return (
    <section
      id="features"
      aria-labelledby="features-title"
      className="mx-auto max-w-7xl px-4 py-24 md:px-8 md:py-32"
    >
      <Reveal>
        <h2
          id="features-title"
          className="max-w-[20ch] font-display text-4xl leading-[1.1] font-semibold tracking-tight md:text-5xl"
        >
          Blurring, brands, code blocks, shared libraries and IT controls.
        </h2>
      </Reveal>
      <div className="mt-14 grid grid-cols-1 gap-5 lg:grid-cols-6">
        <Tile
          className="lg:col-span-4"
          tint="topRight"
          icon={<EyeSlash size={24} weight="duotone" />}
          title="Personal details, blurred"
          visual={
            <TileShot
              name="export-review"
              area={{ x: 16, y: 10, w: 68, h: 36 }}
              alt="The check before exporting: each screenshot as it will look, and a checklist of anything still to look at."
            />
          }
        >
          Emails, phone numbers, postcodes, card numbers, and names or IDs beside their labels are
          found in every screenshot, on your PC. Choose how hard it looks, from Light to Thorough,
          and blur them one at a time or all at once.
        </Tile>
        <Tile
          className="lg:col-span-2"
          tint="band"
          icon={<Palette size={24} weight="duotone" />}
          title="Your brand, or your client's"
          visual={
            <TileShot
              name="brand-editor"
              area={{ x: 16, y: 26, w: 34, h: 52 }}
              alt="The brand editor: the cover and page logos, and the main, accent and highlight colours."
            />
          }
        >
          Logos, colours and fonts on every export. Duplicate the Amluto brand to start your own,
          and keep one for each client.
        </Tile>
        <Tile
          className="lg:col-span-3"
          tint="bottomLeft"
          icon={<TerminalWindow size={24} weight="duotone" />}
          title="Commands become code blocks"
          visual={
            <CodeBlock
              language="PowerShell"
              code="Add-MailboxPermission -Identity sales@contoso.co.uk -User anna@contoso.co.uk -AccessRights FullAccess"
            />
          }
        >
          Record a task in PowerShell or Windows Terminal and each command lands in a block with its
          own Copy. Anything after -Password or -Token is masked.
        </Tile>
        <Tile
          className="lg:col-span-3"
          tint="bottomRight"
          icon={<Keyboard size={24} weight="duotone" />}
          title="Typing stays private"
          visual={
            <TileShot
              name="start-dialog"
              area={{ x: 32.2, y: 18, w: 35.6, h: 31 }}
              alt="Start a recording: Record what's typed and Include command output, both unticked."
            />
          }
        >
          What you type is only recorded with the box ticked, and the box is in front of you every
          time you start. Password fields never are, and typed values can be hidden from any step.
        </Tile>
        <Tile
          className="lg:col-span-2"
          tint="topLeft"
          icon={<Buildings size={24} weight="duotone" />}
          title="MSI and Group Policy"
          visual={<InstallCommand />}
        >
          Roll it out silently with the MSI from Intune, Configuration Manager or a script. The ADMX
          templates set libraries, excluded apps, blur words, brands and the language for everyone,
          lock settings, and switch off typing or update checks.{" "}
          <a
            href="/it/"
            className="inline-flex items-center gap-1 font-semibold whitespace-nowrap text-accent hover:underline"
          >
            Read the IT guide
            <ArrowRight size={14} weight="bold" aria-hidden="true" />
          </a>
        </Tile>
        <Tile
          className="lg:col-span-4"
          tint="topRight"
          icon={<FolderSimpleUser size={24} weight="duotone" />}
          title="Shared libraries in OneDrive or SharePoint"
          visual={
            <TileShot
              name="library"
              area={{ x: 0, y: 0, w: 72, h: 36 }}
              alt="The library: guides as cards, tags down the left, and New recording at the top."
            />
          }
        >
          Point everyone at the same synced folder and they all see the same guides. Search every
          step, tag guides, and get a nudge when one is due a review.
        </Tile>
      </div>
    </section>
  );
}
