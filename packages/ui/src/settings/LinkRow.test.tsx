// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { expectNoSeriousAxeViolations } from "../../test/axe";
import { useLink, type Link } from "../app/useLink";
import { initI18n } from "../i18n";
import type { LinkStatus, RecorderBridge } from "../recorder-bridge";
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
  const recorder = (edition?: "browser") => {
    const listeners: ((value: LinkStatus) => void)[] = [];
    const bridge = {
      ...(edition ? { edition } : {}),
      getLink: vi.fn(() => Promise.resolve(status({ enabled: false }))),
      setLink: vi.fn((on: boolean | null) => Promise.resolve(status({ enabled: on !== false }))),
      onLink: vi.fn((handler: (value: LinkStatus) => void) => {
        listeners.push(handler);
        return Promise.resolve(() => undefined);
      }),
    };
    return { bridge: bridge as unknown as RecorderBridge & typeof bridge, listeners };
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
    const { bridge, listeners } = recorder("browser");
    const { result } = renderHook(() => useLink(bridge));
    await act(() => Promise.resolve());
    expect(bridge.setLink).not.toHaveBeenCalled();
    expect(result.current.status?.enabled).toBe(false);
    act(() => listeners[0]?.(status({ connected: ["desktop"] })));
    expect(result.current.status?.connected).toEqual(["desktop"]);
  });
});
