// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { useLink, type Link } from "../app/useLink";
import type { LinkStatus } from "../bridge/extension-link";
import { fakeExtensionLink } from "../bridge/extension-link-fake";
import { fakeCapabilities } from "../bridge/capabilities-fake";
import { initI18n } from "../i18n";
import { LinkRow } from "./LinkRow";

initI18n();
afterEach(cleanup);
beforeEach(() => window.localStorage.clear());

const status = (change: Partial<LinkStatus> = {}): LinkStatus => ({
  available: true,
  enabled: true,
  connected: [],
  problem: null,
  ...change,
});

const link = (value: LinkStatus | null, set = vi.fn(() => Promise.resolve())): Link => ({
  status: value,
  set,
});

describe("Settings > Recording: Steps for Windows and Steps for Chrome and Edge together", () => {
  it("isn't shown where the link isn't possible", () => {
    const { container } = render(
      <LinkRow link={link(status({ available: false }))} browser={false} />,
    );
    expect(container.innerHTML).toBe("");
    render(<LinkRow link={link(null)} browser />);
    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("says on the desktop which browsers are connected, or what to do", async () => {
    const { container, rerender } = render(
      <LinkRow link={link(status({ connected: ["chrome", "edge"] }))} browser={false} />,
    );
    expect(screen.getByText(/Connected to Chrome and Edge\./)).toBeTruthy();
    await expectNoSeriousAxeViolations(container);
    rerender(<LinkRow link={link(status())} browser={false} />);
    expect(screen.getByText(/switch on “Help Steps for Windows”/)).toBeTruthy();
    rerender(<LinkRow link={link(status({ problem: "pipeTaken" }))} browser={false} />);
    expect(screen.getByText(/Another copy of Steps/)).toBeTruthy();
    rerender(<LinkRow link={link(status({ enabled: false }))} browser={false} />);
    expect(screen.queryByText(/Connected|Not connected/)).toBeNull();
  });

  it("says in the browser whether Steps for Windows answered, and why not", () => {
    const { rerender } = render(
      <LinkRow link={link(status({ connected: ["desktop"] }))} browser />,
    );
    expect(screen.getByText(/Connected to Steps for Windows\./)).toBeTruthy();
    rerender(<LinkRow link={link(status({ problem: "notInstalled" }))} browser />);
    expect(screen.getByText(/Microsoft Store edition, which can't connect yet/)).toBeTruthy();
    rerender(<LinkRow link={link(status({ problem: "notRunning" }))} browser />);
    expect(screen.getByText(/isn't running/)).toBeTruthy();
  });

  it("switches from the row's switch", () => {
    const set = vi.fn(() => Promise.resolve());
    render(<LinkRow link={link(status({ enabled: false }), set)} browser={false} />);
    fireEvent.click(screen.getByRole("switch", { name: "Work with Steps for Chrome and Edge" }));
    expect(set).toHaveBeenCalledWith(true);
  });
});

describe("the link as the app opens", () => {
  const recorder = (savesLinkChoice = true) => {
    const listeners: ((value: LinkStatus) => void)[] = [];
    const link = fakeExtensionLink({ enabled: false, connected: [] });
    const bridge = {
      ...link,
      capabilities: fakeCapabilities({ savesLinkChoice }),
      setLink: vi.spyOn(link, "setLink"),
      onLink: (handler: (value: LinkStatus) => void) => {
        listeners.push(handler);
        return link.onLink(handler);
      },
    };
    return { bridge, listeners };
  };

  it("the desktop sets its side from the person's choice, or its default, as it opens", async () => {
    const { bridge } = recorder();
    const { result } = renderHook(() => useLink(bridge));
    await act(() => Promise.resolve());
    expect(bridge.setLink).toHaveBeenCalledWith(null);
    expect(result.current.status?.enabled).toBe(true);
    await act(() => result.current.set(false));
    cleanup();

    const again = recorder();
    renderHook(() => useLink(again.bridge));
    await act(() => Promise.resolve());
    expect(again.bridge.setLink).toHaveBeenCalledWith(false);
  });

  it("the browser only reads its side, and follows changes", async () => {
    const { bridge, listeners } = recorder(false);
    const { result } = renderHook(() => useLink(bridge));
    await act(() => Promise.resolve());
    expect(bridge.setLink).not.toHaveBeenCalled();
    expect(result.current.status?.enabled).toBe(false);
    act(() => listeners[0]?.(status({ connected: ["desktop"] })));
    expect(result.current.status?.connected).toEqual(["desktop"]);
    // Its background worker keeps the choice: the page doesn't save it for the next start.
    await act(() => result.current.set(true));
    expect(bridge.setLink).toHaveBeenCalledWith(true);
    cleanup();
    const desktop = recorder();
    renderHook(() => useLink(desktop.bridge));
    await act(() => Promise.resolve());
    expect(desktop.bridge.setLink).toHaveBeenCalledWith(null);
  });
});
