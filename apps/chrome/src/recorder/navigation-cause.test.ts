import { describe, expect, it } from "vitest";

import { navigationCause } from "./navigation-cause";

describe("how Chrome and Edge reached a page (04/10/2026)", () => {
  it("counts typed and picked addresses, and their redirects, but not links", () => {
    let clock = 0;
    const cause = navigationCause(() => clock);
    expect(cause(1, "typed", ["from_address_bar"])).toBe("addressBar");
    expect(cause(1, "generated", [])).toBe("addressBar");
    expect(cause(1, "link", ["from_address_bar"])).toBe("addressBar");
    // A sign-in page the typed address forwarded to.
    clock = 2_000;
    expect(cause(1, "link", ["client_redirect"])).toBe("addressBar");
    expect(cause(1, "link", [])).toBe("page");
    expect(cause(1, "link", ["client_redirect"])).toBe("page");
    expect(cause(1, "auto_bookmark", [])).toBe("page");
    expect(cause(1, "link", ["forward_back"])).toBe("page");
    // Long after, a redirect is the page's own.
    cause(2, "typed", []);
    clock = 20_000;
    expect(cause(2, "link", ["server_redirect"])).toBe("page");
  });
});
