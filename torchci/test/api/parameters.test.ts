import { buildOpenApiDocument } from "lib/api/openapi";
import { RawQuery } from "lib/api/parameters";
import { parseCommitRunsListParams } from "lib/api/tests/commit/parameters";
import { parseTestListParams } from "lib/api/tests/parameters";
import { parseRunsListParams } from "lib/api/tests/test/runs/parameters";

const endpoints = [
  {
    path: "/api/tests",
    parse: (raw: RawQuery) =>
      parseTestListParams({ repo: "pytorch/pytorch", ...raw }),
  },
  {
    path: "/api/tests/test/{test_id}/runs",
    parse: (raw: RawQuery) => parseRunsListParams({ test_id: "1", ...raw }),
  },
  {
    path: "/api/tests/commit/{sha}",
    parse: (raw: RawQuery) =>
      parseCommitRunsListParams({
        sha: "0123456789abcdef0123456789abcdef01234567",
        repo: "pytorch/pytorch",
        ...raw,
      }),
  },
];

describe.each(endpoints)("JSON query parameters: $path", ({ path, parse }) => {
  test("accepts OpenAPI JSON content serialization without losing exact values", () => {
    const operation = buildOpenApiDocument().paths[path] as any;
    const parameter = operation.get.parameters.find(
      ({ name }: { name: string }) => name === "env_vars"
    );
    expect(parameter.content["application/json"].schema).toMatchObject({
      type: "object",
      additionalProperties: {
        type: "array",
        minItems: 1,
        items: { type: "string" },
      },
    });
    for (const field of ["schema", "style", "explode"]) {
      expect(parameter).not.toHaveProperty(field);
    }

    // An OpenAPI content parameter is one JSON value, then URL-encoded.
    const values = {
      Z_LAST: ["b", "a", "b"],
      A_FIRST: ["", ' a,b &+%"\\λ雪 ', ""],
    };
    const encoded = new URLSearchParams({
      [parameter.name]: JSON.stringify(values),
    }).toString();
    const parsed = parse(Object.fromEntries(new URLSearchParams(encoded)));
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.env_vars).toEqual({
      A_FIRST: ["", ' a,b &+%"\\λ雪 '],
      Z_LAST: ["a", "b"],
    });

    const legacy = parse({
      "env_vars[Z_LAST]": values.Z_LAST,
      "env_vars[A_FIRST]": values.A_FIRST,
    });
    if (!legacy.success) throw legacy.error;
    expect(parsed.data).toEqual(legacy.data);
  });

  test("accepts an explicit empty JSON object", () => {
    const parsed = parse({ env_vars: "{}" });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data.env_vars).toEqual({});
  });

  test.each([
    { env_vars: "" },
    { env_vars: "{" },
    { env_vars: "null" },
    { env_vars: "[]" },
    { env_vars: '"MODE"' },
    { env_vars: "true" },
    { env_vars: "42" },
    { env_vars: '{"MODE":"value"}' },
    { env_vars: '{"MODE":[]}' },
    { env_vars: '{"MODE":[null]}' },
    { env_vars: '{"MODE":[1]}' },
    { env_vars: '{"bad-name":["value"]}' },
    { env_vars: '{"__proto__":["value"]}' },
    { env_vars: ["{}"] },
    { env_vars: ['{"MODE":["one"]}', '{"MODE":["two"]}'] },
    { env_vars: "{}", "env_vars[MODE]": "value" },
    { env_vars: '{"MODE":["value"]}', "env_vars[MODE]": "value" },
  ])("rejects malformed or ambiguous JSON %j", (raw) => {
    const parsed = parse(raw);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error("Expected invalid parameters");
    expect(parsed.error.issues[0].path[0]).toBe("env_vars");
  });
});
