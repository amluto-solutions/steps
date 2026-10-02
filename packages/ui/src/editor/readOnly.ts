import { createContext } from "react";

/**
 * Whether the open guide is read-only because someone else is editing it: the text editors stop
 * taking typing (edits are refused centrally too, in useGuideEditor).
 */
export const ReadOnlyContext = createContext(false);
