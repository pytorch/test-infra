import { GET } from "app/api/tests/commit/[sha]/jobs/route";
import { toJob, toJobTests } from "lib/api/tests/commit/jobs/jobs";
import { buildJobTestsQuery } from "lib/api/tests/commit/jobs/query";
import { CommitJobsSchema } from "lib/api/tests/commit/jobs/types";
import { buildCommitRunsQuery } from "lib/api/tests/commit/query";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import { jobRow, SHA, testsRow } from "test/api/tests/commit/jobs/fixtures";

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

describe("a commit's jobs", () => {
  test("a job's steps give its container and Test steps, and its slots become times", () => {
    const job = toJob(jobRow);
    expect(job.container_step).toEqual({
      started_at: "2026-11-14T05:02:05.000Z",
      completed_at: "2026-11-14T05:03:00.000Z",
    });
    // The Test step that ran, not the skipped one.
    expect(job.test_step).toEqual({
      started_at: "2026-11-14T05:10:00.000Z",
      completed_at: "2026-11-14T05:59:00.000Z",
    });
    expect(job.failed_step).toBe("Test");
    expect(toJobTests(testsRow)).toEqual({
      by_status: {
        failed: 1,
        timed_out: 0,
        flaky: 2,
        passed: 40,
        other: 0,
        xfailed: 3,
        skipped: 4,
      },
      // A stretch ends where its last slot does.
      running: [
        {
          started_at: "2026-11-14T05:10:00.000Z",
          ended_at: "2026-11-14T05:10:10.000Z",
        },
        {
          started_at: "2026-11-14T05:10:50.000Z",
          ended_at: "2026-11-14T05:10:55.000Z",
        },
      ],
      failing_attempts: { failed: 3, flaky: 2 },
    });
  });

  test("a job waiting for a runner has not started", () => {
    const job = toJob({
      ...jobRow,
      status: "queued",
      conclusion: "",
      started_at_ms: jobRow.created_at_ms,
      completed_at_ms: 0,
      step_names: [],
      step_conclusions: [],
      step_started_at_ms: [],
      step_completed_at_ms: [],
      failure_line: "",
    });
    expect(job).toMatchObject({
      started_at: null,
      completed_at: null,
      conclusion: null,
      test_step: null,
      container_step: null,
      failed_step: null,
      failure_line: null,
    });
  });

  test("a job that ended before a runner took it has not started: GitHub left its start at its creation", () => {
    const noSteps = {
      step_names: [],
      step_conclusions: [],
      step_started_at_ms: [],
      step_completed_at_ms: [],
    };
    const untaken = {
      ...jobRow,
      ...noSteps,
      conclusion: "cancelled",
      started_at_ms: jobRow.created_at_ms,
    };
    const early = (seconds: number) => ({
      ...untaken,
      started_at_ms: jobRow.created_at_ms - seconds * 1000,
    });
    for (const waited of [untaken, early(1)]) {
      expect(toJob(waited)).toMatchObject({
        started_at: null,
        completed_at: "2026-11-14T06:00:00.000Z",
      });
    }
    // A runner that took the job in the second it was created ran steps; a
    // job with a start of its own ran, whatever became of its steps, as one
    // a rerun carried over did, before it was created; and a job in progress
    // has a runner.
    for (const ran of [
      { ...jobRow, started_at_ms: jobRow.created_at_ms },
      { ...jobRow, ...noSteps },
      early(120),
      { ...untaken, status: "in_progress", conclusion: "" },
    ]) {
      expect(toJob(ran).started_at).not.toBeNull();
    }
  });

  test("the route answers the fields a request names, each from a read of its own", async () => {
    // The tests' rows come in the order of their IDs as text.
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, queryId) =>
        queryId === "api_commit_jobs"
          ? [jobRow]
          : [{ ...testsRow, job_id: "1000" }, testsRow]
      );
    const ask = async (...fields: string[]) => {
      query.mockClear();
      const res = await callRoute(GET, "/api/tests/commit/{sha}/jobs", {
        sha: SHA,
        repo: "pytorch/pytorch",
        fields,
      });
      expect(res.status).toBe(200);
      expect(CommitJobsSchema.parse(res.body)).toEqual(res.body);
      for (const [, params] of query.mock.calls) {
        expect(params).toEqual({ sha: SHA, repo: "pytorch/pytorch" });
      }
      return {
        fields: Object.keys(res.body).sort(),
        reads: query.mock.calls.map(([, , queryId]) => queryId).sort(),
        body: res.body,
      };
    };
    const always = ["hud_url", "query_duration_ms"];
    // Both without the parameter: the jobs, and beside them what the tests
    // of each did, by job ID, the shorter ID first.
    const whole = await ask();
    expect(whole.fields).toEqual([...always, "jobs", "tests"].sort());
    expect(whole.reads).toEqual(["api_commit_jobs", "api_commit_jobs_tests"]);
    expect(whole.body.jobs).toEqual([toJob(jobRow)]);
    expect(whole.body.tests).toEqual([
      { job_id: "101", ...toJobTests(testsRow) },
      { job_id: "1000", ...toJobTests(testsRow) },
    ]);
    expect(whole.body.jobs[0]).not.toHaveProperty("tests");
    // One field is one read.
    const jobs = await ask("jobs");
    expect(jobs.fields).toEqual([...always, "jobs"].sort());
    expect(jobs.reads).toEqual(["api_commit_jobs"]);
    const tests = await ask("tests");
    expect(tests.fields).toEqual([...always, "tests"].sort());
    expect(tests.reads).toEqual(["api_commit_jobs_tests"]);
    expect((await ask("tests", "jobs")).fields).toEqual(whole.fields);
    // The summary's fields are not the jobs'.
    query.mockClear();
    const res = await callRoute(GET, "/api/tests/commit/{sha}/jobs", {
      sha: SHA,
      repo: "pytorch/pytorch",
      fields: "commit",
    });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });

  test("the route rejects a malformed commit before querying", async () => {
    const query = jest.spyOn(clickhouse, "queryClickhouse");
    const res = await callRoute(GET, "/api/tests/commit/{sha}/jobs", {
      sha: "abc",
      repo: "pytorch/pytorch",
    });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });

  test("the test runs are read through the scope's filters alone", () => {
    const { sql, params } = buildJobTestsQuery({
      params: { job_id: "101" },
      filters: ["run.github_workflow_job_id = {job_id: Int64}"],
    });
    expect(params).toEqual({ job_id: "101" });
    expect(sql).not.toContain("matched_job_ids");
    expect(
      sql.match(/run\.github_workflow_job_id = \{job_id: Int64\}/g)
    ).not.toBeNull();
  });

  test("the stretches come from the gaps between slots, with no lookup in the array", () => {
    const { sql } = buildJobTestsQuery({
      params: { job_id: "101" },
      filters: ["run.github_workflow_job_id = {job_id: Int64}"],
    });
    expect(sql).toContain("arrayDifference(covered)");
    expect(sql).not.toContain("covered[");
  });
});

describe("the commit runs' job_id filter", () => {
  const base = {
    sha: SHA,
    repo: "pytorch/pytorch",
    sort: ["-started_at"],
    limit: 25,
  };

  test("narrows the scope's runs to the jobs, and leaves the query alone when absent", () => {
    const filtered = buildCommitRunsQuery(
      { ...base, job_id: ["101", "102"] },
      null
    );
    expect(filtered.params.filter_job_id).toEqual(["101", "102"]);
    expect(filtered.sql).toContain(
      "run.github_workflow_job_id IN CAST({filter_job_id: Array(String)}, 'Array(Int64)')"
    );
    const plain = buildCommitRunsQuery(base, null);
    expect(plain.params).not.toHaveProperty("filter_job_id");
    expect(plain.sql).not.toContain("filter_job_id");
  });
});
