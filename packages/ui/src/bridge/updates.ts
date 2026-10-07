/**
 * Where this copy gets its updates (docs/spec/10-distribution.md#updates-for-the-exe): only the
 * setup .exe's copy checks; the Store and IT (.msi) update the others.
 */
export type UpdateChannel =
  | "checks"
  | "store"
  | "msi"
  | "policy"
  | "portable"
  /** The portable program in a folder it can't write to, so it can't replace itself. */
  | "readOnly"
  | "none";

/** A newer version found at steps.amluto.com. The notes are plain text, never HTML. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  /** Seconds since 1970. */
  published: number | null;
}

/**
 * Updates (Settings > About), part of the recorder bridge. Only a copy on the "checks" channel
 * finds and installs them; the others say who updates them.
 */
export interface Updates {
  /** Where this copy gets its updates. */
  updatesChannel(): Promise<UpdateChannel>;
  /** Asks steps.amluto.com for a newer version; null: this is the newest. */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Downloads the version the last check found (signature checked) to install at the next start. */
  downloadUpdate(): Promise<string>;
  /** The downloaded version waiting for the next start, if any. */
  pendingUpdate(): Promise<string | null>;
  /**
   * Restart now: installs the downloaded version straight away (its signature checked again); the
   * app closes and the new version opens. Refused while recording.
   */
  installUpdate(): Promise<void>;
}
