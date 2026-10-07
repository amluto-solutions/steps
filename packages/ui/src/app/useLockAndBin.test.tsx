// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MenuEntry, MenuItem } from "../components/Menu";
import { errorMessage } from "../errors";
import { initI18n } from "../i18n";
import type { LibraryGuideSummary, TrashEntry } from "../library-bridge";
import { fakeLibrary } from "../library-fake";
import { withGuideLocks, type LockedListPrompt, type PasswordPrompt } from "../library/guide-locks";
import { fakeHost } from "../bridge/host-fake";
import { NO_POLICY, setPolicy } from "../settings/policy";
import { saveRecordPcAndLogin } from "../settings/preferences";
import { useLibraryLocks, useLockAndBin, type LockAndBinDialogs } from "./useLockAndBin";

initI18n();

afterEach(cleanup);

const document = (id: string, title: string) => ({ guide: { id, title }, steps: [] });

/** The password dialog, typing each password in turn until one opens the guide. */
const typing =
  (...passwords: string[]): PasswordPrompt =>
  async (_target, _action, attempt) => {
    for (const password of passwords)
      if ((await attempt(password)).kind === "unlocked") return true;
    return false;
  };

/** The list of locked guides a bulk action leaves: each try is a guide and its password. */
const typingInList =
  (...tries: [guideId: string, password: string][]): LockedListPrompt =>
  async (targets, _body, attempt) => {
    for (const [guideId, password] of tries) {
      const target = targets.find((item) => item.guideId === guideId);
      if (target) await attempt(target, password);
    }
  };

/**
 * The hook as App uses it, over the library fake ("lib": Payroll and Holidays) through the guide
 * locks, with stand-in dialogs. The guides and the Bin are kept as App's library state keeps them,
 * read again whenever the hook refreshes them.
 */
async function setUp(
  options: {
    password?: PasswordPrompt;
    list?: LockedListPrompt;
    dialogs?: Partial<LockAndBinDialogs>;
  } = {},
) {
  const fake = fakeLibrary({
    libraries: [
      {
        id: "lib",
        name: "Guides",
        guides: [document("g1", "Payroll"), document("g2", "Holidays")],
      },
    ],
  });
  const locks = withGuideLocks(fake, {
    who: () => Promise.resolve({ by: "Robin Hale", login: "", pc: "" }),
    recoveryPassword: () => null,
    iterations: 1_000,
    prompts: { password: options.password ?? typing(), list: options.list ?? typingInList() },
  });
  const notify = vi.fn();
  const dialogs: LockAndBinDialogs = {
    newPassword: vi.fn(() => Promise.resolve<string | null>(null)),
    count: vi.fn(() => Promise.resolve(false)),
    confirm: vi.fn(() => Promise.resolve(false)),
    properties: vi.fn(() => Promise.resolve()),
    ...options.dialogs,
  };
  const hook = renderHook(() => {
    const [guides, setGuides] = useState<LibraryGuideSummary[]>([]);
    const [trash, setTrash] = useState<TrashEntry[]>([]);
    const refreshGuides = async (libraryId: string | null) => {
      if (!libraryId) return;
      setGuides(await locks.library.listGuides(libraryId));
      setTrash(await locks.library.listTrash(libraryId));
    };
    // As App's: what's done is said, and a refusal is shown rather than thrown.
    const run = async (action: () => Promise<unknown>, done?: string) => {
      try {
        await action();
        if (done) notify({ text: done });
      } catch (problem) {
        notify({ kind: "error", text: errorMessage(problem, "failed") });
      }
    };
    const actions = useLockAndBin({
      locks,
      libraryId: "lib",
      guides,
      trash,
      refreshGuides,
      notify,
      run,
      author: "Robin Hale",
      dialogs,
    });
    return { actions, guides, trash, refreshGuides };
  });
  await act(() => hook.result.current.refreshGuides("lib"));
  return { hook, locks, notify, dialogs, fake };
}

type Hook = Awaited<ReturnType<typeof setUp>>["hook"];

const isItem = (entry: MenuEntry): entry is MenuItem =>
  typeof entry === "object" && "onSelect" in entry;

/** The labels of a guide's lock and Bin entries, as its menu shows them. */
const labels = (hook: Hook, guideId: string, title: string) =>
  hook.result.current.actions
    .guideEntries({ libraryId: "lib", guideId }, title)
    .map((entry) => (isItem(entry) ? entry.label : entry));

/** Chooses an entry from a guide's menu. */
const choose = async (hook: Hook, guideId: string, title: string, label: string) => {
  const entry = hook.result.current.actions
    .guideEntries({ libraryId: "lib", guideId }, title)
    .find((each) => isItem(each) && each.label === label);
  if (!entry || !isItem(entry)) throw new Error(`no ${label} for ${title}`);
  await act(async () => entry.onSelect());
};

const g1 = { libraryId: "lib", guideId: "g1" };

describe("locking from a guide's menu", () => {
  it("locks a guide with the new password typed, and says so", async () => {
    const { hook, locks, notify } = await setUp({
      dialogs: { newPassword: () => Promise.resolve("secret1") },
    });
    expect(labels(hook, "g1", "Payroll")).toEqual([
      "Lock…",
      "Properties",
      "divider",
      "Move to Bin",
    ]);
    await choose(hook, "g1", "Payroll", "Lock…");
    await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "“Payroll” is locked." }));
    expect(await locks.lockOf(g1)).not.toBeNull();
    // The list shows it locked, so its menu now offers to take the lock off.
    expect(labels(hook, "g1", "Payroll")).toEqual([
      "Remove lock…",
      "Change password…",
      "Properties",
      "divider",
      "Move to Bin",
    ]);
  });

  it("removes a lock once its password is given, and keeps it when the prompt is cancelled", async () => {
    let passwords = ["wrong!"];
    const { hook, locks, notify } = await setUp({
      password: (target, action, attempt) => typing(...passwords)(target, action, attempt),
    });
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));

    await choose(hook, "g1", "Payroll", "Remove lock…");
    expect(await locks.lockOf(g1)).not.toBeNull();

    passwords = ["secret1"];
    await choose(hook, "g1", "Payroll", "Remove lock…");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({ text: "The lock on “Payroll” was removed." }),
    );
    expect(await locks.lockOf(g1)).toBeNull();
    expect(labels(hook, "g1", "Payroll")[0]).toBe("Lock…");
  });

  it("changes the password once the old one is given", async () => {
    const { hook, locks, notify } = await setUp({
      password: typing("secret1"),
      dialogs: { newPassword: () => Promise.resolve("secret2") },
    });
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));

    await choose(hook, "g1", "Payroll", "Change password…");
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({ text: "The password for “Payroll” was changed." }),
    );
    expect((await locks.unlock(g1, "secret1")).kind).toBe("wrong");
    expect((await locks.unlock(g1, "secret2")).kind).toBe("unlocked");
  });

  it("offers no Lock when IT's policy turns locks off, but still lets a lock be removed", async () => {
    const { hook, locks } = await setUp();
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));
    setPolicy({ ...NO_POLICY, disableGuideLocks: true });
    try {
      // Policy is read as the app draws, and it's set before the app starts.
      hook.rerender();
      expect(labels(hook, "g2", "Holidays")).toEqual(["Properties", "divider", "Move to Bin"]);
      expect(labels(hook, "g1", "Payroll").slice(0, 2)).toEqual([
        "Remove lock…",
        "Change password…",
      ]);
      expect(hook.result.current.actions.bulkLocks.onLock).toBeUndefined();
      expect(hook.result.current.actions.bulkLocks.onRemoveLock).toBeDefined();
    } finally {
      setPolicy(NO_POLICY);
    }
  });

  it("shows a guide's Properties", async () => {
    const { hook, dialogs } = await setUp();
    await choose(hook, "g2", "Holidays", "Properties");
    expect(dialogs.properties).toHaveBeenCalledWith("lib", "g2");
  });
});

/** The toast's Undo, run. */
const undo = async (notify: ReturnType<typeof vi.fn>) => {
  const toast = notify.mock.calls.at(-1)?.[0] as { action?: { run: () => void } } | undefined;
  if (!toast?.action) throw new Error("no Undo");
  const { action } = toast;
  await act(async () => action.run());
};

describe("the Bin", () => {
  it("moves a guide to the Bin, and Undo brings it back", async () => {
    const { hook, notify } = await setUp();
    await choose(hook, "g1", "Payroll", "Move to Bin");
    await waitFor(() =>
      expect(hook.result.current.trash.map((entry) => entry.title)).toEqual(["Payroll"]),
    );
    expect(hook.result.current.guides.map((guide) => guide.id)).toEqual(["g2"]);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "“Payroll” moved to the Bin." }),
    );

    await undo(notify);
    await waitFor(() => expect(hook.result.current.trash).toEqual([]));
    expect(hook.result.current.guides.map((guide) => guide.id).sort()).toEqual(["g1", "g2"]);
  });

  it("asks for a locked guide's password before it goes to the Bin", async () => {
    const { hook, locks } = await setUp({ password: typing("wrong!") });
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));
    await choose(hook, "g1", "Payroll", "Move to Bin");
    expect(hook.result.current.trash).toEqual([]);
    expect(await locks.lockOf(g1)).not.toBeNull();
  });

  it("moves a locked guide to the Bin once its password is given", async () => {
    const { hook, locks } = await setUp({ password: typing("secret1") });
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));
    await choose(hook, "g1", "Payroll", "Move to Bin");
    await waitFor(() =>
      expect(hook.result.current.trash.map((entry) => entry.title)).toEqual(["Payroll"]),
    );
  });

  it("restores a guide from the Bin", async () => {
    const { hook, notify } = await setUp();
    await choose(hook, "g2", "Holidays", "Move to Bin");
    await waitFor(() => expect(hook.result.current.trash).toHaveLength(1));
    const [entry] = hook.result.current.trash;
    if (!entry) throw new Error("not binned");
    await act(async () => hook.result.current.actions.bin.onRestore(entry));
    await waitFor(() => expect(hook.result.current.trash).toEqual([]));
    expect(notify).toHaveBeenLastCalledWith({ text: "“Holidays” restored." });
  });

  it("deletes a guide in the Bin for good only once confirmed", async () => {
    let sure = false;
    const confirm = vi.fn(() => Promise.resolve(sure));
    const { hook, notify } = await setUp({ dialogs: { confirm } });
    await choose(hook, "g1", "Payroll", "Move to Bin");
    await waitFor(() => expect(hook.result.current.trash).toHaveLength(1));
    const [entry] = hook.result.current.trash;
    if (!entry) throw new Error("not binned");

    await act(async () => hook.result.current.actions.bin.onDeleteForGood(entry));
    expect(confirm).toHaveBeenCalledWith(
      "Delete “Payroll” for good?",
      expect.any(String),
      "Delete for good",
    );
    expect(hook.result.current.trash).toHaveLength(1);

    sure = true;
    await act(async () => hook.result.current.actions.bin.onDeleteForGood(entry));
    await waitFor(() => expect(hook.result.current.trash).toEqual([]));
    expect(notify).toHaveBeenLastCalledWith({ text: "“Payroll” deleted for good." });
  });

  it("empties a Bin of one guide once confirmed", async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const count = vi.fn(() => Promise.resolve(true));
    const { hook, notify } = await setUp({ dialogs: { confirm, count } });
    await choose(hook, "g1", "Payroll", "Move to Bin");
    await waitFor(() => expect(hook.result.current.trash).toHaveLength(1));
    await act(async () => hook.result.current.actions.bin.onEmpty());
    expect(confirm).toHaveBeenCalledWith("Empty the Bin?", expect.any(String), "Empty Bin");
    expect(count).not.toHaveBeenCalled();
    await waitFor(() => expect(hook.result.current.trash).toEqual([]));
    expect(notify).toHaveBeenLastCalledWith({ text: "1 guide deleted for good." });
  });

  it("empties a Bin of several only once their number is typed", async () => {
    let sure = false;
    const confirm = vi.fn(() => Promise.resolve(true));
    const count = vi.fn(() => Promise.resolve(sure));
    const { hook, notify } = await setUp({ dialogs: { confirm, count } });
    await choose(hook, "g1", "Payroll", "Move to Bin");
    await choose(hook, "g2", "Holidays", "Move to Bin");
    await waitFor(() => expect(hook.result.current.trash).toHaveLength(2));

    await act(async () => hook.result.current.actions.bin.onEmpty());
    expect(count).toHaveBeenCalledWith("Delete 2 guides for good?", 2, "Empty Bin");
    expect(hook.result.current.trash).toHaveLength(2);

    sure = true;
    await act(async () => hook.result.current.actions.bin.onEmpty());
    await waitFor(() => expect(hook.result.current.trash).toEqual([]));
    expect(notify).toHaveBeenLastCalledWith({ text: "2 guides deleted for good." });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("the guide locks the app's library goes through", () => {
  const make = (author: string) => {
    const library = fakeLibrary({
      libraries: [{ id: "lib", name: "Guides", guides: [document("g1", "Payroll")] }],
    });
    const host = fakeHost({ machine: { pc: "EXAMPLE-PC", login: "robin" } });
    return renderHook(() => useLibraryLocks({ library, host, author, iterations: 1_000 }));
  };

  it("names who locked a guide: the display name, this PC and its login", async () => {
    const locks = make("Robin Hale").result.current;
    await locks?.lock(g1, "secret1");
    expect((await locks?.lockOf(g1))?.locked).toMatchObject({
      by: "Robin Hale",
      pc: "EXAMPLE-PC",
      login: "robin",
    });
  });

  it("leaves the PC and login out when Settings says not to record them", async () => {
    window.localStorage.clear();
    saveRecordPcAndLogin(false);
    try {
      const locks = make("").result.current;
      await locks?.lock(g1, "secret1");
      expect((await locks?.lockOf(g1))?.locked).toMatchObject({ by: "Someone", pc: "", login: "" });
    } finally {
      window.localStorage.clear();
    }
  });

  it("has none without a library", () => {
    const hook = renderHook(() =>
      useLibraryLocks({ library: undefined, host: fakeHost(), author: "Robin Hale" }),
    );
    expect(hook.result.current).toBeNull();
  });
});

describe("locks on several guides", () => {
  it("locks the chosen guides with one password", async () => {
    const newPassword = vi.fn(() => Promise.resolve<string | null>("shared1"));
    const { hook, locks, notify } = await setUp({ dialogs: { newPassword } });
    const chosen = hook.result.current.guides;
    await act(async () => hook.result.current.actions.bulkLocks.onLock?.(chosen));
    await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "2 guides locked." }));
    expect(newPassword).toHaveBeenCalledWith(
      "Lock 2 guides",
      expect.any(String),
      expect.any(String),
    );
    expect((await locks.unlock(g1, "shared1")).kind).toBe("unlocked");
  });

  it("leaves guides already locked out, and counts one locked since the list was read", async () => {
    const newPassword = vi.fn(() => Promise.resolve<string | null>("shared1"));
    const { hook, locks, notify } = await setUp({ dialogs: { newPassword } });
    await locks.lock(g1, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));
    await act(async () =>
      hook.result.current.actions.bulkLocks.onLock?.(hook.result.current.guides),
    );
    // Only the guide that wasn't locked was asked about; Payroll keeps its own password.
    await waitFor(() => expect(notify).toHaveBeenCalledWith({ text: "“Holidays” is locked." }));
    expect(newPassword).toHaveBeenCalledWith(
      "Lock “Holidays”",
      expect.any(String),
      expect.any(String),
    );
    expect((await locks.unlock(g1, "secret1")).kind).toBe("unlocked");

    // Someone else locked Holidays after the list was read: it's counted, not locked again.
    const stale = hook.result.current.guides.map((guide) => {
      const unlocked = { ...guide };
      delete unlocked.locked;
      return unlocked;
    });
    notify.mockClear();
    await act(async () => hook.result.current.actions.bulkLocks.onLock?.(stale));
    await waitFor(() =>
      expect(notify).toHaveBeenCalledWith({ text: "0 guides locked. 2 were already locked." }),
    );
    expect((await locks.unlock({ libraryId: "lib", guideId: "g2" }, "shared1")).kind).toBe(
      "unlocked",
    );
    expect((await locks.unlock(g1, "secret1")).kind).toBe("unlocked");
  });

  it("removes the locks whose passwords are given in the list", async () => {
    const { hook, locks } = await setUp({ list: typingInList(["g1", "secret1"]) });
    await locks.lock(g1, "secret1");
    await locks.lock({ libraryId: "lib", guideId: "g2" }, "secret1");
    await act(() => hook.result.current.refreshGuides("lib"));

    const chosen = hook.result.current.guides;
    await act(async () => hook.result.current.actions.bulkLocks.onRemoveLock?.(chosen));
    // The password typed for Payroll opened Holidays too.
    await waitFor(() =>
      expect(hook.result.current.guides.every((guide) => !guide.locked)).toBe(true),
    );
    expect(await locks.lockOf({ libraryId: "lib", guideId: "g2" })).toBeNull();
  });
});
