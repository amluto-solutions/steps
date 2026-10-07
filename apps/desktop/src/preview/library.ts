import {
  fakeLibrary,
  type FakeComment,
  type LibraryBridge,
  type RawGuideDocument,
} from "@amluto-steps/ui";

/*
 * The preview's made-up library (`/preview.html` on the Vite dev server): no Tauri, no files.
 * Every guide, name and screenshot here is invented.
 */

export const PREVIEW_LIBRARY_ID = "preview-library";
export const PREVIEW_TEAM_ID = "preview-team";
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

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

const guides: RawGuideDocument[] = SAMPLES.map((sample) => ({
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
}));

/**
 * A plain drawn "app window", so the editor has a picture to show, with the two made-up personal
 * details the preview's text reader reports (`recorder.ts`). Base64, as the app's own screenshots
 * are, so they can be read.
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

/** Review comments on the samples: who wrote them, and on which step. */
const SAMPLE_COMMENTS: Record<string, FakeComment[]> = {
  "holiday-request": [
    {
      id: "c1",
      text: "The Time off tab moved under My HR in the October update.",
      by: "Alex Example",
      at: daysAgo(1),
      stepId: "holiday-request-1",
      replyTo: null,
      resolved: null,
    },
  ],
};

const MB = 1024 ** 2;
/** A made-up size for each guide in browser storage, the same each time. */
const previewSize = (id: string) =>
  ([...id].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 400) * MB;

/**
 * The preview's library: the UI package's fake library (`fakeLibrary`), kept while the page is
 * open, with the sample guides and a second, shared library so Move to, Copy to and Save as have
 * somewhere to go. Every sample step shows the drawn window above, and Retake waits out its
 * countdown and shows it again. The page's query adds the Steps for Chrome states:
 * - `?storage`: the library as Steps for Chrome sees it when browser storage is filling, with
 *   each guide's size, the warning banner and Export and remove
 *   (docs/spec/03-data-and-sharing.md#chrome-edition-storage);
 * - `?access`: a shared folder after a browser restart, before the person has allowed Steps into
 *   it again (docs/spec/03-data-and-sharing.md#shared-libraries-in-steps-for-chrome).
 */
export function previewLibraryFor(query: URLSearchParams): LibraryBridge {
  const fake = fakeLibrary({
    me: "Sam Example",
    libraries: [
      { id: PREVIEW_LIBRARY_ID, name: "My guides", path: "C:\\Guides", guides },
      {
        id: PREVIEW_TEAM_ID,
        name: "Finance team",
        path: "C:\\Users\\Robin\\Contoso\\Finance team - Documents",
        synced: true,
      },
    ],
  });
  const own = fake.data.libraries.get(PREVIEW_LIBRARY_ID);
  for (const guide of own?.guides.values() ?? []) {
    guide.media.set("shot", { width: 1280, height: 800, url: SCREENSHOT });
    guide.comments = structuredClone(SAMPLE_COMMENTS[String(guide.guide.id)] ?? []);
  }

  const browserStorage = query.has("storage");
  let needsAccess = query.has("access");
  const folderAccess = () =>
    Promise.reject(Object.assign(new Error("Shared guides"), { code: "folderAccess" }));

  const library: LibraryBridge = {
    ...fake,
    allowAccess: () => {
      needsAccess = false;
      return Promise.resolve(true);
    },
    listLibraries: async () =>
      (await fake.listLibraries()).map((info) =>
        needsAccess && info.id === PREVIEW_LIBRARY_ID
          ? {
              ...info,
              name: "Shared guides",
              path: "Shared guides",
              synced: true,
              guideCount: 0,
              needsAccess: true,
            }
          : info,
      ),
    listGuides: async (libraryId) => {
      if (needsAccess && libraryId === PREVIEW_LIBRARY_ID) return folderAccess();
      const listed = await fake.listGuides(libraryId);
      return browserStorage
        ? listed.map((guide) => ({ ...guide, sizeBytes: previewSize(guide.id) }))
        : listed;
    },
    // Retake can't capture anything here; it waits out the countdown and shows the drawn window.
    retakeImage: async (libraryId, guideId, delayMs, excluded) => {
      await new Promise((resolve) => window.setTimeout(resolve, delayMs));
      const taken = await fake.retakeImage(libraryId, guideId, delayMs, excluded);
      const picture = fake.data.libraries.get(libraryId)?.guides.get(guideId)?.media.get(taken.id);
      if (picture) picture.url = SCREENSHOT;
      return taken;
    },
    guideStats: () => Promise.resolve({ pictures: 4, bytes: 812_000 }),
  };
  if (!browserStorage) return library;
  return {
    ...library,
    storageUse: async (libraryId) => {
      const guidesThere = await fake.listGuides(libraryId);
      return {
        libraryBytes: guidesThere.reduce((sum, guide) => sum + previewSize(guide.id), 900 * MB),
        usedBytes: 2 * 1024 * MB,
        quotaBytes: 60 * 1024 * MB,
      };
    },
    pickExportFolder: () => Promise.resolve("preview-folder"),
    exportAndRemove: async (libraryId, guideId) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      const { title } = (await fake.listGuides(libraryId)).find((each) => each.id === guideId) ?? {
        title: guideId,
      };
      fake.data.libraries.get(libraryId)?.guides.delete(guideId);
      return `${title}.amlsteps`;
    },
  };
}

export const previewLibrary = previewLibraryFor(new URLSearchParams(window.location.search));
