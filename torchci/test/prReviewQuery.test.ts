import { readFileSync } from "fs";
import path from "path";

// buildPrReviewSections reaches this SQL by name through queryClickhouseSaved, and
// the jest suites mock that call, so the row-selection rules are pinned here.
function readSql(name: string): string {
  return readFileSync(
    path.join(__dirname, `../clickhouse_queries/${name}/query.sql`),
    "utf8"
  )
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .replace(/\s+/g, " ");
}

const SQL = readSql("pr_review_verdicts_for_prs");

describe("pr_review_verdicts_for_prs", () => {
  it("filters on the sort-key prefix", () => {
    expect(SQL).toContain("repo = {repo: String}");
    expect(SQL).toContain("pr_number IN {prNumbers: Array(Int64)}");
  });

  it("prefers the newest run, then attempt, then the terminal row", () => {
    expect(SQL).toContain(
      "ORDER BY pr_number, review_run_id DESC, review_run_attempt DESC, phase = 'terminal' DESC, timestamp DESC LIMIT 1 BY pr_number"
    );
  });
});

// Read by the ready for review promotion (fetchPrReviewHeadVerdicts).
describe("pr_review_head_verdicts_for_prs", () => {
  const HEAD_SQL = readSql("pr_review_head_verdicts_for_prs");

  it("filters on the sort-key prefix in both halves", () => {
    expect(HEAD_SQL.split("repo = {repo: String}").length).toBe(3);
    expect(
      HEAD_SQL.split("pr_number IN {prNumbers: Array(Int64)}").length
    ).toBe(3);
  });

  it("keeps the newest finished run per head, ignoring started-only runs", () => {
    expect(HEAD_SQL).toContain(
      "AND phase = 'terminal' ORDER BY pr_number, head_sha, review_run_id DESC, review_run_attempt DESC, timestamp DESC LIMIT 1 BY pr_number, head_sha"
    );
  });

  it("takes the start time from the same run's started row", () => {
    expect(HEAD_SQL).toContain(
      "ON t.pr_number = s.pr_number AND t.head_sha = s.head_sha AND t.review_run_id = s.review_run_id AND t.review_run_attempt = s.review_run_attempt"
    );
    expect(HEAD_SQL).toContain(
      "if( s.has_started = 1, s.started_at, t.timestamp - toIntervalMillisecond(t.duration_ms) )"
    );
  });

  it("does not filter on harness", () => {
    expect(HEAD_SQL).not.toContain("harness");
  });
});
