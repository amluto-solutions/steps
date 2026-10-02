import { siteName } from "@amluto-steps/core";
import { NO_POLICY, parsePolicy, type Policy } from "@amluto-steps/ui";

/**
 * IT policy in Steps for Chrome (docs/spec/07-settings-and-policy.md#chrome-edition): set through
 * Chrome's or Edge's browser policy and read from managed storage, under the value names the
 * desktop's registry uses. `ExcludedSites` takes the place of `ExcludedApps`; the values that are
 * about a PC (libraries, Start with Windows, update checks) don't apply. The names are declared
 * in `public/managed_schema.json`, which Chrome checks values against.
 */
export function managedPolicy(managed: Record<string, unknown>): Policy {
  if (Object.keys(managed).length === 0) return NO_POLICY;
  const sites = Array.isArray(managed.ExcludedSites) ? managed.ExcludedSites : [];
  return parsePolicy({
    excludedApps: [
      ...new Set(
        sites.map((site) => (typeof site === "string" ? siteName(site) : null)).filter(Boolean),
      ),
    ],
    blurTerms: managed.BlurTerms,
    sensitiveFieldPatterns: managed.SensitiveFieldPatterns,
    locked: managed.Locked,
    disableKeystrokeRecording: managed.DisableKeystrokeRecording,
    recordTypingByDefault: managed.RecordTypingByDefault,
    defaultPdfBrand: managed.DefaultPdfBrand,
    appColoursBrand: managed.AppColoursBrand,
    language: managed.Language,
    languageTone: managed.LanguageTone,
  });
}
