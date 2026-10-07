import type { LinkStatus } from "@amluto-steps/ui";

import type { Engine, StartChoices } from "./engine";

/** Commands the Steps pages (the side panel and the app) send the background worker. */
export type Command =
  | { type: "recorder:getState" }
  | { type: "recorder:start"; title: string; choices: StartChoices }
  | { type: "recorder:exclude"; site: string }
  | { type: "recorder:pause" }
  | { type: "recorder:resume" }
  | { type: "recorder:stop" }
  | { type: "recorder:discard" }
  | { type: "recorder:forget"; sessionId: string }
  | { type: "link:get" }
  | { type: "link:set"; on: boolean };

/** The background's side of the link with Steps for Windows (`desktop/link.ts`). */
export interface LinkCommands {
  status(): LinkStatus;
  set(on: boolean): Promise<LinkStatus>;
}

/**
 * Runs a Steps page's command in the background worker: the recorder's on its engine, the link's
 * on the link. Kept apart from the worker's wiring so the recorder bridge's contract tests run
 * the pages' commands as the worker does.
 */
export function runCommands(engine: Engine, link: LinkCommands) {
  return (command: Command): Promise<unknown> => {
    switch (command.type) {
      case "recorder:getState":
        return engine.getState();
      case "recorder:start":
        return engine.start(command.title, command.choices);
      case "recorder:exclude":
        return engine.exclude(command.site);
      case "recorder:pause":
        return engine.pause();
      case "recorder:resume":
        return engine.resume();
      case "recorder:stop":
        return engine.stop();
      case "recorder:discard":
        return engine.discard();
      case "recorder:forget":
        return engine.forgetSession(command.sessionId);
      case "link:get":
        return Promise.resolve(link.status());
      case "link:set":
        return link.set(command.on === true);
    }
  };
}
