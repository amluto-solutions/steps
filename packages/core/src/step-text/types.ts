/** What a step records being done. */
export type StepAction = "click" | "input" | "navigation" | "keypress";

/**
 * What a step knows about the element it was done to: its kind and whatever names it. Saved in
 * each step as `target`, so these field names are part of the guide format. The desktop fills
 * them from UI Automation (`uia-adapter.ts`); the Chrome edition from the page.
 */
export interface StepTarget {
  tagName?: string | undefined;
  elementType?: string | undefined;
  ariaLabel?: string | undefined;
  innerText?: string | undefined;
  placeholder?: string | undefined;
  name?: string | undefined;
  labelText?: string | undefined;
  alt?: string | undefined;
  role?: string | undefined;
  value?: string | undefined;
}

/** What UI Automation reported about an element (camelCase JSON from the Rust capture crate). */
export interface UiaElementFacts {
  controlType: string;
  localizedControlType: string;
  name: string;
  automationId: string;
  helpText: string;
  ariaRole: string;
  ariaProperties: string;
  className: string;
  frameworkId: string;
  isPassword: boolean;
  labeledBy: string | null;
  /**
   * The element's parents, nearest first: up to four, stopping below the window or the web page
   * (docs/spec/02-capture.md#click-naming). A recording made before 06/10/2026 kept one.
   */
  ancestors: readonly UiaAncestor[];
  sensitive: boolean;
}

/** One of an element's parents, as UI Automation or AT-SPI named it. */
export interface UiaAncestor {
  controlType: string;
  name: string;
}
