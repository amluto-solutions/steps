import type { Support, WebPage } from "./support";

export interface FakeSupport extends Support {
  /** Every web page opened, in order. */
  readonly pagesOpened: { page: WebPage; name: string | undefined }[];
}

/**
 * Getting help for tests and the preview. With `support` (the desktop's), a support file is
 * "made" in app data and can be shown and emailed; without (Steps for Chrome's), making one is
 * refused. Opening a page only notes it.
 */
export function fakeSupport(options: { support?: boolean } = {}): FakeSupport {
  const support = options.support ?? true;
  const pagesOpened: FakeSupport["pagesOpened"] = [];
  return {
    pagesOpened,
    createSupportBundle: () =>
      support
        ? Promise.resolve({
            path: "C:\\Users\\Example\\AppData\\Roaming\\Amluto\\Steps\\support\\steps-support.zip",
            files: ["settings.json", "versions.txt", "logs/steps.log"],
          })
        : Promise.reject(new Error("Not available in Steps for Chrome.")),
    showSupportBundle: () => Promise.resolve(),
    openSupportEmail: () => Promise.resolve(),
    openLogsFolder: () => Promise.resolve(),
    openWebPage(page, name) {
      pagesOpened.push({ page, name });
      return Promise.resolve();
    },
  };
}
