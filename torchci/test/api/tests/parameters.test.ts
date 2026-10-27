import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  parseTestListParams,
} from "lib/api/tests/parameters";
import { UNSUPPORTED_ID_SORTS } from "./fixtures";

function parse(query: Record<string, string | string[] | undefined> = {}) {
  const result = parseTestListParams({ repo: "pytorch/pytorch", ...query });
  if (!result.success) throw result.error;
  return result.data;
}

describe("test list parameters", () => {
  test("applies list and health-scope defaults centrally", () => {
    expect(parse()).toMatchObject({
      repo: "pytorch/pytorch",
      ran_on: ["main"],
      window: "7d",
      sort: ["-last_run_at"],
      limit: DEFAULT_LIMIT,
      env_vars: {},
    });
    expect(parse().workflow_path).toBeUndefined();
  });

  test.each(["test_SVD", "  test SVD\tCUDA  ", "a,b", "", "   "])(
    "preserves the complete exact search string %j",
    (search) => {
      expect(parse({ search }).search).toBe(search);
    }
  );

  test("canonicalizes repeated filters without changing their exact values", () => {
    const query = parse({
      owner: ["nn", "autograd", "nn"],
      case_name: ["test_value[a,b]", " TestCase ", "test_value[a,b]"],
      accelerator: ["cuda", "cpu", "cuda"],
      device_count: ["1", "0", "1"],
      environments_id: "18446744073709551615",
      env_vars_id: ["2", "1", "2"],
      workflow_path: [
        ".github/workflows/trunk.yml",
        ".github/workflows/pull.yml",
        ".github/workflows/trunk.yml",
      ],
    });
    expect(query.owner).toEqual(["autograd", "nn"]);
    expect(query.case_name).toEqual([" TestCase ", "test_value[a,b]"]);
    expect(query.accelerator).toEqual(["cpu", "cuda"]);
    expect(query.device_count).toEqual([0, 1]);
    expect(query.environments_id).toEqual(["18446744073709551615"]);
    expect(query.env_vars_id).toEqual(["1", "2"]);
    expect(query.workflow_path).toEqual([
      ".github/workflows/pull.yml",
      ".github/workflows/trunk.yml",
    ]);
  });

  test.each([
    ".github/workflows/Pull.yml",
    "",
    ".github/workflows/a,b.yml",
    " .github/workflows/pull.yml ",
  ])("preserves the exact workflow path %j", (workflow_path) => {
    expect(parse({ workflow_path }).workflow_path).toEqual([workflow_path]);
  });

  test("keeps commas and empty strings inside environment-variable values", () => {
    expect(
      parse({
        "env_vars[CUDA_VISIBLE_DEVICES]": ["1,2", "", "1,2"],
        "env_vars[TEST_CONFIG]": " default ",
      }).env_vars
    ).toEqual({
      CUDA_VISIBLE_DEVICES: ["", "1,2"],
      TEST_CONFIG: [" default "],
    });
  });

  test("normalizes equivalent code-source lists but preserves sort priority", () => {
    for (const ran_on of [
      "pull_request,main",
      ["pull_request", "main", "main"],
    ]) {
      expect(parse({ ran_on }).ran_on).toEqual(["main", "pull_request"]);
    }
    expect(parse({ sort: "-failure_rate,-runs,case_name" }).sort).toEqual([
      "-failure_rate",
      "-runs",
      "case_name",
    ]);
    expect(parse({ sort: ["-runs", "file"] }).sort).toEqual(["-runs", "file"]);
  });

  test.each([
    { repo: undefined },
    { repo: "pytorch" },
    { repo: ["pytorch/pytorch", "pytorch/vision"] },
    { search: ["test_a", "test_b"] },
    { ran_on: "nightly" },
    { window: "2d" },
    { sort: "-relevance" },
    { sort: "runs,-runs" },
    { sort: "-runs,,file" },
    ...UNSUPPORTED_ID_SORTS.map((sort) => ({ sort })),
    { order: "desc" },
    { min_runs: "20" },
    { match: "fuzzy" },
    { unknown_parameter: "value" },
    { environment_id: "1" },
    { workflow_path: [] },
    { workflow_paths: ".github/workflows/pull.yml" },
    { sort: "workflow_path" },
    { sort: "-workflow_path" },
    { sort: "-last_run_at,workflow_path" },
    { limit: "0" },
    { limit: "2.5" },
    { limit: ["25", "50"] },
    { limit: String(MAX_LIMIT + 1) },
    { environments_id: "18446744073709551616" },
    { environments_id: "-1" },
    { env_vars_id: "not-an-id" },
    { device_count: "-1" },
    { device_count: "0.5" },
    { device_count: "256" },
    { "env_vars[]": "value" },
    { "env_vars[__proto__]": "value" },
  ])("rejects malformed or unsupported parameters %j", (query) => {
    expect(
      parseTestListParams({ repo: "pytorch/pytorch", ...query }).success
    ).toBe(false);
  });

  test("allows configuration filters and sorts", () => {
    expect(parse({ cpu_architecture: "aarch64" }).cpu_architecture).toEqual([
      "aarch64",
    ]);
    const raw = {
      repo: "pytorch/pytorch",
      sort: "cpu_architecture,-device_count,case_name",
    };
    const result = parseTestListParams(raw);
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(result.data.sort).toEqual([
      "cpu_architecture",
      "-device_count",
      "case_name",
    ]);
  });
});
