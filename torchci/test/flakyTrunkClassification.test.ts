import { readFileSync } from "fs";
import * as path from "path";

// The four flaky_trunk queries each carry their own copy of the advisor-verdict
// aggregation and the category precedence (torchci sends each query.sql verbatim,
// with no SQL include). The page's tiles, graph, tables and drill-down only agree
// while those copies are identical.

const QUERY_DIR = path.resolve(__dirname, "..", "clickhouse_queries");
const QUERIES = [
  "flaky_trunk_jobs",
  "flaky_trunk_timeseries",
  "flaky_trunk_runner_labels",
  "flaky_trunk_entity_runs",
];

function readQuery(name: string): string {
  return readFileSync(path.join(QUERY_DIR, name, "query.sql"), "utf8");
}

function between(content: string, start: string, end: string, label: string) {
  const from = content.indexOf(start);
  if (from < 0 || content.indexOf(start, from + 1) >= 0) {
    throw new Error(`${label}: expected exactly one '${start}'`);
  }
  const to = content.indexOf(end, from);
  if (to < 0) {
    throw new Error(`${label}: no '${end}' after '${start}'`);
  }
  return content.slice(from, to + end.length);
}

function advisorAgg(content: string, label: string): string {
  return between(
    content,
    "advisor_agg AS (",
    "GROUP BY head_sha, adv_norm\n)",
    label
  );
}

function categoryPrecedence(content: string, label: string): string[] {
  const block = between(content, "multiIf(", ") AS category", label);
  return block
    .split("\n")
    .slice(1, -1)
    .map((line) => line.trim().replace(/,$/, ""));
}

describe("flaky_trunk classification", () => {
  test("advisor_agg is identical across the four queries", () => {
    const [first, ...rest] = QUERIES;
    const expected = advisorAgg(readQuery(first), first);
    for (const name of rest) {
      expect(advisorAgg(readQuery(name), name)).toEqual(expected);
    }
  });

  test("category precedence is identical across the four queries", () => {
    for (const name of QUERIES) {
      expect(categoryPrecedence(readQuery(name), name)).toEqual([
        "is_red = 0, 0",
        "adv_real = 1, 1",
        "adv_infra = 1, 4",
        "adv_testflake = 1, 3",
        "persistent = 1, 1",
        "cov_real = 1, 1",
        "cov_testflake = 1, 3",
        "5",
      ]);
    }
  });

  test("coverage_ attribution verdicts are split from native ones", () => {
    // A coverage_ verdict is keyed to the observed commit, not the culprit, so its
    // related/not_related must not reach adv_real/adv_testflake (ranked above
    // persistence); its infra_issue does reach adv_infra.
    const agg = advisorAgg(readQuery(QUERIES[0]), QUERIES[0]);
    expect(agg).toMatch(
      /maxIf\(1, NOT is_coverage AND verdict IN \('related', 'revert'\)\)\s+AS advisor_real/
    );
    expect(agg).toMatch(
      /maxIf\(1, NOT is_coverage AND verdict IN \('not_related', 'garbage'\)\)\s+AS advisor_testflake/
    );
    expect(agg).toMatch(/maxIf\(1, verdict = 'infra_issue'\) AS advisor_infra/);
    expect(agg).toMatch(
      /maxIf\(1, is_coverage AND verdict IN \('related', 'revert'\)\)\s+AS coverage_real/
    );
    expect(agg).toMatch(
      /maxIf\(1, is_coverage AND verdict IN \('not_related', 'garbage'\)\)\s+AS coverage_testflake/
    );
  });
});
