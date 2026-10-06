import fs from "fs";
import path from "path";

import {
  NightlyMatrixJob,
  paginateNightlyMatrix,
} from "lib/crcr/nightlyMatrix";

const query = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_dashboard",
    "query.sql"
  ),
  "utf8"
);
const params = fs.readFileSync(
  path.resolve(
    __dirname,
    "..",
    "clickhouse_queries",
    "crcr_nightly_dashboard",
    "params.json"
  ),
  "utf8"
);
const backendPage = fs.readFileSync(
  path.resolve(__dirname, "..", "pages", "crcr", "[org]", "[repo].tsx"),
  "utf8"
);

type Job = NightlyMatrixJob & { started_at: string };

const sha = (suffix: number) =>
  `${"a".repeat(38)}${suffix.toString(16).padStart(2, "0")}`;

describe("crcr_nightly_dashboard", () => {
  test("limits logical matrix rows before expanding their jobs", () => {
    const normalized = query.replace(/\s+/g, " ");
    const limitIndex = normalized.indexOf(
      "LIMIT {limit: UInt64} OFFSET {offset: UInt64}"
    );
    const jobsIndex = normalized.lastIndexOf("SELECT upstream_repo");

    expect(normalized).toContain("eligible_matrix_keys AS");
    expect(normalized).toContain("selected_matrix_keys AS");
    expect(normalized).toContain(
      "matrix_key IN (SELECT matrix_key FROM selected_matrix_keys)"
    );
    expect(limitIndex).toBeGreaterThan(-1);
    expect(jobsIndex).toBeGreaterThan(limitIndex);
    expect(normalized).not.toContain("LIMIT 500");
  });

  test("keeps every job for a selected nightly while paging matrix rows", () => {
    const jobs: Job[] = Array.from({ length: 65 }, (_, index) => ({
      job_name: `job-${index}`,
      run_id: "latest-run",
      pytorch_head_sha: sha(1),
      started_at: "2026-10-06T12:00:00Z",
      run_attempt: 1,
    }));

    for (let index = 2; index <= 101; index += 1) {
      jobs.push({
        job_name: "test",
        run_id: `run-${index}`,
        pytorch_head_sha: sha(index),
        started_at: `2026-10-05T${String(23 - (index % 24)).padStart(
          2,
          "0"
        )}:00:00Z`,
        run_attempt: 1,
      });
    }

    const matrix = paginateNightlyMatrix(jobs, 100);

    expect(matrix.hasNextPage).toBe(true);
    expect(matrix.rows).toHaveLength(100);
    expect(matrix.rows[0].jobs.size).toBe(65);
  });

  test("requests one extra matrix row to determine whether another page exists", () => {
    expect(params).toContain('"limit": "UInt64"');
    expect(params).toContain('"offset": "UInt64"');
    expect(backendPage).toContain("NIGHTLY_ROWS_PER_PAGE = 100");
    expect(backendPage).toContain("NIGHTLY_QUERY_ROW_LIMIT");
    expect(backendPage).toContain("Showing nightly matrix rows");
  });
});
