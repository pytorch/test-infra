import { SeekKey, seekOrderBy, seekPredicate } from "lib/api/seek";

const keys: SeekKey[] = [
  {
    column: "run.started_at",
    parameterType: "Int64",
    bind: (placeholder) => `fromUnixTimestamp64Milli(${placeholder})`,
    direction: "DESC",
    nullable: false,
  },
  {
    column: "run_test.file",
    parameterType: "String",
    direction: "ASC",
    nullable: true,
  },
  {
    column: "run.tests_id",
    parameterType: "UInt64",
    direction: "ASC",
    nullable: false,
  },
];
const started = "fromUnixTimestamp64Milli({cursor_0: Int64})";

describe("seekPredicate", () => {
  test("selects everything without a cursor", () => {
    const params = {};
    expect(seekPredicate(keys, null, params)).toBe("1");
    expect(params).toEqual({});
  });

  test("seeks past the position with equality on preceding keys and NULLs last", () => {
    const params: Record<string, unknown> = {};
    const sql = seekPredicate(
      keys,
      {
        direction: "next",
        position: { values: ["1700000000000", "test/a.py", "7"] },
      },
      params
    );
    expect(sql).toBe(
      `(run.started_at < ${started}) OR (run.started_at = ${started} AND (run_test.file > {cursor_1: String} OR isNull(run_test.file))) OR (run.started_at = ${started} AND run_test.file = {cursor_1: String} AND run.tests_id > {cursor_2: UInt64})`
    );
    expect(params).toEqual({
      cursor_0: "1700000000000",
      cursor_1: "test/a.py",
      cursor_2: "7",
    });
  });

  test("continues only among NULLs after a NULL position value", () => {
    const params = {};
    expect(
      seekPredicate(keys, { position: { values: ["1", null, "7"] } }, params)
    ).toBe(
      `(run.started_at < ${started}) OR (run.started_at = ${started} AND isNull(run_test.file) AND run.tests_id > {cursor_2: UInt64})`
    );
    expect(params).toEqual({ cursor_0: "1", cursor_2: "7" });
  });

  test("reverses comparisons and returns to non-null values going backward", () => {
    expect(
      seekPredicate(
        keys,
        { direction: "previous", position: { values: ["1", null, "7"] } },
        {}
      )
    ).toBe(
      `(run.started_at > ${started}) OR (run.started_at = ${started} AND isNotNull(run_test.file)) OR (run.started_at = ${started} AND isNull(run_test.file) AND run.tests_id < {cursor_2: UInt64})`
    );
  });

  test("selects nothing beyond a position that is NULL in every key", () => {
    expect(seekPredicate([keys[1]], { position: { values: [null] } }, {})).toBe(
      "0"
    );
  });
});

describe("seekOrderBy", () => {
  test("orders nullable keys with an explicit NULL placement", () => {
    expect(seekOrderBy(keys, false)).toBe(
      "run.started_at DESC, run_test.file ASC NULLS LAST, run.tests_id ASC"
    );
    expect(seekOrderBy(keys, true)).toBe(
      "run.started_at ASC, run_test.file DESC NULLS FIRST, run.tests_id DESC"
    );
  });
});
