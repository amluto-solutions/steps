import { z } from "zod";

/**
 * Password locks on guides (docs/spec/03-data-and-sharing.md#password-locks, 04/10/2026).
 *
 * A locked guide can be viewed, exported, duplicated, copied and merged, but not changed, moved
 * or deleted in Steps without its password. The lock works inside Steps only: the guide's files
 * can still be changed outside it, and Steps says so. Two files sit in the guide's folder beside
 * `guide.json`, and neither is copied with the guide (Duplicate, Copy to, Merge, `.amlsteps`):
 * `password-lock.json` (this lock) and `history.json` (Properties: saves, who saved last, lock
 * events). Moving a guide takes both; the Bin takes the lock off.
 */

export const GUIDE_LOCK_FILE = "password-lock.json";
export const GUIDE_HISTORY_FILE = "history.json";

/** OWASP's figure for PBKDF2-HMAC-SHA256 (2023): about a third of a second here. */
export const PASSWORD_ITERATIONS = 600_000;
export const MIN_PASSWORD_LENGTH = 6;
export const MAX_PASSWORD_LENGTH = 200;

/** Wrong passwords allowed for a guide before a wait, and the wait. */
export const GUESSES_BEFORE_WAIT = 10;
export const GUESS_WAIT_MS = 30_000;

const text = (max: number) => z.string().max(max);
const iso = z.string().max(40);

/** Who did something, and where: the PC and Windows login only when recording them is on. */
export const whoSchema = z.object({
  by: text(200),
  login: text(200).default(""),
  pc: text(200).default(""),
  at: iso,
});
export type Who = z.infer<typeof whoSchema>;

/** `password-lock.json`. */
export const guideLockSchema = z.object({
  formatVersion: z.literal(1),
  locked: whoSchema,
  /** `pbkdf2-sha256$<iterations>$<salt, base64>$<hash, base64>`; never the password itself. */
  password: text(400),
});
export type GuideLock = z.infer<typeof guideLockSchema>;

export const historyEventSchema = whoSchema.extend({
  kind: z.enum(["locked", "passwordChanged", "lockRemoved", "unlockedWithRecovery", "binned"]),
});
export type HistoryEvent = z.infer<typeof historyEventSchema>;

/** `history.json`: what Properties shows beyond the guide's own dates. */
export const guideHistorySchema = z.object({
  formatVersion: z.literal(1),
  /** Editing sessions that changed the guide, counted from 1.0 (earlier ones weren't). */
  saves: z.number().int().nonnegative().max(1_000_000_000).default(0),
  created: whoSchema.nullable().default(null),
  lastSaved: whoSchema.nullable().default(null),
  events: z.array(historyEventSchema).max(200).default([]),
});
export type GuideHistory = z.infer<typeof guideHistorySchema>;

export const emptyHistory = (): GuideHistory => ({
  formatVersion: 1,
  saves: 0,
  created: null,
  lastSaved: null,
  events: [],
});

/** A lock file as read, or null when there's none or it can't be understood. */
export function parseGuideLock(value: unknown): GuideLock | null {
  const parsed = guideLockSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function parseGuideHistory(value: unknown): GuideHistory {
  const parsed = guideHistorySchema.safeParse(value);
  return parsed.success ? parsed.data : emptyHistory();
}

/** Keeps the newest events when the list is full. */
export function withEvent(history: GuideHistory, event: HistoryEvent): GuideHistory {
  return { ...history, events: [...history.events, event].slice(-200) };
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * A password as stored: PBKDF2-HMAC-SHA256 with a random 16-byte salt. The same form IT makes
 * for the recovery password with PowerShell's `Rfc2898DeriveBytes` (docs/it/guide-locks.md).
 */
export async function hashPassword(
  password: string,
  iterations = PASSWORD_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Whether `password` matches a stored one; false for anything malformed. */
export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parts = /^pbkdf2-sha256\$(\d{1,8})\$([A-Za-z0-9+/=]{4,200})\$([A-Za-z0-9+/=]{4,200})$/.exec(
    stored.trim(),
  );
  if (!parts?.[1] || !parts[2] || !parts[3]) return false;
  const iterations = Number(parts[1]);
  if (iterations < 1_000) return false;
  let salt: Uint8Array<ArrayBuffer>;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  const actual = await derive(password, salt, iterations);
  // Compared in full whatever differs, so the time taken says nothing.
  let difference = actual.length ^ expected.length;
  for (let index = 0; index < actual.length; index += 1)
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  return difference === 0;
}

/** Why a new password can't be used, or null when it can. */
export function passwordProblem(password: string): "short" | "long" | null {
  if ([...password].length < MIN_PASSWORD_LENGTH) return "short";
  if ([...password].length > MAX_PASSWORD_LENGTH) return "long";
  return null;
}

/**
 * Wrong passwords per guide: after 10, each further try waits 30 seconds after the last wrong
 * one. Kept while the app runs; a right password clears it.
 */
export class GuessLimit {
  private readonly wrong = new Map<string, { count: number; last: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** How long before `key` may be tried again, in milliseconds (0: now). */
  waitFor(key: string): number {
    const entry = this.wrong.get(key);
    if (!entry || entry.count < GUESSES_BEFORE_WAIT) return 0;
    return Math.max(0, entry.last + GUESS_WAIT_MS - this.now());
  }

  failed(key: string) {
    const entry = this.wrong.get(key);
    this.wrong.set(key, { count: (entry?.count ?? 0) + 1, last: this.now() });
  }

  succeeded(key: string) {
    this.wrong.delete(key);
  }
}
