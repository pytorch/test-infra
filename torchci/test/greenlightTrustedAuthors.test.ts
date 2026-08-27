import {
  GREENLIGHT_TRUSTED_AUTHORS,
  isTrustedAuthor,
} from "lib/bot/greenlightTrustedAuthors";

describe("isTrustedAuthor", () => {
  test("accepts every login on the list", () => {
    for (const login of GREENLIGHT_TRUSTED_AUTHORS) {
      expect(isTrustedAuthor(login)).toBe(true);
    }
  });

  test("accepts a login whatever case GitHub delivers it in", () => {
    for (const login of GREENLIGHT_TRUSTED_AUTHORS) {
      expect(isTrustedAuthor(login.toUpperCase())).toBe(true);
      expect(isTrustedAuthor(login.toLowerCase())).toBe(true);
    }
  });

  test("rejects anyone else", () => {
    expect(isTrustedAuthor("ghuser")).toBe(false);
    expect(isTrustedAuthor("")).toBe(false);
    expect(isTrustedAuthor("pytorch-bot[bot]")).toBe(false);
  });

  test("holds no blank or duplicated entries", () => {
    const folded = GREENLIGHT_TRUSTED_AUTHORS.map((login) =>
      login.toLowerCase()
    );
    expect(folded.filter((login) => login.trim().length === 0)).toEqual([]);
    expect(new Set(folded).size).toBe(GREENLIGHT_TRUSTED_AUTHORS.length);
  });
});
