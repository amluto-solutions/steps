// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { initI18n } from "../i18n";
import { confetti } from "./confetti";
import { TOUR_STEPS } from "./steps";
import { readTour, startTourAfterWelcome, writeTour } from "./store";
import { TourProvider, useTour } from "./TourProvider";

initI18n();
// jsdom has no canvas; the burst itself is left to the live check.
vi.mock("./confetti", () => ({ confetti: vi.fn() }));

// jsdom has no layout: anything the tour points at gets a box, so it counts as on screen.
const box = {
  left: 300,
  top: 100,
  width: 120,
  height: 36,
  right: 420,
  bottom: 136,
  x: 300,
  y: 100,
};
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return (
      this.hasAttribute("data-tour") ? { ...box, toJSON: () => box } : new DOMRect()
    ) as DOMRect;
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    return (this.hasAttribute("data-tour") ? [box] : []) as unknown as DOMRectList;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The guides screen, without an Export button: there are no guides yet. */
function Guides() {
  return (
    <div>
      {["record", "guides", "search", "import", "views", "bin", "settings"].map((id) => (
        <button key={id} type="button" data-tour={id}>
          {id}
        </button>
      ))}
    </div>
  );
}

function Settings() {
  const tour = useTour();
  return (
    <div>
      <button type="button" onClick={tour.start}>
        start again
      </button>
      <span data-testid="progress">{tour.progress ?? "none"}</span>
    </div>
  );
}

function renderTour(place = "guides") {
  const onGo = vi.fn();
  const view = (at: string) => (
    <TourProvider enabled place={at} onGo={onGo} firstName="Robin">
      {at === "guides" ? <Guides /> : <Settings />}
    </TourProvider>
  );
  const result = render(view(place));
  return { onGo, go: (at: string) => result.rerender(view(at)) };
}

const card = () => screen.findByTestId("tour-card");
const title = async () => (await card()).querySelector("h2")?.textContent;
const press = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const stepTitle = (index: number) => {
  const words: Record<string, string> = {
    record: "Record a task",
    guides: "Your guides",
    search: "Find any guide",
    import: "Guides from other people",
    views: "Find your way around",
    bin: "Nothing goes by accident",
    settings: "Settings",
  };
  return words[TOUR_STEPS[index]?.id ?? ""];
};

describe("the product tour", () => {
  it("isn't offered on a PC that had the app before the tour existed", async () => {
    renderTour();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("tour-card")).toBeNull();
  });

  it("greets someone just welcomed, and steps through with Next, Back and the arrow keys", async () => {
    startTourAfterWelcome();
    renderTour();
    expect(await title()).toBe("Welcome to Steps, Robin");
    await expectNoSeriousAxeViolations(document.body);
    press("Start the tour");
    await waitFor(async () => expect(await title()).toBe(stepTitle(0)));
    expect((await card()).textContent).toContain("Step 1 of 8");
    expect(screen.getByTestId("tour-spotlight")).toBeTruthy();
    // Enter carries on: the main button has the focus.
    expect(document.activeElement?.textContent).toBe("Next");
    press("Next");
    await waitFor(async () => expect(await title()).toBe(stepTitle(1)));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowLeft" });
    await waitFor(async () => expect(await title()).toBe(stepTitle(0)));
    expect(readTour()).toEqual({ status: "active", step: "record" });
    await expectNoSeriousAxeViolations(document.body);
  });

  it("shows a step whose control isn't on screen in the middle, rather than skipping it (F008)", async () => {
    writeTour({ status: "active", step: "search" });
    renderTour();
    expect(await title()).toBe("Find any guide");
    press("Next");
    // No guides, so no Export button: after a moment its card shows anyway, and Next goes on.
    await waitFor(async () => expect(await title()).toBe("Share it your way"), {
      timeout: 4_000,
    });
    // With nothing to click, it doesn't ask the person to try it.
    expect(screen.getByTestId("tour-card").textContent).not.toContain("Try it");
    press("Next");
    await waitFor(async () => expect(await title()).toBe("Guides from other people"), {
      timeout: 4_000,
    });
  });

  it("shrinks to the Tour pill on Esc, and carries on from it", async () => {
    writeTour({ status: "active", step: "guides" });
    renderTour();
    await card();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    const pill = await screen.findByTestId("tour-pill");
    expect(screen.queryByTestId("tour-card")).toBeNull();
    expect(pill.textContent).toContain("2 of 8");
    expect(readTour()).toEqual({ status: "paused", step: "guides" });
    press("Continue the tour, step 2 of 8");
    expect(await title()).toBe("Your guides");
    expect(screen.queryByTestId("tour-pill")).toBeNull();
  });

  it("pauses when someone goes to another screen, and the pill's ✕ hides it for now", async () => {
    writeTour({ status: "active", step: "record" });
    const { go } = renderTour();
    await card();
    act(() => go("editor"));
    await screen.findByTestId("tour-pill");
    expect(readTour().status).toBe("paused");
    press("Hide the Tour button for now");
    expect(screen.queryByTestId("tour-pill")).toBeNull();
  });

  it("asks before ending, and says where to turn it back on", async () => {
    writeTour({ status: "active", step: "record" });
    renderTour();
    await card();
    press("End tour");
    expect(await title()).toBe("End the tour?");
    expect(document.activeElement?.textContent).toBe("Keep going");
    press("Keep going");
    expect(await title()).toBe("Record a task");
    press("End tour");
    fireEvent.click(screen.getAllByRole("button", { name: "End tour" }).at(-1) as HTMLElement);
    expect(await title()).toBe("Turn it back on any time");
    expect(readTour()).toEqual({ status: "off", step: null });
    press("Got it");
    await waitFor(() => expect(screen.queryByTestId("tour-card")).toBeNull());
  });

  it("finishes after the last step", async () => {
    writeTour({ status: "active", step: "settings" });
    renderTour();
    expect(await title()).toBe("Settings");
    press("Finish");
    expect(await title()).toBe("You’re all set");
    expect(confetti).toHaveBeenCalledTimes(1);
    expect(readTour()).toEqual({ status: "finished", step: null });
    press("Finish");
    await waitFor(() => expect(screen.queryByTestId("tour-card")).toBeNull());
  });

  it("starts again from Settings, and goes to the guides for its first step", async () => {
    writeTour({ status: "finished", step: null });
    const { onGo } = renderTour("settings:general");
    expect(screen.getByTestId("progress").textContent).toBe("none");
    press("start again");
    expect(await title()).toBe("Welcome to Steps, Robin");
    press("Start the tour");
    expect(onGo).toHaveBeenCalledWith("guides");
  });

  it("waits, untouched, in a window narrower than 1024 pixels", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 });
    writeTour({ status: "paused", step: "search" });
    renderTour();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("tour-pill")).toBeNull();
    expect(readTour()).toEqual({ status: "paused", step: "search" });
  });
});
