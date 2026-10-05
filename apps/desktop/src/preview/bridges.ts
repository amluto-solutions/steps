import type {
  CommentThread,
  LibraryBridge,
  LibraryGuideSummary,
  RawGuideDocument,
  RecorderBridge,
  RecorderSnapshot,
} from "@amluto-steps/ui";

/**
 * Made-up bridges for looking at the UI in a plain browser (`/preview.html` on the Vite dev
 * server): no Tauri, no files, nothing recorded. Every guide, name and screenshot here is
 * invented. Methods not listed resolve to nothing and log, so a screen that needs one shows it.
 */

const LIBRARY_ID = "preview-library";
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

const SNAPSHOT: RecorderSnapshot = {
  state: "idle",
  reason: null,
  sessionId: null,
  stepCount: 0,
  missedCount: 0,
  inputSource: "rawInput",
  keysRecorded: false,
};

interface SampleStep {
  text: string;
  note?: string;
  action?: string;
  code?: { text: string; language: string; output: string | null; outputShortened: boolean };
}

const SAMPLES: Array<{
  id: string;
  title: string;
  tags: string[];
  age: number;
  steps: SampleStep[];
}> = [
  {
    id: "add-supplier",
    title: "Add a new supplier",
    tags: ["Finance"],
    age: 0,
    steps: [
      { text: 'Click "Contacts" Menu' },
      { text: 'Click "New supplier" Button' },
      { text: 'Type in "Supplier name" field', action: "input" },
      { text: 'Click "Save invoice details" Button', note: "Ask the finance team first." },
    ],
  },
  {
    id: "mailbox-access",
    title: "Give Anna access to the Sales mailbox",
    tags: ["IT support"],
    age: 0,
    steps: [
      { text: 'Open "Windows PowerShell"', action: "appswitch" },
      {
        text: "Run in PowerShell",
        action: "command",
        code: {
          text: "Connect-ExchangeOnline -UserPrincipalName admin@contoso.co.uk",
          language: "powershell",
          output: null,
          outputShortened: false,
        },
      },
      {
        text: "Run in PowerShell",
        action: "command",
        code: {
          text: 'Add-MailboxPermission -Identity "sales@contoso.co.uk" -User "anna@contoso.co.uk" -AccessRights FullAccess -AutoMapping $true',
          language: "powershell",
          output:
            "Identity   User           AccessRights   IsInherited   Deny\n" +
            "--------   ----           ------------   -----------   ----\n" +
            "Sales      CONTOSO\\anna   {FullAccess}   False         False",
          outputShortened: false,
        },
      },
      {
        text: "Run in PowerShell",
        action: "command",
        code: {
          text: "New-LocalUser -Name temp -Password ••••",
          language: "powershell",
          output: null,
          outputShortened: false,
        },
      },
      { text: 'Press "Ctrl + L"', action: "keypress" },
      {
        text: "Type the formula in cell B6",
        action: "formula",
        code: { text: "=SUM(B2:B5)", language: "excel", output: null, outputShortened: false },
      },
    ],
  },
  {
    id: "holiday-request",
    title: "Submit a holiday request",
    tags: ["Onboarding"],
    age: 1,
    steps: [
      { text: 'Click "Time off" Tab' },
      { text: 'Click "Request leave" Button' },
      { text: 'Click "Submit" Button' },
    ],
  },
  {
    id: "meeting-room",
    title: "Book a meeting room",
    tags: ["IT support"],
    age: 3,
    steps: [
      { text: 'Click "Calendar" Icon' },
      { text: 'Click "Rooms" Link', note: "Large rooms need approval." },
    ],
  },
  {
    id: "expense-claim",
    title: "Approve an expense claim",
    tags: ["Finance"],
    age: 9,
    steps: [{ text: 'Click "Approvals" Menu' }, { text: 'Click "Approve" Button' }],
  },
];

const paragraph = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const guides = new Map<string, RawGuideDocument>(
  SAMPLES.map((sample) => [
    sample.id,
    {
      guide: {
        id: sample.id,
        title: sample.title,
        description: "",
        intro: null,
        outro: null,
        brandProfileId: null,
        tags: sample.tags,
        owner: "Sam Example",
        reviewBy: null,
        createdAt: daysAgo(sample.age),
        createdBy: "Sam Example",
        updatedAt: daysAgo(sample.age),
        updatedBy: "Sam Example",
        formatVersion: 1,
      },
      steps: sample.steps.map((step, index) => ({
        id: `${sample.id}-${index + 1}`,
        sortKey: String(index + 1).padStart(4, "0"),
        kind: "interaction",
        action: step.action ?? "click",
        actionText: step.text,
        textParts: { verb: "Click", target: step.text, kind: "" },
        showValue: false,
        textEdited: false,
        notes: step.note ? paragraph(step.note) : null,
        altText: null,
        context: { app: "example.exe", windowTitle: "Example app" },
        target: null,
        media: { id: "shot", width: 1280, height: 800, scale: 1, captureRect: null },
        highlight: { shape: "box", x: 30 + index * 12, y: 30 + index * 10, w: 16, h: 7 },
        crop: null,
        redactions: [],
        annotations: [],
        block: null,
        ...(step.code ? { code: step.code } : {}),
        capturedAt: daysAgo(sample.age),
        updatedAt: daysAgo(sample.age),
        updatedBy: "Sam Example",
        formatVersion: 1,
      })),
    },
  ]),
);

/**
 * A plain drawn "app window", so the editor has a picture to show, with the two made-up personal
 * details that `readText` reports. Base64, as the app's own screenshots are, so they can be read.
 */
const SCREENSHOT = `data:image/svg+xml;base64,${btoa(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="800" viewBox="0 0 1280 800">
  <rect width="1280" height="800" fill="#f4f6f9"/><rect width="1280" height="64" fill="#13365d"/>
  <rect x="32" y="22" width="120" height="20" rx="10" fill="#48cdeb"/>
  <rect width="220" height="736" y="64" fill="#ffffff"/>
  <rect x="260" y="104" width="420" height="28" rx="6" fill="#0e2542"/>
  <rect x="260" y="160" width="900" height="16" rx="8" fill="#dfe5ec"/>
  <rect x="260" y="196" width="760" height="16" rx="8" fill="#dfe5ec"/>
  <rect x="1020" y="96" width="200" height="44" rx="8" fill="#1e6ebc"/>
  <text x="768" y="258" font-family="sans-serif" font-size="18" fill="#0e2542">sam@example.com</text>
  <text x="896" y="514" font-family="sans-serif" font-size="18" fill="#0e2542">SW1A 1AA</text></svg>`,
)}`;

/** Review comments, kept only while the page is open. */
const comments = new Map<string, CommentThread[]>([
  [
    "holiday-request",
    [
      {
        id: "c1",
        text: "The Time off tab moved under My HR in the October update.",
        by: "Alex Example",
        at: daysAgo(1),
        mine: false,
        stepId: "holiday-request-1",
        replies: [],
        resolved: null,
      },
    ],
  ],
]);
let commentCount = 1;
/** Each guide's password lock and history (password locks, 04/10/2026), kept while the page is open. */
const guideMeta = new Map<string, { lock: unknown; history: unknown }>();
const metaOf = (guideId: string) => {
  const found = guideMeta.get(guideId) ?? { lock: null, history: null };
  guideMeta.set(guideId, found);
  return found;
};
const lockedOf = (guideId: string) => {
  const locked = (metaOf(guideId).lock as { locked?: { by: string; at: string } } | null)?.locked;
  return locked ? { locked: { by: locked.by, at: locked.at } } : {};
};

const summary = (document: RawGuideDocument): LibraryGuideSummary => {
  const guide = document.guide as Record<string, unknown>;
  return {
    ...lockedOf(String(guide.id)),
    id: String(guide.id),
    title: String(guide.title),
    updatedAt: String(guide.updatedAt),
    stepCount: document.steps.length,
    tags: guide.tags as string[],
    owner: String(guide.owner),
    reviewBy: null,
    thumbnailMediaId: "shot",
    openComments: (comments.get(String(guide.id)) ?? []).filter((thread) => !thread.resolved)
      .length,
    ...(browserStorage ? { sizeBytes: previewSize(String(guide.id)) } : {}),
  };
};

/** Fills in any method not given, so the preview only lists what it actually fakes. */
function withFallback<T extends object>(name: string, known: Partial<Record<keyof T, unknown>>): T {
  return new Proxy(known, {
    get(target, property) {
      if (property in target) return target[property as keyof typeof target];
      if (typeof property !== "string") return undefined;
      if (property.startsWith("on")) return () => Promise.resolve(() => undefined);
      return (...args: unknown[]) => {
        console.info(`[preview] ${name}.${property}`, args);
        return Promise.resolve(undefined);
      };
    },
  }) as T;
}

/** The recording bar part-way through a recording (`/preview.html?recorder-bar&keys&paused`). */
export const previewBarRecorder = (options: { keys: boolean; paused: boolean }) =>
  withFallback<RecorderBridge>("bar", {
    getState: () =>
      Promise.resolve({
        ...SNAPSHOT,
        state: options.paused ? "paused" : "recording",
        reason: options.paused ? "User" : null,
        sessionId: "preview",
        stepCount: 14,
        keysRecorded: options.keys,
      }),
  });

/** The link with Steps for Chrome and Edge: Chrome connected while it's on. */
let link = {
  available: true,
  enabled: true,
  connected: ["chrome"],
  problem: null as string | null,
};

export const previewRecorder = withFallback<RecorderBridge>("recorder", {
  getLink: () => Promise.resolve(link),
  setLink: (on: boolean | null) => {
    const enabled = on ?? true;
    link = { ...link, enabled, connected: enabled ? ["chrome"] : [] };
    return Promise.resolve(link);
  },
  onLink: () => Promise.resolve(() => undefined),
  getPolicy: () => Promise.reject(new Error("no policy in the preview")),
  // The preview shows the About screen of a copy that updates, with nothing new to install.
  updatesChannel: () => Promise.resolve("checks"),
  checkForUpdate: () => Promise.resolve(null),
  pendingUpdate: () => Promise.resolve(null),
  getState: () => Promise.resolve(SNAPSHOT),
  getPreferences: () =>
    Promise.resolve({ displayName: "Sam Example", libraryFolder: "C:\\Guides" }),
  setPreferences: (preferences: unknown) => Promise.resolve(preferences),
  getRecoveries: () => Promise.resolve([]),
  isAutoStartEnabled: () => Promise.resolve(false),
  getMonitors: () => Promise.resolve([]),
  listBrands: () => Promise.resolve([]),
  getHotkeys: () => Promise.resolve([]),
  suspendHotkeys: () => Promise.resolve([]),
  // Two made-up personal details on every screenshot, so the suggested blurs can be seen: a small
  // email and a postcode. `?many-suggestions` adds fourteen more emails, for a long list.
  readText: () =>
    Promise.resolve([
      { words: [{ text: "sam@example.com", x: 60, y: 30, w: 12, h: 2.5 }] },
      {
        words: [
          { text: "SW1A", x: 70, y: 62, w: 3.5, h: 2.5 },
          { text: "1AA", x: 74, y: 62, w: 3, h: 2.5 },
        ],
      },
      ...(new URLSearchParams(window.location.search).has("many-suggestions")
        ? Array.from({ length: 14 }, (_, index) => ({
            words: [
              { text: `person${index}@example.com`, x: 30, y: 10 + index * 5, w: 14, h: 2.5 },
            ],
          }))
        : []),
    ]),
});

/**
 * `?storage`: the library as Steps for Chrome sees it when browser storage is filling, with each
 * guide's size, the warning banner and Export and remove (docs/spec/03-data-and-sharing.md).
 */
const browserStorage = new URLSearchParams(window.location.search).has("storage");
const MB = 1024 ** 2;
const previewSize = (id: string) =>
  ([...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 400) * MB;
const storageMethods: Partial<LibraryBridge> = browserStorage
  ? {
      storageUse: () =>
        Promise.resolve({
          libraryBytes: [...guides.keys()].reduce((sum, id) => sum + previewSize(id), 0) + 900 * MB,
          usedBytes: 2 * 1024 * MB,
          quotaBytes: 60 * 1024 * MB,
        }),
      pickExportFolder: () => Promise.resolve("preview-folder"),
      exportAndRemove: async (_libraryId, guideId) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        const guide = guides.get(guideId)?.guide as { title?: string } | undefined;
        const title = guide?.title ?? guideId;
        guides.delete(guideId);
        return `${title}.amlsteps`;
      },
    }
  : {};

/**
 * `?access`: a shared folder in Steps for Chrome after a browser restart, before the person has
 * allowed Steps into it again (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
 */
let needsAccess = new URLSearchParams(window.location.search).has("access");

export const previewLibrary = withFallback<LibraryBridge>("library", {
  ...storageMethods,
  allowAccess: () => {
    needsAccess = false;
    return Promise.resolve(true);
  },
  openFolder: () => Promise.resolve(),
  guideMeta: (_libraryId: string, guideId: string) => Promise.resolve({ ...metaOf(guideId) }),
  writeGuideLock: (_libraryId: string, guideId: string, lock: unknown) => {
    metaOf(guideId).lock = lock;
    return Promise.resolve();
  },
  writeGuideHistory: (_libraryId: string, guideId: string, history: unknown) => {
    metaOf(guideId).history = history;
    return Promise.resolve();
  },
  guideStats: () => Promise.resolve({ pictures: 4, bytes: 812_000 }),
  listLibraries: () =>
    Promise.resolve([
      {
        id: LIBRARY_ID,
        name: needsAccess ? "Shared guides" : "My guides",
        path: needsAccess ? "Shared guides" : "C:\\Guides",
        isDefault: true,
        managed: false,
        synced: needsAccess,
        guideCount: needsAccess ? 0 : guides.size,
        ...(needsAccess ? { needsAccess: true } : {}),
      },
      // A second, shared library, so Move to, Copy to and Save as have somewhere to go.
      {
        id: "preview-team",
        name: "Finance team",
        path: "C:\\Users\\Robin\\Contoso\\Finance team - Documents",
        isDefault: false,
        managed: false,
        synced: true,
        guideCount: 0,
      },
    ]),
  listGuides: () =>
    needsAccess
      ? Promise.reject(Object.assign(new Error("Shared guides"), { code: "folderAccess" }))
      : Promise.resolve([...guides.values()].map(summary)),
  listTrash: () => Promise.resolve([]),
  // The same rule as the Rust search: every word somewhere in the card or the wording.
  searchGuides: (_libraryId: string, query: string) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return Promise.resolve(
      [...guides.values()].flatMap((document) => {
        const card = summary(document);
        const cardText = `${card.title} ${card.tags.join(" ")} ${card.owner}`.toLowerCase();
        const passages = document.steps.map((step, index) => {
          const { actionText, notes } = step as { actionText: string; notes: unknown };
          return { number: index + 1, text: `${actionText} ${JSON.stringify(notes ?? "")}` };
        });
        const all = `${cardText} ${passages.map((passage) => passage.text).join(" ")}`;
        if (!words.every((word) => all.toLowerCase().includes(word))) return [];
        const word = words.find((each) => !cardText.includes(each));
        const found = word
          ? passages.find((passage) => passage.text.toLowerCase().includes(word))
          : undefined;
        return [
          {
            guideId: card.id,
            foundIn: found
              ? {
                  stepNumber: found.number,
                  snippet: (document.steps[found.number - 1] as { actionText: string }).actionText,
                }
              : null,
          },
        ];
      }),
    );
  },
  loadGuide: (_libraryId: string, guideId: string) => {
    const document = guides.get(guideId);
    return document ? Promise.resolve(document) : Promise.reject(new Error("not found"));
  },
  loadImage: () => Promise.resolve(SCREENSHOT),
  // Retake can't capture anything here; it waits out the countdown and reuses the drawn window.
  retakeImage: (_libraryId: string, _guideId: string, delayMs: number) =>
    new Promise((resolve) =>
      window.setTimeout(() => resolve({ id: "shot", width: 1280, height: 800 }), delayMs),
    ),
  saveGuide: () => Promise.resolve(),
  saveStep: () => Promise.resolve(),
  listVersions: () => Promise.resolve([]),
  openForEditing: () => Promise.resolve({ kind: "editing" }),
  listDrafts: () => Promise.resolve([]),
  listConflicts: () => Promise.resolve([]),
  listComments: (_libraryId: string, guideId: string) =>
    Promise.resolve(structuredClone(comments.get(guideId) ?? [])),
  addComment: (
    _libraryId: string,
    guideId: string,
    stepId: string | null,
    replyTo: string | null,
    text: string,
  ) => {
    commentCount += 1;
    const comment = {
      id: `c${commentCount}`,
      text,
      by: "Sam Example",
      at: new Date().toISOString(),
      mine: true,
    };
    const threads = comments.get(guideId) ?? [];
    const thread = threads.find((found) => found.id === replyTo);
    if (thread) thread.replies.push(comment);
    else threads.push({ ...comment, stepId, replies: [], resolved: null });
    comments.set(guideId, threads);
    return Promise.resolve(comment.id);
  },
  resolveComment: (_libraryId: string, guideId: string, id: string, resolved: boolean) => {
    const thread = comments.get(guideId)?.find((found) => found.id === id);
    if (thread)
      thread.resolved = resolved ? { by: "Sam Example", at: new Date().toISOString() } : null;
    return Promise.resolve();
  },
  deleteComment: (_libraryId: string, guideId: string, id: string) => {
    const threads = (comments.get(guideId) ?? [])
      .filter((thread) => thread.id !== id)
      .map((thread) => ({ ...thread, replies: thread.replies.filter((reply) => reply.id !== id) }));
    comments.set(guideId, threads);
    return Promise.resolve();
  },
});
