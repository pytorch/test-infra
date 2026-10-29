import {
  decodeRunsCursor,
  encodeRunsCursor,
  RunsCursor,
  runsCursorMatchesQuery,
  runsIdentity,
} from "lib/api/tests/test/runs/cursor";
import {
  parseRunsListParams,
  RunsListQuery,
} from "lib/api/tests/test/runs/parameters";
import { runSortKeys } from "lib/api/tests/test/runs/query";
import {
  baseCursor,
  baseQuery,
  ENV_VARS_ID,
  ENVIRONMENT_ID,
  SORT_CASES,
  STARTED_AT,
  TEST_ID,
} from "./fixtures";

function encoded(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function withValue(index: number, value: unknown) {
  return {
    ...baseCursor,
    position: {
      values: baseCursor.position.values.map((original, i) =>
        i === index ? value : original
      ),
    },
  };
}

describe("test runs cursor", () => {
  test("round-trips millisecond precision, UInt64 IDs and signed Int64 job IDs", () => {
    expect(decodeRunsCursor(encodeRunsCursor(baseCursor))).toEqual(baseCursor);
  });

  test("preserves existing cursors when the last-attempt filter is omitted", () => {
    const decoded = decodeRunsCursor(encoded(baseCursor));
    expect(decoded).toEqual(baseCursor);
    expect(
      runsCursorMatchesQuery(decoded!, {
        ...baseQuery,
        last_attempt_outcome: undefined,
      })
    ).toBe(true);
    expect(
      runsCursorMatchesQuery(decoded!, {
        ...baseQuery,
        last_attempt_outcome: ["passed"],
      })
    ).toBe(false);
  });

  test("round-trips a cursor with a last-attempt outcome filter", () => {
    const filtered = {
      ...baseQuery,
      last_attempt_outcome: ["passed" as const],
    };
    const filteredCursor = { ...baseCursor, query: runsIdentity(filtered) };
    const decoded = decodeRunsCursor(encodeRunsCursor(filteredCursor));
    expect(decoded).toEqual(filteredCursor);
    expect(runsCursorMatchesQuery(decoded!, filtered)).toBe(true);
    expect(runsCursorMatchesQuery(decoded!, baseQuery)).toBe(false);
  });

  test.each([
    { key: "timestamp", index: 0, value: String(Date.UTC(1900, 0, 1)) },
    { key: "timestamp", index: 0, value: String(Date.UTC(2300, 0, 1) - 1) },
    { key: "timestamp", index: 0, value: "0" },
    { key: "environment", index: 1, value: "0" },
    { key: "environment", index: 1, value: "18446744073709551615" },
    { key: "env vars", index: 2, value: "18446744073709551615" },
    { key: "job", index: 3, value: "-9223372036854775808" },
    { key: "job", index: 3, value: "9223372036854775807" },
  ])("accepts the $key boundary $value", ({ index, value }) => {
    const cursor = withValue(index, value);
    expect(decodeRunsCursor(encoded(cursor))).toEqual(cursor);
  });

  test.each([
    { index: 0, value: String(Date.UTC(1900, 0, 1) - 1) },
    { index: 0, value: String(Date.UTC(2300, 0, 1)) },
    { index: 0, value: STARTED_AT },
    { index: 0, value: "1792427293575.5" },
    { index: 0, value: Date.parse(STARTED_AT) },
    { index: 0, value: null },
    { index: 0, value: "NaN" },
    { index: 1, value: "18446744073709551616" },
    { index: 1, value: "-1" },
    { index: 2, value: "18446744073709551616" },
    { index: 2, value: "-1" },
    { index: 3, value: "-9223372036854775809" },
    { index: 3, value: "9223372036854775808" },
    { index: 1, value: "01" },
    { index: 1, value: "-0" },
    { index: 1, value: "1e1" },
    { index: 1, value: "1' OR 1=1 --" },
    { index: 1, value: " 1" },
    { index: 1, value: "+1" },
  ])("rejects invalid key $index = $value", ({ index, value }) => {
    expect(decodeRunsCursor(encoded(withValue(index, value)))).toBeNull();
  });

  test.each([
    null,
    [],
    { ...baseCursor, version: 1 },
    { ...baseCursor, version: 3 },
    { ...baseCursor, resource: "tests" },
    { ...baseCursor, extra: true },
    { ...baseCursor, position: { ...baseCursor.position, extra: true } },
    { ...baseCursor, query: { ...baseCursor.query, limit: 1 } },
    { ...baseCursor, query: { ...baseCursor.query, test_id: "-1" } },
    {
      ...baseCursor,
      query: { ...baseCursor.query, last_attempt_outcome: ["invalid"] },
    },
    { ...baseCursor, query: { ...baseCursor.query, last_attempt_outcome: [] } },
    {
      ...baseCursor,
      query: { ...baseCursor.query, last_attempt_outcome: "failed" },
    },
    { ...baseCursor, query: { ...baseCursor.query, outcome: ["invalid"] } },
    { ...baseCursor, query: { ...baseCursor.query, outcome: [] } },
    { ...baseCursor, query: { ...baseCursor.query, outcome: "failed" } },
    {
      ...baseCursor,
      query: { ...baseCursor.query, sort: ["github_workflow_job_id"] },
    },
    {
      ...baseCursor,
      query: { ...baseCursor.query, sort: ["started_at", "-started_at"] },
    },
    {
      ...baseCursor,
      position: { values: baseCursor.position.values.slice(1) },
    },
    {
      ...baseCursor,
      position: { values: [...baseCursor.position.values, "0"] },
    },
  ])(
    "rejects malformed envelopes and incompatible cursor shapes: %#",
    (value) => {
      expect(decodeRunsCursor(encoded(value))).toBeNull();
    }
  );

  test("rejects undecodable tokens", () => {
    for (const value of ["", "not-a-cursor", encoded("not-an-object")]) {
      expect(decodeRunsCursor(value)).toBeNull();
    }
  });

  test("rejects cursors issued before attempt bundling", () => {
    expect(
      decodeRunsCursor(
        encoded({
          ...baseCursor,
          version: 1,
          position: { values: [...baseCursor.position.values, "0"] },
        })
      )
    ).toBeNull();
  });

  test.each(SORT_CASES)(
    "includes the full bundle identity once for $sort",
    ({ sort }) => {
      const keys = runSortKeys({ sort });
      const identity = [
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
        started_at: "-2208988800000",
        ended_at: String(Date.UTC(2300, 0, 1) - 1),
        environments_id: ENVIRONMENT_ID,
        env_vars_id: ENV_VARS_ID,
        github_workflow_job_id: "-9223372036854775808",
        rerun_number: "65535",
      };
      const cursor: RunsCursor = {
        ...baseCursor,
        query: { ...baseCursor.query, sort },
        position: { values: keys.map(({ field }) => values[field]) },
      };
      expect(decodeRunsCursor(encodeRunsCursor(cursor))).toEqual(cursor);
      expect(
        decodeRunsCursor(
          encoded({
            ...cursor,
            position: { values: cursor.position.values.slice(1) },
          })
        )
      ).toBeNull();
    }
  );

  test("binds test ID, filters and ordering while allowing a new page size", () => {
    const query: RunsListQuery = {
      ...baseQuery,
      environments_id: ["10", ENVIRONMENT_ID],
      env_vars_id: ["20", ENV_VARS_ID],
      outcome: ["error", "failed"],
      last_attempt_outcome: ["failed", "passed"],
      sort: ["-ended_at", "started_at"],
    };
    const cursor = { ...baseCursor, query: runsIdentity(query) };
    expect(cursor.query).toEqual({
      test_id: TEST_ID,
      environments_id: ["10", ENVIRONMENT_ID],
      env_vars_id: ["20", ENV_VARS_ID],
      outcome: ["error", "failed"],
      last_attempt_outcome: ["failed", "passed"],
      sort: ["-ended_at", "started_at"],
    });
    expect(runsCursorMatchesQuery(cursor, { ...query, limit: 1000 })).toBe(
      true
    );
    for (const changed of [
      { test_id: "1" },
      { environments_id: ["10"] },
      { environments_id: undefined },
      { env_vars_id: ["20"] },
      { env_vars_id: undefined },
      { outcome: ["failed" as const] },
      { outcome: undefined },
      { last_attempt_outcome: ["passed" as const] },
      { last_attempt_outcome: undefined },
      { sort: ["ended_at", "started_at"] },
      { sort: ["started_at", "-ended_at"] },
    ]) {
      expect(runsCursorMatchesQuery(cursor, { ...query, ...changed })).toBe(
        false
      );
    }
  });

  test("normalizes equivalent filter sets before matching cursor identity", () => {
    const queries = [
      {
        environments_id: ["9", "1", "9"],
        env_vars_id: ["4", "3", "4"],
        outcome: ["failed", "error", "failed"],
        last_attempt_outcome: ["passed", "failed", "passed"],
      },
      {
        environments_id: ["1", "9"],
        env_vars_id: ["3", "4"],
        outcome: ["error", "failed"],
        last_attempt_outcome: ["failed", "passed"],
      },
    ].map((filters) => {
      const result = parseRunsListParams({ test_id: TEST_ID, ...filters });
      if (!result.success) throw result.error;
      const { cursor: _cursor, ...query } = result.data;
      return query;
    });
    const cursor = { ...baseCursor, query: runsIdentity(queries[0]) };
    expect(runsCursorMatchesQuery(cursor, queries[1])).toBe(true);
    expect(
      runsIdentity({
        ...baseQuery,
        environments_id: undefined,
        outcome: undefined,
        last_attempt_outcome: undefined,
      })
    ).toEqual(baseCursor.query);
  });
});
