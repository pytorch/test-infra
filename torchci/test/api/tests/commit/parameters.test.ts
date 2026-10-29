import {
  CommitRunsListQuery,
  parseCommitRunsListParams,
} from "lib/api/tests/commit/parameters";
import { DEFAULT_LIMIT, MAX_LIMIT } from "lib/api/tests/parameters";
import {
  parseRunsListParams,
  RUN_SORT_FIELDS,
} from "lib/api/tests/test/runs/parameters";
import { RUN_OUTCOMES } from "../test/runs/fixtures";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const REPO = "pytorch/pytorch";
const UINT64_MAX = "18446744073709551615";

function parse(raw: Record<string, string | string[] | undefined> = {}) {
  const result = parseCommitRunsListParams({ sha: SHA, repo: REPO, ...raw });
  if (!result.success) throw result.error;
  return result.data;
}

describe("commit runs parameters", () => {
  test("defaults to all configurations, all outcomes and descending start time", () => {
    expect(parse()).toEqual({
      sha: SHA,
      repo: REPO,
      sort: ["-started_at"],
      limit: DEFAULT_LIMIT,
    });
  });

  test("normalizes uppercase SHAs and repeated filters without losing ID precision", () => {
    const { cursor, ...query } = parse({
      sha: SHA.toUpperCase(),
      environments_id: ["9007199254740993", "0002", "2", UINT64_MAX],
      env_vars_id: ["0009", "8", "9"],
      outcome: ["failed", "error", "failed"],
      last_attempt_outcome: ["passed", "failed", "passed"],
      sort: "-ended_at, started_at",
      limit: String(MAX_LIMIT),
      cursor: "opaque-cursor",
    });
    const expected: CommitRunsListQuery = {
      sha: SHA,
      repo: REPO,
      environments_id: [UINT64_MAX, "2", "9007199254740993"],
      env_vars_id: ["8", "9"],
      outcome: ["error", "failed"],
      last_attempt_outcome: ["failed", "passed"],
      sort: ["-ended_at", "started_at"],
      limit: MAX_LIMIT,
    };
    expect(query).toEqual(expected);
    expect(cursor).toBe("opaque-cursor");
  });

  test.each(RUN_OUTCOMES)(
    "accepts the recorded and last-attempt outcome %s",
    (outcome) => {
      expect(parse({ outcome }).outcome).toEqual([outcome]);
      expect(
        parse({ last_attempt_outcome: outcome }).last_attempt_outcome
      ).toEqual([outcome]);
    }
  );

  test("uses the same catalog, workflow and execution filters as test runs", () => {
    const options = {
      search: "test_example[a, b]",
      file: ["test/test_ops.py", "test/test_torch.py"],
      suite: "",
      case_name: "test_example[a, b]",
      declared_case_name: "test_example",
      language: "python",
      owner: ["nn", "autograd", "nn"],
      os: "linux",
      device_count: ["0", "02", "2"],
      environments_id: "0001",
      env_vars_id: "0002",
      "env_vars[MODE]": ["b", "a", "b"],
      workflow_path: [
        ".github/workflows/trunk.yml",
        ".github/workflows/slow.yml",
      ],
      rerun_number: ["2", "00", "0"],
      outcome: ["passed", "error"],
      last_attempt_outcome: ["passed", "failed", "passed"],
      sort: "file,-device_count,outcome,-rerun_number,started_at",
    };
    const testRuns = parseRunsListParams({ test_id: "1", ...options });
    if (!testRuns.success) throw testRuns.error;
    const { test_id: _testId, ...shared } = testRuns.data;
    expect(parse(options)).toEqual({ sha: SHA, repo: REPO, ...shared });
    expect(parse(options)).toMatchObject({
      suite: [""],
      environments_id: ["1"],
      env_vars_id: ["2"],
      device_count: [0, 2],
      rerun_number: [0, 2],
      last_attempt_outcome: ["failed", "passed"],
      env_vars: { MODE: ["a", "b"] },
    });
  });

  test.each(RUN_SORT_FIELDS)("accepts both directions for %s", (field) => {
    expect(parse({ sort: field }).sort).toEqual([field]);
    expect(parse({ sort: `-${field}` }).sort).toEqual([`-${field}`]);
  });

  test.each([
    ["started_at", ["started_at"]],
    ["-started_at", ["-started_at"]],
    ["ended_at", ["ended_at"]],
    ["-ended_at", ["-ended_at"]],
    [
      ["ended_at", "-started_at"],
      ["ended_at", "-started_at"],
    ],
  ])("accepts timestamp sort priorities %j", (sort, expected) => {
    expect(parse({ sort }).sort).toEqual(expected);
  });

  test.each([
    { sha: undefined },
    { sha: "" },
    { sha: SHA.slice(0, 7) },
    { sha: SHA.slice(0, 39) },
    { sha: `${SHA}0` },
    { sha: `g${SHA.slice(1)}` },
    { sha: `${SHA} ` },
    { sha: [SHA] },
    { sha: [SHA, SHA] },
    { repo: undefined },
    { repo: "" },
    { repo: "pytorch" },
    { repo: "pytorch/pytorch/extra" },
    { repo: "pytorch/pytorch " },
    { repo: [REPO] },
    { repo: [REPO, REPO] },
    { test_id: "123" },
    { environment_id: "1" },
    { environments_id: "18446744073709551616" },
    { environments_id: "-1" },
    { environments_id: "1,2" },
    { environments_id: [] },
    { env_vars_id: "invalid" },
    { env_vars_id: [] },
    { last_attempt_outcome: "success" },
    { last_attempt_outcome: "FAILED" },
    { last_attempt_outcome: "failed,error" },
    { last_attempt_outcome: " failed" },
    { last_attempt_outcome: "failed " },
    { last_attempt_outcome: "" },
    { last_attempt_outcome: [] },
    { last_attempt_outcome: ["failed", "invalid"] },
    { last_attempt_outcome: ["failed", ""] },
    { last_attempt_outcome: "failed') OR 1=1 --" },
    { outcome: "success" },
    { outcome: "FAILED" },
    { outcome: "failed,error" },
    { outcome: " failed" },
    { outcome: "" },
    { outcome: [] },
    { outcome: ["failed", "invalid"] },
    { sort: "" },
    { sort: "started_at,-started_at" },
    { sort: "ended_at,ended_at" },
    { sort: "started_at,,ended_at" },
    { sort: "test_id" },
    { sort: "environments_id" },
    { sort: "env_vars_id" },
    { sort: "-runs" },
    { sort: "outcome,-outcome" },
    { owner: [] },
    { language: "Python" },
    { device_count: "256" },
    { rerun_number: "65536" },
    { rerun_number: "-1" },
    { rerun_number: "1,2" },
    { workflow_path: [] },
    { "env_vars[bad-name]": "value" },
    { "env_vars[__proto__]": "value" },
    { env_vars: "", "env_vars[MODE]": "test" },
    { ran_on: "main" },
    { window: "7d" },
    { limit: "0" },
    { limit: "2.5" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: ["25"] },
    { cursor: ["one", "two"] },
    { unknown: "value" },
  ])("rejects malformed or unsupported parameters %j", (raw) => {
    expect(
      parseCommitRunsListParams({ sha: SHA, repo: REPO, ...raw }).success
    ).toBe(false);
  });
});
