import {
  Buildings,
  Check,
  Copy,
  DownloadSimple,
  Browsers,
  Browser,
  GithubLogo,
  GoogleChromeLogo,
  Star,
  Hourglass,
  Info,
  Lightning,
  LinuxLogo,
  Storefront,
  TerminalWindow,
  WindowsLogo,
} from "@phosphor-icons/react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import logoColour from "../assets/logo/logo-horizontal-colour.svg";
import logoWhite from "../assets/logo/logo-horizontal-white.svg";
import {
  releasePage,
  REPOSITORY_URL,
  useGitHub,
  useReleaseState,
  type ReleaseFile,
} from "../release";
import { Reveal, SUPPORT_URL } from "./shared";

/**
 * The listings Microsoft, Google and Mozilla review before they're live. Each says "Waiting for
 * its listing" until it's set here: winget once Amluto.Steps is merged into microsoft/winget-pkgs,
 * and the stores' addresses once they're published.
 */
const LISTINGS: {
  winget: boolean;
  store: string | null;
  chrome: string | null;
  firefox: string | null;
} = {
  winget: false,
  store: null,
  chrome: null,
  firefox: null,
};
const WINGET_COMMAND = "winget install Amluto.Steps";

/** A file's SHA-256 with a Copy button, so it can be checked against the download. */
function Checksum({ file, label }: { file: ReleaseFile; label: string }) {
  const [copied, setCopied] = useState(false);
  if (!file.sha256) return null;
  const hash = file.sha256;
  return (
    // Two rows of the grid around it (subgrid), so the boxes line up however many lines each
    // file name takes, with a short name sitting just above its box.
    <div className="row-span-2 grid grid-rows-subgrid gap-2">
      <span className="self-end text-sm text-muted">{label}</span>
      <div className="flex items-start gap-3 rounded-xl border border-line bg-page px-4 py-3">
        <code className="min-w-0 flex-1 font-mono text-[13px] leading-relaxed break-all">
          {hash}
        </code>
        <button
          type="button"
          aria-label={`Copy the SHA-256 of ${file.name}`}
          onClick={() => {
            void navigator.clipboard?.writeText(hash).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1600);
            });
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-sm font-semibold text-accent hover:bg-accent-soft"
        >
          {copied ? (
            <Check size={15} weight="bold" aria-hidden="true" />
          ) : (
            <Copy size={15} aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** One of the other ways to get Steps: what it's for, and its download or its status. */
function Option({
  icon: Icon,
  title,
  body,
  children,
}: {
  icon: typeof WindowsLogo;
  title: string;
  body: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="flex flex-col gap-3 border-t border-line py-5 first:border-t-0 first:pt-0 sm:flex-row sm:items-start">
      <Icon size={26} weight="duotone" className="shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h4 className="font-display text-lg font-semibold">{title}</h4>
        <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </li>
  );
}

/** A command to paste into a terminal, with a Copy button. */
function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Copy the command ${command}`}
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      className={secondary}
    >
      {copied ? (
        <Check size={17} weight="bold" aria-hidden="true" />
      ) : (
        <Copy size={17} aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy command"}
    </button>
  );
}

/** The systems Steps is for, one tab each, Windows first (30/09/2026). */
const PLATFORMS = [
  { id: "windows", label: "Windows", icon: WindowsLogo },
  { id: "linux", label: "Linux", icon: LinuxLogo },
  { id: "browsers", label: "Browsers", icon: Browsers },
  // The code itself, and building it (03/10/2026).
  { id: "github", label: "GitHub", icon: GithubLogo },
] as const;
type Platform = (typeof PLATFORMS)[number]["id"];

/**
 * The main download for a tab: a big button, and what it is. Full width on a phone, where its words
 * may wrap: with large text "Download for Windows (.exe)" ran past the panel (02/10/2026).
 */
function MainDownload({
  href,
  file,
  label,
  children,
}: {
  href: string;
  file: string | null;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-4">
      <a
        href={href}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-center text-base font-semibold text-accent-ink transition-transform hover:-translate-y-0.5 active:scale-[0.98] sm:w-auto sm:whitespace-nowrap"
        {...(file ? { download: file } : {})}
      >
        <DownloadSimple size={20} weight="bold" aria-hidden="true" />
        {label}
      </a>
      <p className="text-sm text-muted">{children}</p>
    </div>
  );
}

/** Built and submitted, but not live until the store or winget's moderators approve it. */
const waiting = (
  <span className="inline-flex h-10 items-center gap-2 rounded-full bg-accent-soft px-4 text-sm font-semibold whitespace-nowrap text-accent">
    <Hourglass size={16} weight="duotone" aria-hidden="true" />
    Waiting for its listing
  </span>
);

const secondary =
  "inline-flex h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold whitespace-nowrap transition-transform hover:-translate-y-0.5 hover:border-accent active:scale-[0.98]";

/**
 * The download: one tab per system, Windows first (30/09/2026). The current version is read
 * live from the site's own update file, so this page stays right after every release. While it
 * loads the buttons still work: they go to the files.
 */
export function Download() {
  const state = useReleaseState();
  const release = state.kind === "ready" ? state.release : null;
  const [platform, setPlatform] = useState<Platform>("windows");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const version =
    state.kind === "loading" ? (
      <span className="inline-block h-4 w-48 animate-pulse rounded-full bg-surface-2 align-middle" />
    ) : release ? (
      <>
        Version {release.version}
        {release.published ? `, released ${release.published}` : ""}
      </>
    ) : (
      "The latest version is on GitHub."
    );

  // Arrow keys move between the tabs, as in any tab list; Home and End go to the ends.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = PLATFORMS.length - 1;
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % PLATFORMS.length
        : event.key === "ArrowLeft"
          ? (index + last) % PLATFORMS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    if (next === null) return;
    event.preventDefault();
    const target = PLATFORMS[next];
    if (!target) return;
    setPlatform(target.id);
    tabs.current[next]?.focus();
  };

  const checksums =
    release &&
    (platform === "windows"
      ? [release.setup, release.portable, release.msi]
      : platform === "linux" && release.linux
        ? [release.linux.deb, release.linux.appImage]
        : []);

  // Under the main download, beside the other ways to get Steps: what the browser and Windows may
  // say about an unsigned installer and how to keep it (03/10/2026: people were told to delete
  // it), and each file's SHA-256 to check it by. On a phone they come after the other ways.
  const check = (
    <div className="flex flex-col gap-5 self-start lg:col-start-1 lg:row-start-2">
      <div className="flex gap-3 rounded-xl bg-accent-soft p-4 text-sm leading-relaxed">
        <Info
          size={20}
          weight="duotone"
          className="mt-0.5 shrink-0 text-accent"
          aria-hidden="true"
        />
        {platform === "windows" ? (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="font-semibold">Your browser or Windows may warn you</p>
            <p>
              Steps is new and its installers aren&rsquo;t signed yet, so Edge, Chrome and Windows
              don&rsquo;t know them. The warning is about the file being new, not about anything
              found in it
              {release?.setup.sha256 ? (
                <>
                  {" "}
                  (
                  <a
                    className="font-semibold text-accent hover:underline"
                    href={`https://www.virustotal.com/gui/file/${release.setup.sha256}`}
                  >
                    see the setup&rsquo;s virus scan
                  </a>
                  )
                </>
              ) : null}
              . To keep it:
            </p>
            <ul className="flex list-disc flex-col gap-1 pl-5">
              <li>
                <strong>Edge:</strong> next to the download, choose <strong>&hellip;</strong>, then{" "}
                <strong>Keep</strong>, <strong>Show more</strong> and <strong>Keep anyway</strong>.
              </li>
              <li>
                <strong>Chrome:</strong> choose <strong>Keep</strong>.
              </li>
              <li>
                <strong>Windows</strong>, when you open it: <strong>More info</strong>, then{" "}
                <strong>Run anyway</strong>.
              </li>
            </ul>
            <p>
              To check a file first, compare its hash with the one below: in PowerShell,{" "}
              <code className="font-mono text-[13px]">Get-FileHash</code> followed by the
              file&rsquo;s name. Every file, the source code and the open-source notices are on{" "}
              <a
                className="font-semibold text-accent hover:underline"
                href={releasePage(release?.version)}
              >
                the release&rsquo;s GitHub page
              </a>
              .
            </p>
          </div>
        ) : (
          <p>
            To check a file first, compare its hash with the one below:{" "}
            <code className="font-mono text-[13px]">sha256sum</code> followed by the file&rsquo;s
            name. Every file, the source code and the open-source notices are on{" "}
            <a
              className="font-semibold text-accent hover:underline"
              href={releasePage(release?.version)}
            >
              the release&rsquo;s GitHub page
            </a>
            .
          </p>
        )}
      </div>
      {state.kind === "loading" && (
        <div className="flex flex-col gap-2" aria-hidden="true">
          <span className="h-4 w-40 animate-pulse rounded-full bg-surface-2" />
          <span className="h-16 w-full animate-pulse rounded-xl bg-surface-2" />
        </div>
      )}
      {checksums && checksums.length > 0 && (
        <div className="grid gap-x-5 gap-y-4">
          {checksums.map((file) => (
            <Checksum key={file.name} file={file} label={`SHA-256 of ${file.name}`} />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <section id="download" aria-labelledby="download-title" className="px-4 pb-24 md:px-8 md:pb-32">
      <Reveal className="ring-panel mx-auto max-w-5xl overflow-hidden rounded-[var(--radius-panel)]">
        <div className="flex flex-col gap-6 px-6 pt-8 sm:px-8 md:px-12 md:pt-12">
          <h2 id="download-title" className="font-display text-4xl font-semibold tracking-tight">
            Download Steps
          </h2>
          <p className="text-lg leading-relaxed text-muted">
            Free and open source, in 38 languages: for Windows 11 on 64-bit PCs, for Linux, and in
            Chrome, Edge and Firefox.
          </p>
          <div
            role="tablist"
            aria-label="Choose your system"
            className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-line)]"
          >
            {PLATFORMS.map((item, index) => {
              const selected = platform === item.id;
              return (
                <button
                  key={item.id}
                  ref={(element) => {
                    tabs.current[index] = element;
                  }}
                  type="button"
                  role="tab"
                  id={`download-tab-${item.id}`}
                  aria-selected={selected}
                  aria-controls={`download-panel-${item.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setPlatform(item.id)}
                  onKeyDown={(event) => onTabKey(event, index)}
                  className={`inline-flex flex-1 items-center justify-center gap-2 border-b-2 px-2 py-3 text-sm font-semibold whitespace-nowrap transition-colors sm:flex-none sm:px-4 sm:text-base ${selected ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink"}`}
                >
                  <item.icon
                    size={20}
                    weight="duotone"
                    aria-hidden="true"
                    className="hidden sm:block"
                  />
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="tabpanel"
          id={`download-panel-${platform}`}
          aria-labelledby={`download-tab-${platform}`}
          className="grid grid-cols-1 gap-10 px-6 py-8 sm:px-8 md:p-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-rows-[auto_1fr]"
        >
          {platform === "windows" && (
            <>
              <div className="lg:col-start-1 lg:row-start-1">
                <MainDownload
                  href={release?.setup.url ?? releasePage()}
                  file={release?.setup.name ?? null}
                  label="Download for Windows (.exe)"
                >
                  The setup .exe: installs Steps for you, no admin rights needed.
                  <br />
                  {version}
                </MainDownload>
              </div>
              <ul className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
                <Option
                  icon={TerminalWindow}
                  title="winget"
                  body={
                    <>
                      For the Windows Package Manager:{" "}
                      <code className="font-mono text-[13px] text-ink">{WINGET_COMMAND}</code>. Add{" "}
                      <code className="font-mono text-[13px] text-ink">--scope machine</code> to
                      install it for everyone on the PC.
                    </>
                  }
                >
                  {LISTINGS.winget ? <CopyCommand command={WINGET_COMMAND} /> : waiting}
                </Option>
                <Option
                  icon={Storefront}
                  title="Microsoft Store"
                  body="Installed and kept up to date by the Store, with no warnings from Windows."
                >
                  {LISTINGS.store ? (
                    <a href={LISTINGS.store} className={secondary}>
                      <Storefront size={17} weight="bold" aria-hidden="true" />
                      Get it from the Store
                    </a>
                  ) : (
                    waiting
                  )}
                </Option>
                <Option
                  icon={Lightning}
                  title="Portable"
                  body="Runs without installing, from any folder or a USB stick, and keeps its data in a folder beside it. It can update itself once you switch on Update automatically."
                >
                  <a
                    href={release?.portable.url ?? releasePage()}
                    className={secondary}
                    {...(release ? { download: release.portable.name } : {})}
                  >
                    <DownloadSimple size={17} weight="bold" aria-hidden="true" />
                    Portable
                  </a>
                </Option>
                <Option
                  icon={Buildings}
                  title="MSI, for IT"
                  body="Silent installs for everyone, with settings for Group Policy and Intune."
                >
                  <span className="flex flex-wrap gap-2">
                    <a href={release?.msi.url ?? releasePage()} className={secondary}>
                      <DownloadSimple size={17} weight="bold" aria-hidden="true" />
                      MSI
                    </a>
                    <a href="/it/" className={secondary}>
                      IT guide
                    </a>
                  </span>
                </Option>
              </ul>
              {check}
            </>
          )}

          {platform === "linux" &&
            (release?.linux ? (
              <>
                <div className="lg:col-start-1 lg:row-start-1">
                  <MainDownload
                    href={release.linux.deb.url}
                    file={release.linux.deb.name}
                    label="Download for Linux (.deb)"
                  >
                    A beta, for X11 sessions on Ubuntu, Debian and most other distributions.
                    <br />
                    {version}
                  </MainDownload>
                </div>
                <ul className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
                  <Option
                    icon={LinuxLogo}
                    title="AppImage"
                    body="One file that runs on most distributions without installing. Make it executable, then run it."
                  >
                    <a
                      href={release.linux.appImage.url}
                      className={secondary}
                      download={release.linux.appImage.name}
                    >
                      <DownloadSimple size={17} weight="bold" aria-hidden="true" />
                      AppImage
                    </a>
                  </Option>
                </ul>
                {check}
              </>
            ) : (
              <p className="text-muted">
                {state.kind === "loading" ? version : "The Linux beta is coming soon."}
              </p>
            ))}

          {platform === "github" && <GitHubPanel />}

          {platform === "browsers" && (
            <>
              <div className="flex flex-col gap-3">
                <p className="text-lg leading-relaxed">
                  Record in the browser, for when installing an app isn&rsquo;t an option.
                </p>
                <p className="text-sm leading-relaxed text-muted">
                  Guides stay in the browser on your computer, or in Chrome and Edge in a OneDrive
                  or SharePoint folder your team shares, and export the same way as from the app.
                </p>
              </div>
              <ul>
                <Option
                  icon={GoogleChromeLogo}
                  title="Chrome and Edge"
                  body="From the Chrome Web Store, for Google Chrome and Microsoft Edge."
                >
                  {LISTINGS.chrome ? (
                    <a href={LISTINGS.chrome} className={secondary}>
                      <GoogleChromeLogo size={17} weight="bold" aria-hidden="true" />
                      Add to Chrome
                    </a>
                  ) : (
                    waiting
                  )}
                </Option>
                <Option icon={Browser} title="Firefox" body="From Firefox Add-ons.">
                  {LISTINGS.firefox ? (
                    <a href={LISTINGS.firefox} className={secondary}>
                      <Browser size={17} weight="bold" aria-hidden="true" />
                      Add to Firefox
                    </a>
                  ) : (
                    waiting
                  )}
                </Option>
              </ul>
            </>
          )}
        </div>
      </Reveal>
    </section>
  );
}

/** The code on GitHub: the repository, its stars as of the last deploy, and how to build it. */
function GitHubPanel() {
  const github = useGitHub();
  return (
    <>
      <div className="flex flex-col items-start gap-4">
        <a
          href={REPOSITORY_URL}
          className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-3 text-center text-base font-semibold text-accent-ink transition-transform hover:-translate-y-0.5 active:scale-[0.98] sm:w-auto sm:whitespace-nowrap"
        >
          <GithubLogo size={20} weight="bold" aria-hidden="true" />
          amluto-solutions/steps
        </a>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
          {/* Not while it's 0: "0 stars" puts people off more than no count. */}
          {github && github.stars > 0 && (
            <a
              href={`${REPOSITORY_URL}/stargazers`}
              className="inline-flex items-center gap-1.5 font-semibold text-ink hover:text-accent"
            >
              <Star size={16} weight="fill" className="text-accent" aria-hidden="true" />
              {github.stars === 1 ? "1 star" : `${github.stars.toLocaleString("en-GB")} stars`}
            </a>
          )}
          <span>Free software under the GNU GPL, version 3 or later.</span>
        </p>
        <p className="text-sm leading-relaxed text-muted">
          Read the code, report a problem, suggest a change, or star the repository so more people
          find Steps.
        </p>
        <span className="flex flex-wrap gap-2">
          <a href={`${REPOSITORY_URL}/issues`} className={secondary}>
            Report a problem
          </a>
          <a href={`${REPOSITORY_URL}/releases`} className={secondary}>
            Every release
          </a>
        </span>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <h3 className="font-display text-lg font-semibold">Build it yourself</h3>
        <p className="text-sm leading-relaxed text-muted">
          On Windows 11 you need Node.js 24, Rust and Visual Studio&rsquo;s C++ build tools. Then,
          in the repository:
        </p>
        <pre className="overflow-x-auto rounded-xl border border-line bg-page px-4 py-3 font-mono text-[13px] leading-relaxed">
          <code>
            {
              "npm install\nnpm run dev              # the app, with hot reload\nnpm run tauri -- build   # the installers"
            }
          </code>
        </pre>
        <p className="text-sm leading-relaxed text-muted">
          Linux and the browser extension build from the same code.{" "}
          <a
            className="font-semibold text-accent hover:underline"
            href={`${REPOSITORY_URL}#building-it-yourself`}
          >
            The README has every step
          </a>
          .
        </p>
      </div>
    </>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-10 text-sm text-muted md:flex-row md:items-center md:px-8">
        <a
          href="https://amluto.com"
          className="w-fit rounded-sm transition-opacity hover:opacity-80"
          aria-label="Amluto (amluto.com)"
        >
          <picture>
            <source srcSet={logoWhite} media="(prefers-color-scheme: dark)" />
            <img src={logoColour} alt="" width={112} height={24} className="h-5 w-auto" />
          </picture>
        </a>
        <span className="flex-1">
          &copy; 2026 Amluto Solutions Ltd. Free software under the GPL-3.0.
        </span>
        <nav aria-label="Footer" className="flex flex-wrap gap-6">
          <a className="hover:text-ink" href="/help/">
            Help
          </a>
          <a className="hover:text-ink" href="/it/">
            IT guide
          </a>
          <a className="hover:text-ink" href="https://privacy.amluto.com/">
            Privacy policy
          </a>
          <a className="hover:text-ink" href={REPOSITORY_URL}>
            Source code
          </a>
          <a className="hover:text-ink" href={SUPPORT_URL}>
            Support Steps
          </a>
          <a className="hover:text-ink" href="mailto:steps@amluto.com">
            steps@amluto.com
          </a>
        </nav>
      </div>
    </footer>
  );
}
