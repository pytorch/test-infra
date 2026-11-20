import { GET as getJobsRoute } from "app/api/tests/cost/coverage/jobs/route";
import { GET as getCoverageRoute } from "app/api/tests/cost/coverage/route";
import type { RawQuery } from "lib/api/parameters";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  costCoverageJobsUrl,
  costCoverageUrl,
  coverageEcho,
  jobsEcho,
} from "lib/api/tests/cost/contracts";
import {
  compactCoverage,
  compactJobs,
  coverageJobsQuery,
  coverageOwnedQuery,
  coverageTestsQuery,
  getCostCoverage,
  getCostCoverageJobs,
} from "lib/api/tests/cost/coverage";
import {
  CostCoverageJobsSchema,
  CostCoverageSchema,
} from "lib/api/tests/cost/types";
import { CI_WORKLOAD_HEAVY } from "lib/api/tests/database";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";

// The routes are behind the GitHub gate, which has its own tests (auth.test.ts);
// here the handlers answer as themselves.
jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const B = { from: "2026-11-12", to: "2026-11-18" };

describe("the coverage SQL", () => {
  test("splits test-job time into running, setup and idle, no reports and out of scope, each day as last computed", () => {
    const sql = coverageTestsQuery();
    expect(sql).toContain("NOT (empty({workflows: Array(String)})");
    expect(sql).toContain(
      "test_file = '', [('no_reports', occupancy_runner_milliseconds)]"
    );
    expect(sql).toContain("[('running', held_milliseconds),");
    // Unsigned: occupancy less held, never below 0.
    expect(sql).toContain(
      "toUInt64(greatest(occupancy_runner_milliseconds, held_milliseconds) - held_milliseconds)"
    );
    expect(sql).toContain("(day, computed_at) IN (");
    expect(sql).toContain("GROUP BY day_utc, segment, label");
    const owned = coverageOwnedQuery();
    expect(owned).toContain("test_file != ''");
    expect(owned).toContain("NOT has(owner_list, 'unattributed:no_owner')");
  });

  test("the jobs follow test_cost_mv's job rules, picked through the started_at view", () => {
    const sql = coverageJobsQuery();
    for (const rule of [
      "ORDER BY _inserted_at DESC\n  LIMIT 1 BY id",
      "status = 'completed'",
      "conclusion NOT IN ('skipped', '')",
      "runner_name != ''",
      "started_at >= created_at",
      "dateDiff('second', started_at, completed_at) BETWEEN 0 AND 86400",
      "SELECT id FROM materialized_views.workflow_job_by_started_at",
      "startsWith(repo, {org_prefix: String})",
      "arrayStringConcat(arraySort(labels), ',') AS label",
    ]) {
      expect([rule, sql.includes(rule)]).toEqual([rule, true]);
    }
  });
});

describe("compaction", () => {
  test("coverage: days ascending, labels most hours first, segments in COVERAGE_SEGMENTS order", () => {
    const out = compactCoverage([
      {
        day_utc: "2026-11-13",
        segment: "no_reports",
        label: "a",
        runner_hours: 1,
      },
      {
        day_utc: "2026-11-12",
        segment: "running",
        label: "b",
        runner_hours: 3,
      },
      {
        day_utc: "2026-11-12",
        segment: "setup_idle",
        label: "a",
        runner_hours: "0.5",
      },
      {
        day_utc: "2026-11-12",
        segment: "out_of_scope",
        label: "a",
        runner_hours: 2,
      },
    ]);
    expect(out).toEqual({
      days: ["2026-11-12", "2026-11-13"],
      labels: ["a", "b"],
      cells: [
        [0, 0, 1, 3],
        [0, 1, 0, 0.5],
        [0, 3, 0, 2],
        [1, 2, 0, 1],
      ],
    });
  });

  test("jobs: the repository's own hours are repo_all, the rest other_repos; repos counted", () => {
    const days = ["2026-11-12", "2026-11-13"];
    const out = compactJobs(
      "pytorch/pytorch",
      [
        {
          day_utc: "2026-11-12",
          repo: "pytorch/pytorch",
          label: "x",
          runner_hours: 4,
        },
        {
          day_utc: "2026-11-12",
          repo: "pytorch/vision",
          label: "x",
          runner_hours: 1,
        },
        {
          day_utc: "2026-11-12",
          repo: "pytorch/audio",
          label: "x",
          runner_hours: "0.25",
        },
        {
          day_utc: "2026-11-13",
          repo: "pytorch/vision",
          label: "y",
          runner_hours: 2,
        },
      ],
      days
    );
    expect(out).toEqual({
      repos: 3,
      labels: ["x", "y"],
      cells: [
        [0, 0, 0, 1.25],
        [0, 1, 0, 4],
        [1, 0, 1, 2],
      ],
    });
  });
});

describe("getCostCoverage and getCostCoverageJobs", () => {
  afterEach(() => jest.restoreAllMocks());

  test("coverage reads test_cost twice outside the heavy workload and echoes the request", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, id) =>
        id === "tests_cost_coverage"
          ? [
              {
                day_utc: "2026-11-12",
                segment: "running",
                label: "x",
                runner_hours: 3,
              },
            ]
          : [{ with_reports_h: "3", owned_h: 2.5 }]
      );
    const answer = await getCostCoverage({
      repo: "pytorch/pytorch",
      ...B,
      workflow: ["pull"],
    });
    expect(query.mock.calls.map((c) => [c[2], c[4]])).toEqual([
      ["tests_cost_coverage", undefined],
      ["tests_cost_coverage_owned", undefined],
    ]);
    expect(CostCoverageSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      with_reports_h: 3,
      owned_h: 2.5,
      cells: [[0, 0, 0, 3]],
    });
    expect(coverageEcho(answer)).toBe(
      costCoverageUrl("pytorch/pytorch", ["pull"], B)
    );
  });

  test("jobs run in the heavy workload, every day of the range indexed, and echo the request", async () => {
    const query = jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([
      {
        day_utc: "2026-11-18",
        repo: "pytorch/pytorch",
        label: "x",
        runner_hours: 4,
      },
    ]);
    const answer = await getCostCoverageJobs({ repo: "pytorch/pytorch", ...B });
    expect(query.mock.calls[0][4]).toBe(CI_WORKLOAD_HEAVY);
    expect(query.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      org_prefix: "pytorch/",
      ...B,
    });
    expect(CostCoverageJobsSchema.parse(answer)).toEqual(answer);
    expect(answer).toMatchObject({
      org: "pytorch",
      repos: 1,
      cells: [[6, 1, 0, 4]],
    });
    expect(jobsEcho(answer)).toBe(costCoverageJobsUrl("pytorch/pytorch", B));
  });
});

describe("app/api/tests/cost/coverage and coverage/jobs", () => {
  afterEach(() => jest.restoreAllMocks());

  const coverage = (q: RawQuery) =>
    callRoute(getCoverageRoute, "/api/tests/cost/coverage", q);
  const jobs = (q: RawQuery) =>
    callRoute(getJobsRoute, "/api/tests/cost/coverage/jobs", q);

  test.each([
    [
      coverage,
      { repo: "pytorch/pytorch", from: "2026-11-18", to: "2026-11-12" },
    ],
    [
      coverage,
      { repo: "pytorch/pytorch", from: "2025-01-01", to: "2026-11-18" },
    ],
    [coverage, { repo: "pytorch/pytorch", from: "2026-11-12" }],
    [jobs, { repo: "pytorch/pytorch", from: "2026-10-21", to: "2026-11-18" }],
    [
      jobs,
      {
        repo: "pytorch/pytorch",
        from: "2026-11-12",
        to: "2026-11-18",
        workflow: "pull",
      },
    ],
  ])("rejects a bad range before querying (%#)", async (call, query) => {
    const spy = jest.spyOn(clickhouse, "queryClickhouse");
    const res = await call(query);
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
    expect(spy).not.toHaveBeenCalled();
  });

  test("jobs over 28 days name the limit", async () => {
    const res = await jobs({
      repo: "pytorch/pytorch",
      from: "2026-10-21",
      to: "2026-11-18",
    });
    expect(res.body.issues[0].message).toMatch(/at most 28 days/);
  });

  test("28 days of jobs are answered, cached an hour; coverage ten minutes", async () => {
    jest.spyOn(clickhouse, "queryClickhouse").mockResolvedValue([]);
    const j = await jobs({
      repo: "pytorch/pytorch",
      from: "2026-10-22",
      to: "2026-11-18",
    });
    expect(j.status).toBe(200);
    expect(j.headers.get("Cache-Control")).toBe("private, max-age=3600");
    expect(j.body.cells).toEqual([]);
    const c = await coverage({ repo: "pytorch/pytorch", ...B });
    expect(c.status).toBe(200);
    expect(c.headers.get("Cache-Control")).toBe("private, max-age=600");
  });
});
