import {
  commitRunsCursorMatchesQuery,
  commitRunsIdentity,
  decodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import { parseCommitRunsListParams } from "lib/api/tests/commit/parameters";
import {
  decodeRunsCursor,
  runsCursorMatchesQuery,
  runsIdentity,
} from "lib/api/tests/test/runs/cursor";
import { parseRunsListParams } from "lib/api/tests/test/runs/parameters";
import { runSortKeys } from "lib/api/tests/test/runs/query";
import { ENV_VARS_ID, ENVIRONMENT_ID, STARTED_AT, TEST_ID } from "./fixtures";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TEXT_SORTS = [
  "file",
  "suite",
  "case_name",
  "declared_case_name",
  "language",
  "owner",
  "os",
  "os_version",
  "cpu_architecture",
  "cpu_capability",
  "python_version",
  "cc_compiler",
  "cc_compiler_version",
  "accelerator",
  "accelerator_version",
  "device_name",
  "workflow_path",
];
const IDENTITY_VALUES: Record<string, string> = {
  tests_id: TEST_ID,
  environments_id: ENVIRONMENT_ID,
  env_vars_id: ENV_VARS_ID,
  started_at: String(Date.parse(STARTED_AT)),
  github_workflow_job_id: "-9223372036854775808",
  rerun_number: "65535",
};

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe.each([false, true])("run filter/sort cursor (commit=%s)", (commit) => {
  const decode = commit ? decodeCommitRunsCursor : decodeRunsCursor;

  function cursorWith(sort: string[], values: Record<string, unknown>) {
    return {
      version: 2,
      resource: commit ? "commit-runs" : "test-runs",
      query: {
        ...(commit
          ? { sha: SHA, repo: "pytorch/pytorch" }
          : { test_id: TEST_ID }),
        sort,
      },
      position: {
        values: runSortKeys({ sort }, commit).map(({ field }) =>
          Object.hasOwn(values, field) ? values[field] : IDENTITY_VALUES[field]
        ),
      },
    };
  }

  test("keeps absent env_vars absent when parsing and decoding a cursor", () => {
    const parsed = commit
      ? parseCommitRunsListParams({ sha: SHA, repo: "pytorch/pytorch" })
      : parseRunsListParams({ test_id: TEST_ID });
    if (!parsed.success) throw parsed.error;
    expect(parsed.data).not.toHaveProperty("env_vars");
    const cursor = cursorWith(["-started_at"], {});
    const decoded = decode(encode(cursor));
    expect(decoded).toEqual(cursor);
    expect(decoded!.query).not.toHaveProperty("env_vars");
  });

  test.each(TEXT_SORTS)(
    "preserves null, empty and literal text for %s in both directions",
    (field) => {
      for (const direction of ["", "-"]) {
        for (const value of [null, "", "0", "  a,b  ", "' OR 1=1 --\nλ雪😀"]) {
          const cursor = cursorWith([`${direction}${field}`], {
            [field]: value,
          });
          expect(decode(encode(cursor))).toEqual(cursor);
        }
        for (const value of [0, 255, false, {}, []]) {
          expect(
            decode(
              encode(cursorWith([`${direction}${field}`], { [field]: value }))
            )
          ).toBeNull();
        }
      }
    }
  );

  test.each(["device_count", "-device_count"])(
    "accepts null and UInt8 boundaries for %s but rejects wrong types and ranges",
    (sort) => {
      for (const value of [null, "0", "255"]) {
        const cursor = cursorWith([sort], { device_count: value });
        expect(decode(encode(cursor))).toEqual(cursor);
      }
      for (const value of ["-1", "256", "00", "01", "+1", "1.0", "", 0, 255]) {
        expect(
          decode(encode(cursorWith([sort], { device_count: value })))
        ).toBeNull();
      }
    }
  );

  test("requires nonnull outcomes and rerun numbers", () => {
    for (const field of ["outcome", "rerun_number"]) {
      expect(decode(encode(cursorWith([field], { [field]: null })))).toBeNull();
    }
    for (const value of ["unknown", "error", "passed", "xfailed"]) {
      const cursor = cursorWith(["outcome"], { outcome: value });
      expect(decode(encode(cursor))).toEqual(cursor);
    }
    for (const value of ["0", "65535"]) {
      const cursor = cursorWith(["-rerun_number"], { rerun_number: value });
      expect(decode(encode(cursor))).toEqual(cursor);
    }
    for (const value of ["-1", "65536", "01", "-0", "+1", "1e1", 0, false]) {
      expect(
        decode(encode(cursorWith(["rerun_number"], { rerun_number: value })))
      ).toBeNull();
    }
  });

  test("keeps the full bundle identity once after mixed nullable and attempt sorts", () => {
    const sort = ["owner", "-outcome", "device_count", "-rerun_number"];
    const keys = runSortKeys({ sort }, commit);
    expect(keys.map(({ field }) => field)).toEqual([
      "owner",
      "outcome",
      "device_count",
      "rerun_number",
      ...(commit ? ["tests_id"] : []),
      "environments_id",
      "env_vars_id",
      "github_workflow_job_id",
    ]);
    const cursor = cursorWith(sort, {
      owner: null,
      outcome: "failed",
      device_count: "0",
      rerun_number: "65535",
    });
    expect(decode(encode(cursor))).toEqual(cursor);
    expect(
      decode(
        encode({
          ...cursor,
          position: { values: cursor.position.values.slice(1) },
        })
      )
    ).toBeNull();
  });
});

test("both endpoint cursor identities normalize new filter sets and bind each selection", () => {
  const selections = [
    {
      owner: ["cuda", "core_tests", "core_tests"],
      file: ["test/z.py", "test/a.py", "test/a.py"],
      suite: ["", "Suite"],
      case_name: ["a,b", "λ雪"],
      declared_case_name: "test_example",
      language: ["python", "cpp", "python"],
      os: ["linux", "macos", "linux"],
      device_count: ["255", "0", "0"],
      workflow_path: [".github/workflows/z.yml", ".github/workflows/a.yml"],
      rerun_number: ["65535", "0", "0"],
      search: "",
      "env_vars[B]": ["z", "a", "a"],
      "env_vars[A]": "",
    },
    {
      owner: ["core_tests", "cuda"],
      file: ["test/a.py", "test/z.py"],
      suite: ["", "Suite"],
      case_name: ["a,b", "λ雪"],
      declared_case_name: "test_example",
      language: ["cpp", "python"],
      os: ["linux", "macos"],
      device_count: ["0", "255"],
      workflow_path: [".github/workflows/a.yml", ".github/workflows/z.yml"],
      rerun_number: ["0", "65535"],
      search: "",
      env_vars: JSON.stringify({ A: [""], B: ["a", "z"] }),
    },
  ];
  const parsedRuns = selections.map((selection) => {
    const result = parseRunsListParams({ test_id: TEST_ID, ...selection });
    if (!result.success) throw result.error;
    const { cursor: _cursor, ...query } = result.data;
    return query;
  });
  const parsedCommits = selections.map((selection) => {
    const result = parseCommitRunsListParams({
      sha: SHA,
      repo: "pytorch/pytorch",
      ...selection,
    });
    if (!result.success) throw result.error;
    const { cursor: _cursor, ...query } = result.data;
    return query;
  });
  const position = {
    values: [
      String(Date.parse(STARTED_AT)),
      ENVIRONMENT_ID,
      ENV_VARS_ID,
      "-9223372036854775808",
    ],
  };
  const runCursor = {
    version: 2 as const,
    resource: "test-runs" as const,
    query: runsIdentity(parsedRuns[0]),
    position,
  };
  const commitCursor = {
    version: 2 as const,
    resource: "commit-runs" as const,
    query: commitRunsIdentity(parsedCommits[0]),
    position: {
      values: [position.values[0], TEST_ID, ...position.values.slice(1)],
    },
  };
  expect(
    runsCursorMatchesQuery(runCursor, { ...parsedRuns[1], limit: 100 })
  ).toBe(true);
  expect(
    commitRunsCursorMatchesQuery(commitCursor, {
      ...parsedCommits[1],
      limit: 100,
    })
  ).toBe(true);
  expect(decodeRunsCursor(encode(runCursor))).toEqual(runCursor);
  expect(decodeCommitRunsCursor(encode(commitCursor))).toEqual(commitCursor);
  for (const field of [
    "owner",
    "file",
    "suite",
    "case_name",
    "declared_case_name",
    "language",
    "os",
    "device_count",
    "workflow_path",
    "rerun_number",
    "search",
    "env_vars",
  ]) {
    expect(
      runsCursorMatchesQuery(runCursor, {
        ...parsedRuns[1],
        [field]: undefined,
      })
    ).toBe(false);
    expect(
      commitRunsCursorMatchesQuery(commitCursor, {
        ...parsedCommits[1],
        [field]: undefined,
      })
    ).toBe(false);
  }
  const changedVariables = { env_vars: { A: [""], B: ["different"] } };
  expect(
    runsCursorMatchesQuery(runCursor, { ...parsedRuns[1], ...changedVariables })
  ).toBe(false);
  expect(
    commitRunsCursorMatchesQuery(commitCursor, {
      ...parsedCommits[1],
      ...changedVariables,
    })
  ).toBe(false);
});
