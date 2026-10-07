import type { Capabilities } from "../../capabilities";

/**
 * What a contract test runs against: one edition's version of a small bridge interface, and the
 * capabilities that edition states, since what an interface must do can depend on them (an
 * edition without shortcuts answers with none).
 */
export interface Subject<Part> {
  part: Part;
  capabilities: Capabilities;
}

/** A fresh subject for each test, so one test's changes can't reach the next. */
export type MakeSubject<Part> = () => Subject<Part> | Promise<Subject<Part>>;
