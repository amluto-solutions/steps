import type { UpdateChannel, UpdateInfo, Updates } from "./updates";

/**
 * Updates for tests and the preview: a copy on `channel` ("checks" unless said), with `newer`
 * out at steps.amluto.com (none unless given) and `pending` downloaded before. Downloading takes
 * the newer version. A copy that doesn't update itself refuses to check, download or install,
 * and has nothing pending, as the desktop does.
 */
export function fakeUpdates(
  options: { channel?: UpdateChannel; newer?: UpdateInfo | null; pending?: string | null } = {},
): Updates {
  const channel = options.channel ?? "checks";
  const updatesItself = channel === "checks" || channel === "portable";
  const off = () => Promise.reject(new Error("This copy of Steps doesn't check for updates."));
  let found: UpdateInfo | null = null;
  let pending: string | null = options.pending ?? null;
  return {
    updatesChannel: () => Promise.resolve(channel),
    checkForUpdate() {
      if (!updatesItself) return off();
      found = options.newer ?? null;
      return Promise.resolve(found);
    },
    downloadUpdate() {
      if (!updatesItself) return off();
      const version = (found ?? options.newer)?.version;
      if (!version) return Promise.reject(new Error("Check for updates first."));
      pending = version;
      return Promise.resolve(pending);
    },
    pendingUpdate: () => Promise.resolve(updatesItself ? pending : null),
    installUpdate: () =>
      !updatesItself
        ? off()
        : pending
          ? Promise.resolve()
          : Promise.reject(new Error("Check for updates first.")),
  };
}
