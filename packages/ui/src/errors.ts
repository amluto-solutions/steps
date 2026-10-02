import i18n from "i18next";

/** The `code` of a Rust command error, if it has one. */
export const errorCode = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;

const rawMessage = (error: unknown): string =>
  error instanceof Error
    ? error.message
    : typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
      ? error.message
      : "";

/**
 * The message to show for a failed command. Tauri rejects with the Rust error object
 * (`{ code, message }`); its code picks the words from en.json (`errors.<code>`), so all text
 * the user reads comes from there. The Rust message is only used as `{{detail}}` where it names
 * something specific. An unknown code, or anything else, gets `fallback`.
 */
export const errorMessage = (error: unknown, fallback: string): string => {
  const code = errorCode(error) ?? (error instanceof Error ? error.message : null);
  const key = code ? `errors.${code}` : null;
  if (key && i18n.exists(key)) return i18n.t(key, { detail: rawMessage(error) });
  if (rawMessage(error)) console.warn(`Shown as "${fallback}":`, rawMessage(error));
  return fallback;
};
