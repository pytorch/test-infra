import { readFileSync } from "fs";
import * as path from "path";

// autorevert_significant_reverts/query.sql and autorevert_weekly_metrics/query.sql
// share a large recovery-detection + causal-attribution pipeline (commits -> ... ->
// causally_attributed_recoveries). torchci sends each query.sql to ClickHouse
// verbatim (no SQL include mechanism), so the block is physically duplicated; only
// each query's final aggregation differs. The two copies already drifted once -- the
// #8176 causal red-streak filter had to be applied to both files separately, and
// fixing only the summary query left the weekly chart stale.
//
// To stop the copies from silently drifting again, the shared block is wrapped in
// @autorevert-shared-recovery-pipeline:begin / :end markers in both files, and this
// test fails CI when the marked regions are not byte-identical (or a marker is
// missing / duplicated), and when the two params.json declare different params.

const QUERY_DIR = path.resolve(__dirname, "..", "clickhouse_queries");
const SIGNIFICANT = "autorevert_significant_reverts";
const WEEKLY = "autorevert_weekly_metrics";

const BEGIN_MARKER = "-- @autorevert-shared-recovery-pipeline:begin";
const END_MARKER = "-- @autorevert-shared-recovery-pipeline:end";

function querySqlPath(name: string): string {
  return path.join(QUERY_DIR, name, "query.sql");
}

function paramsPath(name: string): string {
  return path.join(QUERY_DIR, name, "params.json");
}

// Extract the text between the shared-pipeline markers. The contract is literal byte
// identity, so the inner lines are NOT trimmed or normalized. Reading the file as
// utf8 preserves its existing line endings (Node does not translate them), so a CRLF
// copy and an LF copy would not compare equal.
export function extractSharedBlock(content: string, label: string): string {
  const lines = content.split("\n");
  const begins = lines.flatMap((line, i) =>
    line.trim() === BEGIN_MARKER ? [i] : []
  );
  const ends = lines.flatMap((line, i) =>
    line.trim() === END_MARKER ? [i] : []
  );
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `${label}: expected exactly one '${BEGIN_MARKER}' and one '${END_MARKER}' ` +
        `(found ${begins.length} begin, ${ends.length} end)`
    );
  }
  if (ends[0] <= begins[0]) {
    throw new Error(
      `${label}: '${END_MARKER}' must appear after '${BEGIN_MARKER}'`
    );
  }
  return lines.slice(begins[0] + 1, ends[0]).join("\n");
}

describe("autorevert shared recovery pipeline", () => {
  test("the shared block is byte-identical across both metrics queries", () => {
    const sig = extractSharedBlock(
      readFileSync(querySqlPath(SIGNIFICANT), "utf8"),
      SIGNIFICANT
    );
    const wk = extractSharedBlock(
      readFileSync(querySqlPath(WEEKLY), "utf8"),
      WEEKLY
    );
    expect(sig.length).toBeGreaterThan(0);
    // A fix to the recovery-detection / causal-attribution pipeline must land in
    // BOTH queries or neither -- see #8176, where it did not and the weekly chart
    // went stale. If this fails, copy the corrected marked block verbatim into both.
    expect(sig).toEqual(wk);
  });

  test("both queries declare identical params", () => {
    const sig = JSON.parse(readFileSync(paramsPath(SIGNIFICANT), "utf8"));
    const wk = JSON.parse(readFileSync(paramsPath(WEEKLY), "utf8"));
    // The shared pipeline binds the same parameters in both queries; their `tests`
    // windows may differ, but `params` must match.
    expect(sig.params).toEqual(wk.params);
  });

  describe("extractSharedBlock guard", () => {
    const inner = "body line 1\nbody line 2";
    const wrap = (body: string): string =>
      `header\n${BEGIN_MARKER}\n${body}\n${END_MARKER}\ntail`;

    test("extracts the inner block verbatim", () => {
      expect(extractSharedBlock(wrap(inner), "ok")).toEqual(inner);
    });

    test("throws when a marker is missing", () => {
      expect(() => extractSharedBlock("no markers here", "missing")).toThrow();
    });

    test("throws when a marker is duplicated", () => {
      expect(() =>
        extractSharedBlock(`${wrap(inner)}\n${BEGIN_MARKER}`, "duplicated")
      ).toThrow();
    });

    test("throws when end precedes begin", () => {
      expect(() =>
        extractSharedBlock(`${END_MARKER}\nx\n${BEGIN_MARKER}`, "reversed")
      ).toThrow();
    });
  });
});
