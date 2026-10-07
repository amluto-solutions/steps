/**
 * The parts of Chrome's extension API the recorder bridge uses, kept in memory, for running the
 * bridge contracts against Steps for Chrome's adapter. `background` answers the commands a Steps
 * page sends the background worker; `broadcast` is the worker telling the open pages something.
 */

type Message = Record<string, unknown> & { type?: string };
type Listener = (message: Message, sender: chrome.runtime.MessageSender) => unknown;

export interface FakeChrome {
  /** Pages opened in tabs, by address. */
  readonly tabs: string[];
  /** Files downloaded, by name. */
  readonly downloads: string[];
  /** Whether the person allowed native messaging (the link) when asked. */
  allowNativeMessaging: boolean;
  /** The background worker tells every Steps page something. */
  broadcast(message: Message): void;
}

export function fakeChrome(background: (message: Message) => unknown): FakeChrome {
  const local = new Map<string, unknown>();
  const listeners = new Set<Listener>();
  const tabs: string[] = [];
  const fake: FakeChrome = {
    tabs,
    downloads: [],
    allowNativeMessaging: true,
    broadcast(message) {
      for (const listener of listeners) listener(message, {});
    },
  };
  const api = {
    runtime: {
      id: "steps",
      async sendMessage(message: Message) {
        try {
          return { ok: true, result: await background(message) };
        } catch (error) {
          return { ok: false, error: String(error) };
        }
      },
      onMessage: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
    storage: {
      local: {
        get: (key: string) =>
          Promise.resolve(local.has(key) ? { [key]: structuredClone(local.get(key)) } : {}),
        set: (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) local.set(key, structuredClone(value));
          return Promise.resolve();
        },
      },
      managed: { get: () => Promise.resolve({}) },
    },
    windows: { getCurrent: () => Promise.resolve({ id: 1 }) },
    tabs: {
      create: ({ url }: { url: string }) => {
        tabs.push(url);
        return Promise.resolve({ id: tabs.length });
      },
    },
    permissions: {
      request: () => Promise.resolve(fake.allowNativeMessaging),
      remove: () => Promise.resolve(true),
    },
    sidePanel: { open: () => Promise.resolve() },
  };
  (globalThis as { chrome?: unknown }).chrome = api;
  // The page a download is started from (`files.ts`): a link clicked, its name noted.
  const page = globalThis as unknown as Record<string, unknown>;
  page.window ??= globalThis;
  page.document ??= {
    createElement: () => {
      const link = {
        href: "",
        download: "",
        click: () => fake.downloads.push(link.download),
      };
      return link;
    },
  };
  return fake;
}
