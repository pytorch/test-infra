import fs from "fs";
import path from "path";

const queryDir = path.resolve(
  __dirname,
  "..",
  "clickhouse_queries",
  "crcr_level_history"
);
const sql = fs.readFileSync(path.join(queryDir, "query.sql"), "utf8");
const params = JSON.parse(
  fs.readFileSync(path.join(queryDir, "params.json"), "utf8")
);

describe("crcr_level_history query", () => {
  it("collapses a workflow run before detecting level transitions", () => {
    expect(sql).toContain("GROUP BY run_id");
    expect(sql).toContain("lagInFrame(new_level, 1, '')");
    expect(sql).toContain("previous_level != new_level");
  });

  it("returns the latest bounded history in chronological order", () => {
    expect(sql).toMatch(
      /recent_changes[\s\S]*ORDER BY changed_at DESC[\s\S]*LIMIT \{limit: UInt32\}/
    );
    expect(sql).toMatch(/FROM recent_changes\s+ORDER BY changed_at ASC/);
    expect(params).toMatchObject({
      params: { repo: "String", limit: "UInt32" },
      defaults: { limit: 100 },
    });
  });
});
