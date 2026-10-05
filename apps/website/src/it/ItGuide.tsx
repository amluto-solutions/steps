import { ArrowRight, Buildings, DownloadSimple, FileZip } from "@phosphor-icons/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { C, DocPage, DocSection, Note, Table } from "../components/doc";
import { CodeBlock } from "../components/shared";
import { releasePage, useReleaseState } from "../release";

/**
 * steps.amluto.com/it/: everything an IT team needs to deploy Steps and set it up for
 * everyone. Every claim here matches docs/spec/07-settings-and-policy.md, docs/spec/10-distribution.md
 * and the ADMX in apps/desktop/policy; change them together.
 */

const POLICY_ZIP = `/it/amluto-steps-policy-templates.zip?v=${__POLICY_VERSION__}`;
const KEY = "Software\\Policies\\Amluto\\Steps";

const SECTIONS = [
  { id: "installers", title: "Choose an installer" },
  { id: "msi", title: "Install with the MSI" },
  { id: "properties", title: "MSI properties" },
  { id: "group-policy", title: "Group Policy" },
  { id: "intune", title: "Intune" },
  { id: "registry", title: "Registry values" },
  { id: "recipes", title: "Common set-ups" },
  { id: "locks", title: "Guide password locks" },
  { id: "updates", title: "Updates" },
  { id: "privacy", title: "What it records" },
  { id: "files", title: "Where things are kept" },
  { id: "special", title: "Admin tools and remote desktops" },
  { id: "uninstall", title: "Uninstall" },
  { id: "linux", title: "Linux (beta)" },
  { id: "help", title: "Getting help" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const section = SECTIONS.find((found) => found.id === id) ?? { id, title: "" };
  return <DocSection section={section}>{children}</DocSection>;
}

function Recipe({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-[var(--radius-panel)] border border-line bg-surface p-6">
      <h3 className="font-display text-xl font-semibold tracking-tight text-ink">{title}</h3>
      {children}
    </div>
  );
}

function Header() {
  const state = useReleaseState();
  const release = state.kind === "ready" ? state.release : null;
  const facts = [
    { label: "Runs on", value: "Windows 11 (24H2 and later), 64-bit" },
    { label: "Installs", value: "per machine with the MSI, or per person with the setup" },
    // A zero-width space after each backslash: the path breaks there, never inside a word.
    { label: "Settings live in", value: `HKLM or HKCU\\${KEY}`.replaceAll("\\", "\\​") },
    { label: "Talks to", value: "nothing but its own update check, which you can turn off" },
  ];
  return (
    <section className="relative overflow-hidden border-b border-line">
      <div className="hero-light pointer-events-none absolute inset-0" aria-hidden="true" />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
        className="relative mx-auto grid max-w-7xl gap-10 px-4 py-16 md:px-8 md:py-24 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end"
      >
        <div className="flex flex-col gap-6">
          <p className="inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-accent uppercase">
            <Buildings size={18} weight="duotone" aria-hidden="true" />
            IT guide
          </p>
          <h1 className="max-w-[18ch] font-display text-4xl leading-[1.05] font-semibold tracking-tight md:text-6xl">
            Deploying and managing Steps
          </h1>
          <p className="max-w-[60ch] text-lg leading-relaxed text-muted">
            A silent install, settings for everyone through Group Policy, Intune or the registry,
            and exactly what the app reads and keeps, for your security review.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href={POLICY_ZIP}
              download
              className="inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 font-semibold whitespace-nowrap text-accent-ink transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
            >
              <FileZip size={20} weight="bold" aria-hidden="true" />
              Policy templates (ADMX)
            </a>
            <a
              href={release?.msi.url ?? releasePage()}
              className="inline-flex h-12 items-center gap-2 rounded-full border border-line bg-surface px-6 font-semibold whitespace-nowrap transition-transform duration-200 ease-out hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98]"
            >
              <DownloadSimple size={20} weight="bold" aria-hidden="true" />
              {release ? `MSI ${release.version}` : "The MSI"}
            </a>
          </div>
        </div>
        <dl className="grid gap-px overflow-hidden rounded-[var(--radius-panel)] border border-line bg-line sm:grid-cols-2">
          {facts.map((fact) => (
            <div key={fact.label} className="flex flex-col gap-1 bg-surface p-5">
              <dt className="text-xs font-semibold tracking-wide text-muted uppercase">
                {fact.label}
              </dt>
              <dd className="text-sm leading-relaxed break-words">{fact.value}</dd>
            </div>
          ))}
        </dl>
      </motion.div>
    </section>
  );
}

function Guide() {
  const state = useReleaseState();
  const msi = state.kind === "ready" ? state.release.msi.name : "amluto-steps-x64.msi";
  const setup = state.kind === "ready" ? state.release.setup.name : "amluto-steps-x64-setup.exe";
  const sha = state.kind === "ready" ? state.release.msi.sha256 : null;

  return (
    <>
      <Section id="installers">
        <p>
          Two installers, from the same build. For deploying to a team, use the <strong>MSI</strong>
          . There&rsquo;s also a portable program that runs without installing, for trying Steps out
          or a PC where nothing can be installed. It updates itself only once someone switches on
          Update automatically, and it reads the same policy settings, DisableUpdateCheck included.
        </p>
        <Table
          label="The installers compared"
          head={["", "MSI", "Setup (.exe)"]}
          rows={[
            ["File", <C key="m">{msi}</C>, <C key="s">{setup}</C>],
            [
              "Installs for",
              "everyone on the PC; needs admin rights",
              "the person signed in; no admin rights",
            ],
            [
              "Updates",
              "never checks: you deploy new versions",
              "checks steps.amluto.com, downloads signed updates, installs at the next start",
            ],
            [
              "Settings at install",
              "yes, as properties (below)",
              "no: use Group Policy, Intune or the registry",
            ],
            ["Best for", "Intune, Configuration Manager, scripts", "individuals"],
          ]}
        />
        <p>
          Both fetch Microsoft Edge WebView2 if the PC doesn&rsquo;t have it; Windows 11 already
          does. For networks that can&rsquo;t reach Microsoft, an MSI with WebView2 included is
          available from <a href="mailto:steps@amluto.com">steps@amluto.com</a>. The Microsoft Store
          version is waiting for its listing.
        </p>
      </Section>

      <Section id="msi">
        <p>A quiet install, with a log to check afterwards:</p>
        <CodeBlock
          className=""
          wrap
          language="Command Prompt (as administrator)"
          code={`msiexec /i ${msi} /quiet /norestart /l*v "%TEMP%\\amluto-steps-install.log"`}
        />
        <p>
          Settings go on the same line as properties. This one switches off &ldquo;Record
          what&rsquo;s typed&rdquo;, never records two apps, and starts Steps when people sign in:
        </p>
        <CodeBlock
          className=""
          wrap
          language="Command Prompt (as administrator)"
          code={`msiexec /i ${msi} /quiet /norestart DISABLEKEYSTROKES=1 EXCLUDEDAPPS="KeePass.exe;payroll.exe" AUTOSTART=1`}
        />
        <p>
          To upgrade, install the newer MSI the same way. It replaces the old version and keeps the
          properties you gave before, unless you give new ones.
        </p>
        <Note tone="warn">
          <strong>Paths with %USERPROFILE%</strong> must reach the installer as written, so that
          each person&rsquo;s own folder is used. Command Prompt would fill in the installing
          account&rsquo;s folder instead: in a <C>.cmd</C> file write <C>%%USERPROFILE%%</C>, or run
          msiexec from PowerShell, which leaves it alone.
        </Note>
        {sha && (
          <p className="text-sm">
            SHA-256 of {msi}: <C>{sha}</C>
          </p>
        )}
      </Section>

      <Section id="properties">
        <p>
          Each property writes one value under <C>HKLM\{KEY}</C>, the same place Group Policy
          writes. A property you don&rsquo;t give writes nothing. Lists are one value separated by
          semicolons.
        </p>
        <Table
          label="MSI properties"
          head={["Property", "Registry value", "Example"]}
          rows={[
            [
              "LIBRARIES",
              "Libraries",
              <C key="1">"Team guides=%USERPROFILE%\Contoso\Guides - Documents"</C>,
            ],
            ["DEFAULTLIBRARY", "DefaultLibrary", <C key="2">"Team guides"</C>],
            ["EXCLUDEDAPPS", "ExcludedApps", <C key="3">"KeePass.exe;payroll.exe"</C>],
            ["BLURTERMS", "BlurTerms", <C key="4">"Project Falcon;CUST-"</C>],
            [
              "SENSITIVEFIELDPATTERNS",
              "SensitiveFieldPatterns",
              <C key="5">"customer reference"</C>,
            ],
            [
              "BRANDPROFILES",
              "BrandProfiles",
              <C key="6">"\\fileserver\brands\Contoso.amlbrand"</C>,
            ],
            ["DEFAULTPDFBRAND", "DefaultPdfBrand", <C key="7">contoso</C>],
            ["APPCOLOURSBRAND", "AppColoursBrand", <C key="8">contoso</C>],
            ["AUTOSTART", "AutoStart", <C key="9">1 (on) or 0 (off)</C>],
            ["LOCKED", "Locked", <C key="10">"ScreenshotMode;ExportFolder"</C>],
            ["DISABLEKEYSTROKES", "DisableKeystrokeRecording", <C key="11">1</C>],
            [
              "RECORDTYPINGBYDEFAULT",
              "RecordTypingByDefault",
              <C key="13">1 (starts ticked) or 0 (starts unticked)</C>,
            ],
            [
              "INCLUDEOUTPUTBYDEFAULT",
              "IncludeCommandOutputByDefault",
              <C key="14">1 (starts ticked) or 0 (starts unticked)</C>,
            ],
            ["BLURSTRENGTH", "BlurStrength", <C key="15">light, standard or thorough</C>],
            ["SHOWUNNAMEDTYPING", "ShowUnnamedTyping", <C key="16">1 (shown) or 0 (not shown)</C>],
            ["DISABLEGUIDELOCKS", "DisableGuideLocks", <C key="19">1</C>],
            [
              "GUIDELOCKRECOVERYPASSWORD",
              "GuideLockRecoveryPassword",
              <C key="20">pbkdf2-sha256$600000$&hellip;</C>,
            ],
            ["RECORDPCANDLOGIN", "RecordPcAndLogin", <C key="21">1 (recorded) or 0 (not)</C>],
            ["STEPSLANGUAGE", "Language", <C key="17">de</C>],
            ["LANGUAGETONE", "LanguageTone", <C key="18">casual, plain or formal</C>],
            ["DISABLEUPDATECHECK", "DisableUpdateCheck", <C key="12">1</C>],
          ]}
        />
        <p>
          The language is <C>STEPSLANGUAGE</C>, not <C>LANGUAGE</C>, which Windows Installer uses
          itself. What each value does is under <a href="#registry">Registry values</a>. The values
          are removed when the app is uninstalled. To drop one, uninstall and install again without
          it. Use either MSI properties or Group Policy for a setting, not both: they write the same
          value.
        </p>
      </Section>

      <Section id="group-policy">
        <ol className="flex list-decimal flex-col gap-3 pl-5 marker:font-semibold marker:text-accent">
          <li>
            Download the <a href={POLICY_ZIP}>policy templates</a>. The zip holds{" "}
            <C>AmlutoSteps.admx</C> and <C>en-US\AmlutoSteps.adml</C>, laid out as{" "}
            <C>PolicyDefinitions</C>.
          </li>
          <li>
            Copy both into your central store,{" "}
            <C>\\&lt;domain&gt;\SYSVOL\&lt;domain&gt;\Policies\PolicyDefinitions</C>, or into{" "}
            <C>C:\Windows\PolicyDefinitions</C> on one PC. The <C>.adml</C> goes in the <C>en-US</C>{" "}
            folder.
          </li>
          <li>
            In the Group Policy editor, the settings are under{" "}
            <strong>Administrative Templates &gt; Amluto &gt; Steps</strong>, in both Computer and
            User Configuration.
          </li>
          <li>
            Steps reads its settings when it starts. After <C>gpupdate</C>, quit it from the tray
            and open it again (or sign out and in).
          </li>
        </ol>
        <Table
          label="Group Policy settings"
          head={["Setting", "Folder", "Registry value"]}
          rows={[
            ["Add libraries", "Libraries", "Libraries"],
            ["Default library for new recordings", "Libraries", "DefaultLibrary"],
            ["Apps never recorded", "Recording", "ExcludedApps"],
            ["Language tone of new recordings", "Recording", "LanguageTone"],
            ["Always-blur words", "Privacy", "BlurTerms"],
            ["Sensitive field names", "Privacy", "SensitiveFieldPatterns"],
            ["Blur suggestions", "Privacy", "BlurStrength"],
            [
              "Turn off \u201cRecord what\u2019s typed\u201d",
              "Privacy",
              "DisableKeystrokeRecording",
            ],
            [
              "Start recordings with \u201cRecord what\u2019s typed\u201d ticked",
              "Privacy",
              "RecordTypingByDefault",
            ],
            [
              "Start recordings with \u201cInclude command output\u201d ticked",
              "Privacy",
              "IncludeCommandOutputByDefault",
            ],
            ["Show typing into unnamed boxes", "Privacy", "ShowUnnamedTyping"],
            ["Record the PC name and Windows login in guides", "Privacy", "RecordPcAndLogin"],
            ["Turn off guide password locks", "Libraries", "DisableGuideLocks"],
            ["Recovery password for locked guides", "Libraries", "GuideLockRecoveryPassword"],
            ["Deploy brands", "Branding", "BrandProfiles"],
            ["Default brand for exports", "Branding", "DefaultPdfBrand"],
            ["App colours", "Branding", "AppColoursBrand"],
            ["Start with Windows", "Steps", "AutoStart"],
            ["Lock settings", "Steps", "Locked"],
            ["Turn off update checks", "Steps", "DisableUpdateCheck"],
            ["Language of Steps", "Steps", "Language"],
          ]}
        />
        <p>
          Each setting has its own explanation in the editor. Computer Configuration wins over User
          Configuration, except for the four lists that add up: apps never recorded, always-blur
          words, sensitive field names and locked settings.
        </p>
      </Section>

      <Section id="intune">
        <p>
          <strong>The app:</strong> add the MSI as a Windows line-of-business app, and put any
          properties in its command-line arguments (for example <C>DISABLEKEYSTROKES=1</C>). Intune
          installs it quietly.
        </p>
        <p>
          <strong>The settings:</strong> import the templates under Devices, Configuration,{" "}
          <strong>Import ADMX</strong>, giving it <C>AmlutoSteps.admx</C> and{" "}
          <C>AmlutoSteps.adml</C>, which are also here on their own:
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          <a
            href={`/it/policy/AmlutoSteps.admx?v=${__POLICY_VERSION__}`}
            download
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 font-semibold text-ink hover:border-accent"
          >
            <DownloadSimple size={16} weight="bold" aria-hidden="true" />
            AmlutoSteps.admx
          </a>
          <a
            href={`/it/policy/en-US/AmlutoSteps.adml?v=${__POLICY_VERSION__}`}
            download
            className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 font-semibold text-ink hover:border-accent"
          >
            <DownloadSimple size={16} weight="bold" aria-hidden="true" />
            AmlutoSteps.adml
          </a>
        </div>
        <p>
          Then create a configuration profile from{" "}
          <strong>Imported Administrative templates</strong>. The settings are the same as in Group
          Policy. Intune&rsquo;s menus move from time to time, so the names may differ slightly.
        </p>
      </Section>

      <Section id="registry">
        <p>
          Group Policy, Intune and the MSI all end up here, so you can also set these values
          directly, with any tool that writes the registry.
        </p>
        <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-accent">
          <li>
            <C>HKLM\{KEY}</C> applies to everyone on the PC; <C>HKCU\{KEY}</C> to one person.
          </li>
          <li>
            Where both have a value, the PC&rsquo;s wins. <C>ExcludedApps</C>, <C>BlurTerms</C>,{" "}
            <C>SensitiveFieldPatterns</C> and <C>Locked</C> are combined from both.
          </li>
          <li>
            Read when Steps starts. Staff see these settings marked &ldquo;Set by your
            organisation&rdquo; and can&rsquo;t change them, and importing a settings file is
            switched off.
          </li>
        </ul>
        <Table
          label="Registry values"
          head={["Value", "Type", "What it does"]}
          rows={[
            [
              "Libraries",
              "Multi-string",
              <>
                Guide libraries for everyone, one <C>Name=Path</C> per line (a path alone uses the
                folder&rsquo;s name). Each is added once its folder exists, so a synced SharePoint
                library appears after OneDrive has downloaded it. Staff can&rsquo;t rename or remove
                them.
              </>,
            ],
            [
              "DefaultLibrary",
              "String",
              "The library new recordings are saved to: its name as shown in Settings, or its folder.",
            ],
            [
              "ExcludedApps",
              "Multi-string",
              <>
                Program file names never recorded, such as <C>KeePass.exe</C>: no clicks or
                screenshots in them, and their windows are blacked out of other screenshots.
              </>,
            ],
            [
              "BlurTerms",
              "Multi-string",
              "Words and phrases always suggested for blurring when they appear in a screenshot, such as internal project names.",
            ],
            [
              "SensitiveFieldPatterns",
              "Multi-string",
              "Extra words that mark a field, command parameter or variable as sensitive, added to the built-in list (passwords, PINs, tokens, keys, codes, card and account numbers). Its value is never read, or is masked in commands.",
            ],
            [
              "BrandProfiles",
              "Multi-string",
              <>
                Full paths to <C>.amlbrand</C> files, imported at start and updated when the
                file&rsquo;s version is higher. Logos and uploaded fonts are inside the file, and
                each PC keeps its own copy, so exports work with the share out of reach. A share
                that can&rsquo;t be reached yet (no VPN) is tried again every few minutes. A brand
                imported from the share stays read-only on that PC for good; staff can duplicate it
                to make their own.
              </>,
            ],
            [
              "DefaultPdfBrand",
              "String",
              "The id of the brand that PDF, Word and web page exports use unless someone picks another.",
            ],
            ["AppColoursBrand", "String", "The id of the brand whose colours the app itself uses."],
            [
              "AutoStart",
              "DWORD",
              "1: starts minimised at sign-in, and can't be switched off. 0: never starts with Windows. Absent: each person chooses.",
            ],
            [
              "Locked",
              "Multi-string",
              "Settings shown read-only at their defaults: see the table below.",
            ],
            [
              "DisableKeystrokeRecording",
              "DWORD",
              "1: \u201cRecord what\u2019s typed\u201d can\u2019t be ticked. No keys, commands, command output or typed values are read; recordings have clicks and screenshots only. It can\u2019t be forced on, and it wins over the two below.",
            ],
            [
              "RecordTypingByDefault",
              "DWORD",
              "1: \u201cRecord what\u2019s typed\u201d starts ticked when a recording starts. 0: it starts unticked. Either way people can still change it for a recording, but not in Settings. Absent: each person chooses in Settings (unticked to begin with).",
            ],
            [
              "IncludeCommandOutputByDefault",
              "DWORD",
              "The same for \u201cInclude command output\u201d, which only applies with \u201cRecord what\u2019s typed\u201d ticked. Output can hold personal data, so people should check it before sharing.",
            ],
            [
              "ShowUnnamedTyping",
              "DWORD",
              "1: a step shows what was typed into something Steps couldn\u2019t name, such as a document or a box with no label. 0: the step says only \u201cType\u201d, and the author can show the text step by step. Absent: not shown, and each person chooses.",
            ],
            [
              "DisableGuideLocks",
              "DWORD",
              "1: Lock\u2026 is hidden, so nobody can lock a guide with a password. Guides already locked stay locked. Absent: anyone who can edit a guide can lock it.",
            ],
            [
              "GuideLockRecoveryPassword",
              "String",
              <>
                The hash of a password that unlocks any locked guide, made as{" "}
                <a href="#locks">Guide password locks</a> shows. Never the password itself. Absent:
                a forgotten password can&rsquo;t be recovered.
              </>,
            ],
            [
              "RecordPcAndLogin",
              "DWORD",
              "1: guides record the PC\u2019s name and the Windows login of whoever saves or locks them, shown in Properties. 0: only the person\u2019s display name. Absent: on, and each person can switch it off in Settings > Privacy.",
            ],
            [
              "BlurStrength",
              "String",
              <>
                <C>light</C>, <C>standard</C> or <C>thorough</C>: how much Steps looks for in
                screenshots to suggest blurring. Light finds emails, phone, card and bank numbers
                and the always-blur words; Standard adds postcodes, National Insurance numbers,
                names and IDs beside their labels, and the person&rsquo;s own Windows and OneDrive
                account names; Thorough adds file names and paths. Suggestions are never blurred by
                themselves. Absent: standard, and each person chooses.
              </>,
            ],
            [
              "Language",
              "String",
              <>
                The app&rsquo;s language, as a code such as <C>de</C>, <C>pt-BR</C>, <C>sr-Latn</C>{" "}
                or <C>zh-Hant</C> (the Group Policy template lists all 38 by name): its screens, the
                words new recordings are written in, and the fixed words in exports. A code Steps
                doesn&rsquo;t have is ignored. Absent: Windows&rsquo; display language, or English
                if Steps doesn&rsquo;t have it, and each person chooses.
              </>,
            ],
            [
              "LanguageTone",
              "String",
              <>
                <C>casual</C>, <C>plain</C> or <C>formal</C>: how the steps of new recordings are
                worded. A guide can still be reworded afterwards. Absent: casual, and each person
                chooses.
              </>,
            ],
            [
              "DisableUpdateCheck",
              "DWORD",
              "1: copies installed from the setup never check for updates. The MSI\u2019s copy never checks anyway.",
            ],
          ]}
        />
        <Table
          label="Settings that can be locked"
          head={["In Locked", "Held at"]}
          rows={[
            ["ScreenshotMode", "screenshots of the window clicked in"],
            ["ScreenshotQuality", "screenshots kept at Balanced quality"],
            ["Monitors", "all monitors recorded"],
            ["AppSwitchSteps", "an \u201cOpen\u201d step each time someone switches apps"],
            ["ExportFolder", "exports saved to Downloads"],
            ["AskWhereToSave", "exports saved without asking where"],
            [
              "IncludeOriginals",
              <>
                Steps files (<C>.amlsteps</C>) never include the unblurred original screenshots
              </>,
            ],
          ]}
        />
        <p>To try a setting on one PC first, from PowerShell as administrator:</p>
        <CodeBlock
          className=""
          wrap
          language="PowerShell"
          code={`$key = "HKLM:\\SOFTWARE\\Policies\\Amluto\\Steps"
New-Item -Path $key -Force | Out-Null
New-ItemProperty -Path $key -Name DisableKeystrokeRecording -PropertyType DWord -Value 1 -Force
New-ItemProperty -Path $key -Name ExcludedApps -PropertyType MultiString -Value @("KeePass.exe", "payroll.exe") -Force`}
        />
      </Section>

      <Section id="recipes">
        <div className="grid gap-5 xl:grid-cols-2">
          <Recipe title="A shared library in SharePoint">
            <p>
              Sync the SharePoint library to each PC with OneDrive, then point Steps at the synced
              folder and make it the default. Everyone sees the same guides.
            </p>
            <CodeBlock
              className=""
              wrap
              language="MSI properties"
              code={`LIBRARIES="Team guides=%USERPROFILE%\\Contoso\\Guides - Documents" DEFAULTLIBRARY="Team guides"`}
            />
          </Recipe>
          <Recipe title="Your brand on every export">
            <p>
              Make the brand in Settings &gt; Brand profiles, export it as an <C>.amlbrand</C> file,
              and put it on a share or in a synced folder. Its id is the <C>&quot;id&quot;</C>{" "}
              inside <C>&quot;profile&quot;</C> when you open the file in Notepad; the built-in
              brand is <C>amluto</C>. To change it for everyone, export a new version over the same
              file.
            </p>
            <CodeBlock
              className=""
              wrap
              language="MSI properties"
              code={`BRANDPROFILES="\\\\fileserver\\brands\\Contoso.amlbrand" DEFAULTPDFBRAND="contoso" APPCOLOURSBRAND="contoso"`}
            />
          </Recipe>
          <Recipe title="Clicks and screenshots only">
            <p>No keys, commands, command output or typed values are ever read.</p>
            <CodeBlock className="" wrap language="MSI property" code="DISABLEKEYSTROKES=1" />
          </Recipe>
          <Recipe title="Keep secrets out of guides">
            <p>
              Never record your password manager or payroll app, suggest blurring client codes, and
              treat your own field names as sensitive.
            </p>
            <CodeBlock
              className=""
              wrap
              language="MSI properties"
              code={`EXCLUDEDAPPS="KeePass.exe;payroll.exe" BLURTERMS="CUST-;Project Falcon" SENSITIVEFIELDPATTERNS="customer reference"`}
            />
          </Recipe>
        </div>
      </Section>

      <Section id="locks">
        <p>
          Anyone who can edit a guide can lock it with a password: guide menu &gt;{" "}
          <strong>Lock&hellip;</strong>, or several at once from the selection bar. A locked guide
          shows a padlock and &ldquo;Locked by&rdquo; with the person&rsquo;s name and the date.
          Without the password nobody can change, move or delete it in Steps, including the person
          who locked it. Anyone can still view it, export it, duplicate it, copy it to another
          library and merge it into a new guide. The password is kept only as a salted hash
          (PBKDF2-SHA256, 600,000 rounds) in <C>password-lock.json</C> in the guide&rsquo;s folder.
        </p>
        <p>
          The lock works inside Steps only. Anyone who can write to the library&rsquo;s folder can
          still change or delete the guide&rsquo;s files directly. Moving a guide to the Bin needs
          the password and takes the lock off. After 10 wrong passwords, each further try waits 30
          seconds.
        </p>
        <p>
          A forgotten password can&rsquo;t be recovered unless you set a{" "}
          <strong>recovery password</strong>, which unlocks any guide. Its use is recorded in the
          guide&rsquo;s Properties. Make its hash on any PC with Windows PowerShell, and deploy the
          line it prints as <C>GuideLockRecoveryPassword</C>. Keep the password itself somewhere
          safe; Steps never needs it.
        </p>
        <CodeBlock
          className=""
          wrap
          language="PowerShell"
          code={`$password = Read-Host "Recovery password" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
$salt = New-Object byte[] 16
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
$kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($plain, $salt, 600000, [Security.Cryptography.HashAlgorithmName]::SHA256)
"pbkdf2-sha256\`$600000\`$$([Convert]::ToBase64String($salt))\`$$([Convert]::ToBase64String($kdf.GetBytes(32)))"`}
        />
        <p>
          Each guide also keeps a <C>history.json</C>: how many times it&rsquo;s been saved, who
          created and last saved it, and its lock events. With <C>RecordPcAndLogin</C> on (the
          default) these include the PC&rsquo;s name and Windows login. Both files stay with the
          guide&rsquo;s folder and are never copied into duplicates or exports.
        </p>
      </Section>

      <Section id="updates">
        <ul className="flex list-disc flex-col gap-3 pl-5 marker:text-accent">
          <li>
            <strong>The MSI never checks for updates.</strong> Deploy the newer MSI when
            you&rsquo;re ready; it upgrades in place.
          </li>
          <li>
            <strong>The setup (.exe)</strong> checks steps.amluto.com 15 seconds after opening and
            then at most once every 20 hours. A new version downloads in the background and installs
            the next time the app opens, never during a recording.
          </li>
          <li>
            The check is a plain request for one file. It carries nothing about the person, the PC
            or their guides, not even the app&rsquo;s version.
          </li>
          <li>
            Updates are signed. The app refuses one unless the signature matches Amluto&rsquo;s key
            and was made for exactly the version offered, so an older signed version can&rsquo;t be
            passed off as new.
          </li>
          <li>
            <C>DisableUpdateCheck</C> stops every copy on the PC checking, for when you deploy
            versions yourself.
          </li>
        </ul>
      </Section>

      <Section id="privacy">
        <p>
          There&rsquo;s no account, no analytics and no server of ours: nothing is sent to Amluto.
          Guides are saved where people choose, on the PC or in a folder you provide.
        </p>
        <Table
          label="What Steps reads"
          head={["What", "When", "Kept"]}
          rows={[
            [
              "Clicks and a screenshot",
              "only while recording; the recording bar is on screen the whole time",
              "in the guide, as steps",
            ],
            [
              "The control clicked",
              "its name and type, read through Windows UI Automation",
              "in the step\u2019s wording",
            ],
            [
              "App, window title, website",
              "at each click and app switch; for websites only the site, never the page or query",
              "in the step",
            ],
            [
              "Keys, typed values, commands",
              "only in a recording started with \u201cRecord what\u2019s typed\u201d ticked. It starts unticked unless the person or IT chose otherwise, and can be changed at every start. The bar shows \u201cKeys recorded\u201d, and you can switch it off",
              "in the step, with passwords never kept and secrets in commands masked",
            ],
            [
              "Command output",
              "only when \u201cInclude command output\u201d is also ticked",
              "in the step, secrets masked",
            ],
            [
              "PC name and Windows login",
              "when a guide is saved or locked, unless switched off in Settings or by RecordPcAndLogin",
              "in the guide\u2019s history, shown in its Properties; never in exports",
            ],
            [
              "Text in screenshots",
              "read on the PC by Windows\u2019 own text recognition, to find details to blur",
              "a cache in app data, never in guides or exports",
            ],
          ]}
        />
        <p>
          Password and sensitive fields are never read. Clicks in Steps&rsquo; own windows and in
          excluded apps are ignored. Logs never contain typed values, commands, text from
          screenshots or screenshots.
        </p>
      </Section>

      <Section id="files">
        <Table
          label="Where things are kept"
          head={["Folder", "What"]}
          rows={[
            [
              <C key="1">Documents\Steps</C>,
              "the default library of guides, plus any libraries you add",
            ],
            [
              <C key="2">%APPDATA%\Amluto\Steps</C>,
              "settings, brands, the text-recognition cache, and recordings not yet saved (removed once saved or discarded)",
            ],
            [<C key="3">%LOCALAPPDATA%\com.amluto.steps\logs</C>, "logs, kept 30 days"],
            [
              <C key="4">%LOCALAPPDATA%\com.amluto.steps\support</C>,
              "support files, only when someone makes one to send us",
            ],
            [
              <C key="5">Steps data</C>,
              "the portable program keeps all of the above in this folder beside itself instead",
            ],
          ]}
        />
      </Section>

      <Section id="special">
        <p>
          <strong>Windows running as administrator.</strong> Windows doesn&rsquo;t let a normal app
          see clicks or control names inside them. When one is in front, the recording bar says so,
          and <C>Ctrl+Alt+Shift+S</C> still takes a screenshot as a step. To record admin tools
          fully, run Steps as administrator for that recording only.
        </p>
        <p>
          <strong>Remote desktops</strong> (Remote Desktop, Citrix, Azure Virtual Desktop). From the
          local PC a remote session is only a picture, so steps read &ldquo;Click in&rdquo; the
          session window. Install Steps inside the session for proper steps.
        </p>
        <p>
          <strong>SmartScreen.</strong> The installers aren&rsquo;t code-signed yet, so Windows may
          warn when someone runs one by hand. Deployment tools install the MSI without that prompt.
          Check the SHA-256 of any download with <C>Get-FileHash</C> against the ones on the{" "}
          <a href="/#download">download section</a>.
        </p>
      </Section>

      <Section id="uninstall">
        <CodeBlock
          className=""
          wrap
          language="Command Prompt (as administrator)"
          code={`msiexec /x ${msi} /quiet /norestart`}
        />
        <p>
          Uninstalling removes the program and the settings the MSI wrote. Guides stay in their
          libraries, and each person&rsquo;s <C>%APPDATA%\Amluto\Steps</C> folder stays until you
          delete it.
        </p>
      </Section>

      <Section id="linux">
        <p>
          A beta of the desktop app for Linux, for <strong>X11 sessions</strong> (Wayland
          doesn&rsquo;t let an app see clicks in other apps: Steps says so and offers the way to an
          X11 session, or use Steps for Chrome). It records clicks, fields and screenshots as on
          Windows, and names what&rsquo;s clicked through the desktop&rsquo;s accessibility
          interface (AT-SPI).
        </p>
        <p>
          <strong>Install</strong> the <C>.deb</C> (Ubuntu, Debian and derivatives) or run the
          AppImage (any distribution), from the <a href="/#download">download section</a>. The{" "}
          <C>.deb</C> recommends <C>tesseract-ocr</C>, which suggested blurs use. The beta looks for
          updates as the Windows setup does; <C>DisableUpdateCheck</C> in the policy file stops it.
        </p>
        <p>
          <strong>Policy</strong> is a JSON file only root can write,{" "}
          <C>/etc/amluto-steps/policy.json</C>, with the registry&rsquo;s value names. Programs are
          named without <C>.exe</C>:
        </p>
        <CodeBlock
          className=""
          wrap
          language="/etc/amluto-steps/policy.json"
          code={`{
  "ExcludedApps": ["keepassxc"],
  "BlurTerms": ["Project Falcon"],
  "DisableKeystrokeRecording": true,
  "BlurStrength": "thorough",
  "LanguageTone": "formal",
  "Locked": ["IncludeOriginals"]
}`}
        />
        <p>
          Each person&rsquo;s settings and recordings are in <C>~/.local/share/com.amluto.steps</C>;
          guides are in <C>~/Documents/Steps</C> unless a library is chosen elsewhere.
        </p>
      </Section>

      <Section id="help">
        <p>
          Email <a href="mailto:steps@amluto.com">steps@amluto.com</a>. In the app, Settings &gt;
          About &gt; Get help makes a support file with the logs, with names and folders taken out,
          for someone to attach.
        </p>
      </Section>
    </>
  );
}

export function ItGuide() {
  return (
    <DocPage
      header={<Header />}
      sections={SECTIONS}
      aside={
        <a
          href={POLICY_ZIP}
          className="mt-6 inline-flex items-center gap-1.5 px-3 text-sm font-semibold text-accent hover:underline"
        >
          Policy templates
          <ArrowRight size={14} weight="bold" aria-hidden="true" />
        </a>
      }
    >
      <Guide />
    </DocPage>
  );
}
