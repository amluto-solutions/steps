import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { Link } from "../app/useLink";
import type { LinkStatus } from "../recorder-bridge";
import { Row, Switch } from "./controls";

/** Where things stand, in a sentence, once the link is switched on. */
function stateText(t: TFunction, status: LinkStatus, browser: boolean): string {
  if (!status.enabled) return "";
  if (browser) {
    if (status.connected.length > 0 && !status.problem) return t("settings.link.connectedDesktop");
    switch (status.problem) {
      case "notInstalled":
        return t("settings.link.notInstalled");
      case "notRunning":
        return t("settings.link.notRunning");
      case "protocol":
        return t("settings.link.protocol");
      case "permission":
        return t("settings.link.permission");
      default:
        return t("settings.link.connecting");
    }
  }
  switch (status.problem) {
    case "register":
      return t("settings.link.register");
    case "pipeTaken":
      return t("settings.link.pipeTaken");
    case "pipe":
      return t("settings.link.pipe");
    default:
      break;
  }
  const chrome = status.connected.includes("chrome");
  const edge = status.connected.includes("edge");
  if (chrome && edge) return t("settings.link.connectedBoth");
  if (chrome) return t("settings.link.connectedChrome");
  if (edge) return t("settings.link.connectedEdge");
  return t("settings.link.waiting");
}

/**
 * Settings > Recording: "Work with Steps for Chrome and Edge" on the desktop, "Help Steps for
 * Windows" in the browser (docs/spec/02-capture.md#steps-for-chrome-and-the-desktop-together).
 * Shown only where the link is possible.
 */
export function LinkRow({ link, browser }: { link: Link | undefined; browser: boolean }) {
  const { t } = useTranslation();
  const status = link?.status;
  if (!link || !status?.available) return null;
  const help = t(browser ? "settings.link.browserHelp" : "settings.link.desktopHelp");
  const state = stateText(t, status, browser);
  return (
    <Row
      label={t(browser ? "settings.link.browser" : "settings.link.desktop")}
      help={state ? `${help} ${state}` : help}
      id="link-label"
    >
      <Switch
        labelledBy="link-label"
        checked={status.enabled}
        onChange={(on) => void link.set(on)}
      />
    </Row>
  );
}
