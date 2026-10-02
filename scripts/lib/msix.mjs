// The Store package's manifest values (docs/spec/10-distribution.md#microsoft-store), kept apart
// from scripts/msix.mjs so they can be tested without makeappx.

/** A fake identity for checking that the package builds. Never upload a package made with it. */
export const CHECK_IDENTITY = {
  identityName: "AmlutoSolutions.AmlutoSteps.LocalCheck",
  publisher: "CN=Steps local check",
  publisherDisplayName: "Amluto Solutions Ltd (local check)",
};

/** "0.1.0" → "0.1.0.0". The Store wants four parts and reserves the last one, so it is always 0. */
export function storeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`The app version "${version}" isn't major.minor.patch.`);
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 65_535)) {
    throw new Error(`Each part of "${version}" must be 65535 or less.`);
  }
  return `${parts.join(".")}.0`;
}

/**
 * The identity from msix/identity.json, checked. Returns the problems (empty when it's usable),
 * so the script can say exactly what to fill in.
 */
export function identityProblems(identity) {
  const problems = [];
  if (!/^[A-Za-z0-9.-]{3,50}$/.test(identity.identityName ?? "")) {
    problems.push(
      "identityName: the Package/Identity/Name from Partner Center (e.g. 12345Amluto.AmlutoSteps)",
    );
  }
  if (!/^CN=.{1,500}$/.test(identity.publisher ?? "")) {
    problems.push("publisher: the Package/Identity/Publisher from Partner Center (starts CN=)");
  }
  if (!(identity.publisherDisplayName ?? "").trim()) {
    problems.push("publisherDisplayName: the publisher display name from Partner Center");
  }
  return problems;
}

const escapeXml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The manifest with its __PLACEHOLDERS__ filled in; any placeholder left over is an error. */
export function fillManifest(template, { identityName, publisher, publisherDisplayName, version }) {
  const filled = template
    .replaceAll("__IDENTITY_NAME__", escapeXml(identityName))
    .replaceAll("__PUBLISHER_DISPLAY_NAME__", escapeXml(publisherDisplayName))
    .replaceAll("__PUBLISHER__", escapeXml(publisher))
    .replaceAll("__VERSION__", escapeXml(version));
  const left = filled.match(/__[A-Z_]+__/g);
  if (left) throw new Error(`The manifest still has ${left.join(", ")}.`);
  return filled;
}
