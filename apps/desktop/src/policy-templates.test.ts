// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const file = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const admx = file("../policy/AmlutoSteps.admx");
const adml = file("../policy/en-US/AmlutoSteps.adml");
const policyRs = file("../src-tauri/src/policy.rs");

const parse = (text: string) => new DOMParser().parseFromString(text, "application/xml");
const all = (text: string, pattern: RegExp) => [...text.matchAll(pattern)].map((match) => match[1]);

describe("Group Policy templates", () => {
  it("are well-formed XML", () => {
    for (const text of [admx, adml]) {
      expect(parse(text).getElementsByTagName("parsererror")).toHaveLength(0);
    }
  });

  it("only refer to strings and presentations that exist, and leave none unused", () => {
    const strings = new Set(all(adml, /<string id="([^"]+)"/g));
    const presentations = new Set(all(adml, /<presentation id="([^"]+)"/g));
    const usedStrings = new Set(all(admx, /\$\(string\.([^)]+)\)/g));
    const usedPresentations = new Set(all(admx, /\$\(presentation\.([^)]+)\)/g));
    expect([...usedStrings].filter((id) => !strings.has(id))).toEqual([]);
    expect([...usedPresentations].filter((id) => !presentations.has(id))).toEqual([]);
    expect([...strings].filter((id) => !usedStrings.has(id))).toEqual([]);
    expect([...presentations].filter((id) => !usedPresentations.has(id))).toEqual([]);
    // Each presentation control points at an element of its policy.
    const elementIds = new Set(all(admx, /<(?:multiText|text|enum) id="([^"]+)"/g));
    expect(all(adml, /refId="([^"]+)"/g).filter((id) => !elementIds.has(id))).toEqual([]);
  });

  it("write only the registry values the app reads, to the key it reads", () => {
    const read = new Set(all(policyRs, /(?:list|string|number)\("([A-Za-z]+)"\)/g));
    const written = all(admx, /valueName="([^"]+)"/g);
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => !read.has(name))).toEqual([]);
    expect(policyRs).toContain('POLICY_KEY: &str = r"SOFTWARE\\Policies\\Amluto\\Steps"');
    for (const key of all(admx, /key="([^"]+)"/g)) {
      expect(key?.toLowerCase()).toBe("software\\policies\\amluto\\steps");
    }
  });

  it("match the .msi's install properties, which write the same values to the same key", () => {
    const wxs = file("../src-tauri/wix/policy.wxs");
    expect(parse(wxs).getElementsByTagName("parsererror")).toHaveLength(0);
    const read = new Set(all(policyRs, /(?:list|string|number)\("([A-Za-z]+)"\)/g));
    const written = all(wxs, /Name="([^"]+)"/g);
    expect(written.filter((name) => !read.has(name))).toEqual([]);
    // Every policy the templates offer can also be set at install time.
    expect(all(admx, /valueName="([^"]+)"/g).filter((name) => !written.includes(name))).toEqual([]);
    expect(wxs).toContain('<?define PolicyKey = "SOFTWARE\\Policies\\Amluto\\Steps" ?>');
    // Policy values go to the policy key; the installer's own copy (for repairs and upgrades) to
    // a key of its own, and only that copy is ever read back, so Group Policy's values are never
    // taken over.
    expect(wxs).toContain('<?define RememberKey = "SOFTWARE\\Amluto\\Steps\\MsiPolicy" ?>');
    expect(
      all(wxs, /Key="([^"]+)"/g).every(
        (key) => key === "$(var.PolicyKey)" || key === "$(var.RememberKey)",
      ),
    ).toBe(true);
    expect(
      all(wxs, /<RegistrySearch [^>]*Key="([^"]+)"/g).every((key) => key === "$(var.RememberKey)"),
    ).toBe(true);
    expect(
      all(wxs, /Key="\$\(var\.PolicyKey\)" Name="[^"]+" Type="[^"]+" Value="[^"]+" KeyPath/g),
    ).toHaveLength(21);
    for (const name of written) {
      expect(wxs).toContain(`Key="$(var.RememberKey)" Name="${name}" Type="string"`);
    }
    // Each value comes from a declared, secure property and is only written when it's given.
    const declared = new Set(all(wxs, /<Property Id="([A-Z]+)" Secure="yes" \/>/g));
    for (const component of wxs.split("<Component ").slice(1)) {
      const property = /Value="\[([A-Z]+)\]"/.exec(component)?.[1] ?? "";
      expect(declared.has(property)).toBe(true);
      expect(component).toMatch(new RegExp(`<Condition><!\\[CDATA\\[${property}\\b`));
      expect(component).toContain('Transitive="yes"');
    }
  });

  it("list only lockable settings in the Lock settings help", () => {
    const lockable = new Set(all(policyRs, /^ {4}"([A-Za-z]+)",$/gm));
    const help = adml.slice(adml.indexOf('<string id="Locked_Help">'));
    const listed = all(help.slice(0, help.indexOf("</string>")), /^([A-Za-z]+) - /gm);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((key) => !lockable.has(key))).toEqual([]);
  });
});
