import { readFileSync } from "fs";
import path from "path";

// buildPrReviewSections reaches this SQL by name through queryClickhouseSaved, and
// the jest suites mock that call, so the row-selection rules are pinned here.
const SQL = readFileSync(
  path.join(
    __dirname,
    "../clickhouse_queries/pr_review_verdicts_for_prs/query.sql"
  ),
  "utf8"
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n")
  .replace(/\s+/g, " ");

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
