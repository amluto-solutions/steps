/** The pages Settings > About links to. */
export type WebPage = "amluto" | "steps" | "source" | "crate" | "npm";

/**
 * Getting help (Settings > About), part of the recorder bridge: the support file, the logs and
 * Amluto's web pages. An edition without support files (the `support` capability) refuses to
 * make one.
 */
export interface Support {
  /**
   * Get help: zips the logs, versions and these settings, with library names and paths, the
   * user's name and profile folder replaced. Saved in app data; nothing is sent.
   */
  createSupportBundle(
    settings: string,
    libraries: { name: string; path: string }[],
    displayName: string,
  ): Promise<{ path: string; files: string[] }>;
  /** Shows a support file in its folder. */
  showSupportBundle(path: string): Promise<void>;
  /**
   * A new email to Amluto support with the support file attached where the mail app allows;
   * otherwise the email, with the file shown in its folder (unless `folderShown`).
   */
  openSupportEmail(path: string, folderShown: boolean): Promise<void>;
  openLogsFolder(): Promise<void>;
  /** amluto.com, or an open-source component's page on crates.io or npm (Settings > About). */
  openWebPage(page: WebPage, name?: string): Promise<void>;
}
