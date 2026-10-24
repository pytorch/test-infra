import { requestQuery } from "lib/api/handler";

describe("requestQuery", () => {
  test("keeps a single value as a string and repeated values as an array, in order", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?repo=pytorch%2Fpytorch&owner=b&owner=a&owner=b&search="
    );
    expect(await requestQuery(request)).toEqual({
      repo: "pytorch/pytorch",
      owner: ["b", "a", "b"],
      search: "",
    });
  });

  test("decodes the query string like a form", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?search=a+b%2Bc&env_vars%5BMODE%5D=%E9%9B%AA"
    );
    expect(await requestQuery(request)).toEqual({
      search: "a b+c",
      "env_vars[MODE]": "雪",
    });
  });

  test("keeps keys named after Object.prototype members as ordinary keys", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests?__proto__=a&constructor=b&toString=c&toString=d"
    );
    expect(Object.entries(await requestQuery(request))).toEqual([
      ["__proto__", "a"],
      ["constructor", "b"],
      ["toString", ["c", "d"]],
    ]);
  });

  test("lets a path parameter replace a query key of the same name", async () => {
    const request = new Request(
      "https://hud.pytorch.org/api/tests/test/1/runs?test_id=2&test_id=3&limit=5"
    );
    expect(
      await requestQuery(request, Promise.resolve({ test_id: "1" }))
    ).toEqual({ test_id: "1", limit: "5" });
  });
});
