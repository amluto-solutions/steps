import { describe, expect, it, vi } from "vitest";

import type { LinkStatus } from "@amluto-steps/ui";

import { createDesktopLink, PROTOCOL, type LinkDeps, type LinkPort } from "./link";

/** A native messaging port the test plays the relay and the app on. */
function fakePort() {
  const heard: ((message: unknown) => void)[] = [];
  const closed: (() => void)[] = [];
  const port = {
    sent: [] as unknown[],
    disconnected: false,
    postMessage(message: unknown) {
      this.sent.push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    onMessage: { addListener: (listener: (message: unknown) => void) => heard.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => closed.push(listener) },
    /** The app says something. */
    say: async (message: unknown) => {
      for (const listener of heard) listener(message);
      await new Promise((settle) => setTimeout(settle, 0));
    },
    /** The relay ends. */
    close: () => {
      for (const listener of closed) listener();
    },
  };
  return port satisfies LinkPort;
}

function setup(overrides: Partial<LinkDeps> = {}) {
  const ports: ReturnType<typeof fakePort>[] = [];
  let error: string | undefined;
  let enabled = false;
  const statuses: LinkStatus[] = [];
  const deps: LinkDeps = {
    browser: "edge",
    version: "0.4.3",
    connect: () => {
      const port = fakePort();
      ports.push(port);
      return port;
    },
    lastError: () => error,
    capture: vi.fn(() => Promise.resolve()),
    excluded: () => Promise.resolve(["bank.example"]),
    loadEnabled: () => Promise.resolve(enabled),
    saveEnabled: (on) => {
      enabled = on;
      return Promise.resolve();
    },
    keepTrying: vi.fn(),
    broadcast: (status) => statuses.push(status),
    now: () => 10_000,
    ...overrides,
  };
  const link = createDesktopLink(deps);
  return {
    link,
    deps,
    ports,
    statuses,
    failWith: (message: string | undefined) => (error = message),
    setEnabled: (on: boolean) => (enabled = on),
  };
}

const place = (url: string, frameUrl?: string) => ({ title: "Invoices", url, frameUrl });
const button = { tagName: "BUTTON", innerText: "Approve invoice" };

describe("Steps for Windows and this browser together", () => {
  it("connects when switched on, and says which browser and protocol", async () => {
    const { link, ports, deps } = setup();
    await link.start();
    expect(ports).toHaveLength(0);
    await link.set(true);
    expect(deps.keepTrying).toHaveBeenLastCalledWith(true);
    expect(ports[0]?.sent[0]).toEqual({
      type: "hello",
      protocol: PROTOCOL,
      browser: "edge",
      version: "0.4.3",
    });
    await ports[0]?.say({ type: "hello", protocol: PROTOCOL, version: "0.4.3" });
    expect(link.status()).toEqual({
      available: true,
      enabled: true,
      connected: ["desktop"],
      problem: null,
    });
  });

  it("reports clicks only while the app records, and none from sites not recorded", async () => {
    const { link, ports, deps } = setup();
    await link.set(true);
    const [port] = ports;
    if (!port) throw new Error("no connection was opened");
    await port.say({ type: "hello", protocol: PROTOCOL });
    link.click(place("https://portal.example/invoices"), button, 9_960);
    expect(port.sent).toHaveLength(1);

    await port.say({ type: "recording", on: true });
    expect(deps.capture).toHaveBeenLastCalledWith(true);
    link.click(place("https://portal.example/invoices?id=42"), button, 9_960);
    link.click(place("https://online.bank.example/pay"), button, 9_960);
    link.click(place("https://portal.example/", "https://bank.example/card"), button, 9_960);
    link.click(place("https://portal.example/"), { innerText: "x".repeat(3_000) }, undefined);
    expect(port.sent.slice(1)).toEqual([
      { type: "click", ageMs: 40, title: "Invoices", target: button },
      { type: "click", ageMs: 0, title: "Invoices", target: { innerText: "x".repeat(2_000) } },
    ]);

    await port.say({ type: "recording", on: false });
    expect(deps.capture).toHaveBeenLastCalledWith(false);
    link.click(place("https://portal.example/"), button, 9_960);
    expect(port.sent).toHaveLength(3);
  });

  it("says why it isn't connected, and tries again each minute", async () => {
    const { link, ports, failWith } = setup();
    await link.set(true);
    failWith("Specified native messaging host not found.");
    ports[0]?.close();
    expect(link.status().problem).toBe("notInstalled");

    link.retry();
    expect(ports).toHaveLength(2);
    await ports[1]?.say({ type: "unavailable", reason: "notRunning" });
    failWith("Native host has exited.");
    ports[1]?.close();
    expect(link.status()).toMatchObject({ problem: "notRunning", connected: [] });

    link.retry();
    await ports[2]?.say({ type: "hello", protocol: PROTOCOL + 1 });
    ports[2]?.close();
    expect(link.status().problem).toBe("protocol");
  });

  it("stops recording pages when the app goes away mid-recording", async () => {
    const { link, ports, deps } = setup();
    await link.set(true);
    await ports[0]?.say({ type: "hello", protocol: PROTOCOL });
    await ports[0]?.say({ type: "recording", on: true });
    ports[0]?.close();
    await Promise.resolve();
    expect(deps.capture).toHaveBeenLastCalledWith(false);
    expect(link.recording()).toBe(false);
  });

  it("switched off, it disconnects, stops the pages and stops trying", async () => {
    const { link, ports, deps } = setup();
    await link.set(true);
    await ports[0]?.say({ type: "hello", protocol: PROTOCOL });
    await ports[0]?.say({ type: "recording", on: true });
    await link.set(false);
    expect(ports[0]?.disconnected).toBe(true);
    expect(deps.capture).toHaveBeenLastCalledWith(false);
    expect(deps.keepTrying).toHaveBeenLastCalledWith(false);
    expect(link.status()).toMatchObject({ enabled: false, connected: [], problem: null });
    link.retry();
    expect(ports).toHaveLength(1);
  });

  it("remembers being switched on across the worker's restarts", async () => {
    const first = setup();
    first.setEnabled(true);
    await first.link.start();
    expect(first.ports).toHaveLength(1);
    expect(first.deps.keepTrying).toHaveBeenLastCalledWith(true);
  });

  it("without the browser's permission, says so", async () => {
    const { link } = setup({ connect: () => null });
    await link.set(true);
    expect(link.status().problem).toBe("permission");
  });

  it("isn't offered in Firefox", async () => {
    const { link, ports } = setup({ browser: null });
    await link.set(true);
    expect(link.status()).toMatchObject({ available: false, enabled: false });
    expect(ports).toHaveLength(0);
  });
});
