import {
  CommitRunsCursor,
  commitRunsCursorMatchesQuery,
  commitRunsIdentity,
  decodeCommitRunsCursor,
  encodeCommitRunsCursor,
} from "lib/api/tests/commit/cursor";
import {
  CommitRunsListQuery,
  parseCommitRunsListParams,
} from "lib/api/tests/commit/parameters";
import { runSortKeys } from "lib/api/tests/test/runs/query";
import {
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  SORT_CASES,
  STARTED_AT,
  TEST_ID,
} from "../test/runs/fixtures";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const query: CommitRunsListQuery = {
  sha: SHA,
  repo: "pytorch/pytorch",
  sort: ["-started_at"],
  limit: 2,
};
const cursor: CommitRunsCursor = {
  version: 2,
  resource: "commit-runs",
  query: { sha: SHA, repo: query.repo, sort: query.sort },
  position: {
    values: [
      String(Date.parse(STARTED_AT)),
      TEST_ID,
      ENVIRONMENT_ID,
      ENV_VARS_ID,
      "-9223372036854775808",
    ],
  },
};

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function withValue(index: number, value: unknown) {
  return {
    ...cursor,
    position: {
      values: cursor.position.values.map((original, i) =>
        i === index ? value : original
      ),
    },
  };
}

describe("commit runs cursor", () => {
  test("round-trips milliseconds, UInt64 test IDs and signed Int64 job IDs", () => {
    expect(decodeCommitRunsCursor(encodeCommitRunsCursor(cursor))).toEqual(
      cursor
    );
  });

  test("preserves existing cursors when the last-attempt filter is omitted", () => {
    const decoded = decodeCommitRunsCursor(encoded(cursor));
    expect(decoded).toEqual(cursor);
    expect(
      commitRunsCursorMatchesQuery(decoded!, {
        ...query,
        last_attempt_outcome: undefined,
      })
    ).toBe(true);
    expect(
      commitRunsCursorMatchesQuery(decoded!, {
        ...query,
        last_attempt_outcome: ["passed"],
      })
    ).toBe(false);
  });

  test("round-trips a cursor with a last-attempt outcome filter", () => {
    const filtered = { ...query, last_attempt_outcome: ["passed" as const] };
    const filteredCursor = { ...cursor, query: commitRunsIdentity(filtered) };
    const decoded = decodeCommitRunsCursor(
      encodeCommitRunsCursor(filteredCursor)
    );
    expect(decoded).toEqual(filteredCursor);
    expect(commitRunsCursorMatchesQuery(decoded!, filtered)).toBe(true);
    expect(commitRunsCursorMatchesQuery(decoded!, query)).toBe(false);
  });

  test.each([
    { index: 0, value: String(Date.UTC(1900, 0, 1)) },
    { index: 0, value: String(Date.UTC(2300, 0, 1) - 1) },
    { index: 1, value: "0" },
    { index: 1, value: "18446744073709551615" },
    { index: 2, value: "18446744073709551615" },
    { index: 3, value: "18446744073709551615" },
    { index: 4, value: "9223372036854775807" },
    { index: 4, value: "-9223372036854775808" },
  ])("accepts key $index at its boundary $value", ({ index, value }) => {
    const boundary = withValue(index, value);
    expect(decodeCommitRunsCursor(encoded(boundary))).toEqual(boundary);
  });

  test.each([
    { index: 0, value: String(Date.UTC(1900, 0, 1) - 1) },
    { index: 0, value: String(Date.UTC(2300, 0, 1)) },
    { index: 0, value: STARTED_AT },
    { index: 0, value: Date.parse(STARTED_AT) },
    { index: 0, value: "1790000000123.5" },
    { index: 1, value: "18446744073709551616" },
    { index: 1, value: "-1" },
    { index: 1, value: "01" },
    { index: 1, value: "1e1" },
    { index: 1, value: null },
    { index: 2, value: "-1" },
    { index: 3, value: "18446744073709551616" },
    { index: 4, value: "9223372036854775808" },
    { index: 4, value: "-9223372036854775809" },
    { index: 4, value: "+1" },
    { index: 1, value: "-0" },
    { index: 1, value: "1' OR 1=1 --" },
  ])("rejects invalid key $index = $value", ({ index, value }) => {
    expect(decodeCommitRunsCursor(encoded(withValue(index, value)))).toBeNull();
  });

  test.each([
    null,
    [],
    { ...cursor, version: 1 },
    { ...cursor, version: 3 },
    { ...cursor, resource: "test-runs" },
    { ...cursor, extra: true },
    { ...cursor, query: { ...cursor.query, test_id: "1" } },
    { ...cursor, query: { ...cursor.query, limit: 1 } },
    { ...cursor, query: { ...cursor.query, sha: "abc123" } },
    { ...cursor, query: { ...cursor.query, repo: "invalid" } },
    {
      ...cursor,
      query: { ...cursor.query, last_attempt_outcome: ["invalid"] },
    },
    { ...cursor, query: { ...cursor.query, last_attempt_outcome: [] } },
    { ...cursor, query: { ...cursor.query, last_attempt_outcome: "failed" } },
    { ...cursor, query: { ...cursor.query, outcome: [] } },
    { ...cursor, query: { ...cursor.query, outcome: ["invalid"] } },
    { ...cursor, query: { ...cursor.query, sort: ["tests_id"] } },
    {
      ...cursor,
      query: { ...cursor.query, sort: ["started_at", "-started_at"] },
    },
    { ...cursor, position: { ...cursor.position, extra: true } },
    { ...cursor, position: { values: cursor.position.values.slice(1) } },
    {
      ...cursor,
      position: { values: [...cursor.position.values, "0"] },
    },
  ])("rejects malformed or incompatible envelopes: %#", (value) => {
    expect(decodeCommitRunsCursor(encoded(value))).toBeNull();
  });

  test("rejects undecodable tokens", () => {
    for (const value of ["", "not-a-cursor", encoded("not-an-object")]) {
      expect(decodeCommitRunsCursor(value)).toBeNull();
    }
  });

  test("rejects cursors issued before attempt bundling", () => {
    expect(
      decodeCommitRunsCursor(
        encoded({
          ...cursor,
          version: 1,
          position: { values: [...cursor.position.values, "0"] },
        })
      )
    ).toBeNull();
  });

  test.each(SORT_CASES)(
    "includes tests_id in the complete bundle identity for $sort",
    ({ sort }) => {
      const keys = runSortKeys({ sort }, true);
      const identity = [
        "tests_id",
        "environments_id",
        "env_vars_id",
        "github_workflow_job_id",
      ];
      const requested = sort.map((field) => field.replace(/^-/, ""));
      expect(keys.map(({ field }) => field)).toEqual([
        ...requested,
        ...identity.filter((field) => !requested.includes(field)),
      ]);
      expect(keys.map(({ direction }) => direction)).toEqual([
        ...sort.map((field) => (field.startsWith("-") ? "DESC" : "ASC")),
        ...identity
          .filter((field) => !requested.includes(field))
          .map(() => "ASC"),
      ]);
      const values: Record<string, string> = {
        started_at: String(Date.UTC(1900, 0, 1)),
        ended_at: String(Date.UTC(2300, 0, 1) - 1),
        tests_id: TEST_ID,
        environments_id: ENVIRONMENT_ID,
        env_vars_id: ENV_VARS_ID,
        github_workflow_job_id: "-9223372036854775808",
        rerun_number: "65535",
      };
      const sortedCursor: CommitRunsCursor = {
        ...cursor,
        query: { ...cursor.query, sort },
        position: { values: keys.map(({ field }) => values[field]) },
      };
      expect(
        decodeCommitRunsCursor(encodeCommitRunsCursor(sortedCursor))
      ).toEqual(sortedCursor);
    }
  );

  test("binds repository, SHA, filters and sorting while allowing a different limit", () => {
    const filtered: CommitRunsListQuery = {
      ...query,
      environments_id: ["10", ENVIRONMENT_ID],
      env_vars_id: ["20", ENV_VARS_ID],
      outcome: ["error", "failed"],
      last_attempt_outcome: ["failed", "passed"],
      sort: ["-ended_at", "started_at"],
    };
    const filteredCursor = { ...cursor, query: commitRunsIdentity(filtered) };
    expect(filteredCursor.query).toEqual({
      sha: SHA,
      repo: query.repo,
      environments_id: ["10", ENVIRONMENT_ID],
      env_vars_id: ["20", ENV_VARS_ID],
      outcome: ["error", "failed"],
      last_attempt_outcome: ["failed", "passed"],
      sort: ["-ended_at", "started_at"],
    });
    expect(
      commitRunsCursorMatchesQuery(filteredCursor, { ...filtered, limit: 100 })
    ).toBe(true);
    for (const changed of [
      { sha: "0".repeat(40) },
      { repo: "pytorch/vision" },
      { environments_id: ["10"] },
      { environments_id: undefined },
      { env_vars_id: ["20"] },
      { outcome: ["failed" as const] },
      { outcome: undefined },
      { last_attempt_outcome: ["passed" as const] },
      { last_attempt_outcome: undefined },
      { sort: ["ended_at", "started_at"] },
      { sort: ["started_at", "-ended_at"] },
    ]) {
      expect(
        commitRunsCursorMatchesQuery(filteredCursor, {
          ...filtered,
          ...changed,
        })
      ).toBe(false);
    }
  });

  test("normalizes SHA casing and equivalent filter sets before matching", () => {
    const queries = [
      {
        sha: SHA.toUpperCase(),
        environments_id: ["09", "1", "9"],
        env_vars_id: ["4", "3", "4"],
        outcome: ["failed", "error", "failed"],
        last_attempt_outcome: ["passed", "failed", "passed"],
      },
      {
        sha: SHA,
        environments_id: ["1", "9"],
        env_vars_id: ["3", "4"],
        outcome: ["error", "failed"],
        last_attempt_outcome: ["failed", "passed"],
      },
    ].map((filters) => {
      const result = parseCommitRunsListParams({
        repo: query.repo,
        ...filters,
      });
      if (!result.success) throw result.error;
      const { cursor: _cursor, ...parsed } = result.data;
      return parsed;
    });
    const normalized = { ...cursor, query: commitRunsIdentity(queries[0]) };
    expect(commitRunsCursorMatchesQuery(normalized, queries[1])).toBe(true);
    expect(
      commitRunsIdentity({
        ...query,
        environments_id: undefined,
        outcome: undefined,
        last_attempt_outcome: undefined,
      })
    ).toEqual(cursor.query);
  });
});
