import type { ExtensionLink, LinkStatus } from "./extension-link";

/**
 * The link for tests and the preview: available and on, with `connected` (Chrome) connected
 * while it's on, unless `status` says otherwise. Each change is told to every listener, as the
 * desktop's events and the browser's messages do.
 */
export function fakeExtensionLink(status: Partial<LinkStatus> = {}): ExtensionLink {
  const whenOn = status.connected ?? ["chrome"];
  let current: LinkStatus = {
    available: true,
    enabled: true,
    connected: whenOn,
    problem: null,
    ...status,
  };
  const listeners = new Set<(status: LinkStatus) => void>();
  const answer = () => Promise.resolve({ ...current, connected: [...current.connected] });
  return {
    getLink: answer,
    setLink(on) {
      if (!current.available) return answer();
      const enabled = on ?? true;
      current = { ...current, enabled, connected: enabled ? whenOn : [] };
      for (const listener of listeners) listener({ ...current });
      return answer();
    },
    onLink(handler) {
      listeners.add(handler);
      return Promise.resolve(() => {
        listeners.delete(handler);
      });
    },
  };
}
