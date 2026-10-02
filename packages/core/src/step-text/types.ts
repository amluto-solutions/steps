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
  parent: { controlType: string; name: string } | null;
  sensitive: boolean;
}
