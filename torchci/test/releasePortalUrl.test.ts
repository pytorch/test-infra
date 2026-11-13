import { isSafeReleaseUrl } from "lib/releasePortal/url";

describe("isSafeReleaseUrl", () => {
  test.each([
    ["https://hud.pytorch.org/release/2.10.0", true],
    ["http://example.com/evidence", true],
    [undefined, false],
    [null, false],
    ["", false],
    [" https://example.com", false],
    ["https://example.com/path with spaces", false],
    ["https://example.com/\npath", false],
    ["javascript:alert(1)", false],
    ["data:text/html,hello", false],
    ["ftp://example.com/evidence", false],
    ["https://user:password@example.com/evidence", false],
  ])("accepts %p: %p", (value, expected) => {
    expect(isSafeReleaseUrl(value)).toBe(expected);
  });
});
