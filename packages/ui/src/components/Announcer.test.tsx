// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AnnouncerProvider, useAnnounce } from "./Announcer";

afterEach(cleanup);

function Speaker() {
  const announce = useAnnounce();
  return (
    <button type="button" onClick={() => announce("3 guides found")}>
      Say it
    </button>
  );
}

describe("the announcer", () => {
  it("keeps one live region in the page, empty until there's something to say", async () => {
    render(
      <AnnouncerProvider>
        <Speaker />
      </AnnouncerProvider>,
    );
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Say it" }));
    await waitFor(() => expect(region.textContent).toBe("3 guides found"));
  });

  it("does nothing outside a provider", () => {
    render(<Speaker />);
    fireEvent.click(screen.getByRole("button", { name: "Say it" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});
