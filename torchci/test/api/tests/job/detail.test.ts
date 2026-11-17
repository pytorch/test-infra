import { GET } from "app/api/tests/job/[job_id]/route";
import { toJob, toJobTests } from "lib/api/tests/commit/jobs/jobs";
import { JobFileRow, toFiles } from "lib/api/tests/job/detail";
import { JobDetailSchema } from "lib/api/tests/job/types";
import * as clickhouse from "lib/clickhouse";
import { callRoute } from "test/api/routes";
import { jobRow, testsRow } from "test/api/tests/commit/jobs/fixtures";

jest.mock("lib/api/auth", () => ({
  requireGithubWriteAccess: (handler: unknown) => handler,
}));

const counts = {
  failed: 0,
  timed_out: 0,
  flaky: 0,
  passed: 0,
  other: 0,
  xfailed: 0,
  skipped: 0,
};
const report = (row: Partial<JobFileRow>): JobFileRow => ({
  ...counts,
  file: "test/test_nn.py",
  first_started_at: "2026-11-14T05:10:00.000Z",
  last_ended_at: "2026-11-14T05:20:00.000Z",
  executed_attempts: 10,
  failed_attempts: 0,
  flaky_attempts: 0,
  ...row,
});

// One file run twice, the second a rerun in which a failure stood; a file
// whose tests were all skipped; and one with a failure that passed later.
const fileRows: JobFileRow[] = [
  report({ passed: 9 }),
  report({ file: "test/test_ops.py", executed_attempts: 0, skipped: 5 }),
  report({
    first_started_at: "2026-11-14T05:21:00.000Z",
    last_ended_at: "2026-11-14T05:22:00.000Z",
    failed: 1,
    failed_attempts: 3,
  }),
  report({
    file: "test/test_jit.py",
    flaky: 1,
    flaky_attempts: 1,
  }),
];

describe("a job's detail", () => {
  test("folds the reports into files, in the order the files first ran", () => {
    const files = toFiles(fileRows);
    expect(files.map((file) => file.file)).toEqual([
      "test/test_nn.py",
      "test/test_ops.py",
      "test/test_jit.py",
    ]);
    expect(files[0].tests_by_status).toMatchObject({ passed: 9, failed: 1 });
    expect(files[0].runs.map((run) => run.status)).toEqual([
      "passed",
      "failed",
    ]);
    expect(files[0].failing_attempts).toEqual({ failed: 3, flaky: 0 });
    expect(files[1].runs[0].status).toBe("skipped");
    expect(files[2].runs[0].status).toBe("flaky");
  });

  test("the route answers the job, what its tests did beside it, its steps and files, and its page", async () => {
    let tests = [testsRow];
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockImplementation(async (_sql, _params, queryId) =>
        queryId === "api_job"
          ? [jobRow]
          : queryId === "api_job_tests"
          ? tests
          : fileRows
      );
    const get = () =>
      callRoute(GET, "/api/tests/job/{job_id}", { job_id: "101" });
    const res = await get();
    expect(res.status).toBe(200);
    expect(JobDetailSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.job).toEqual(toJob(jobRow));
    expect(res.body.tests).toEqual(toJobTests(testsRow));
    // A job with no retained test run has none.
    tests = [];
    expect((await get()).body.tests).toBeNull();
    expect(res.body.steps).toHaveLength(5);
    expect(res.body.files).toHaveLength(3);
    expect(res.body.hud_url).toBe(
      "https://hud.pytorch.org/tests/pytorch/pytorch/commit/0123456789abcdef0123456789abcdef01234567?job_id=101"
    );
    query.mockRestore();
  });

  test("the route answers 404 for a job HUD does not know, 400 for a malformed ID", async () => {
    const query = jest
      .spyOn(clickhouse, "queryClickhouse")
      .mockResolvedValue([]);
    const unknown = await callRoute(GET, "/api/tests/job/{job_id}", {
      job_id: "101",
    });
    expect(unknown.status).toBe(404);
    query.mockClear();
    // An ID past an Int64, which the queries bind it as, is malformed too.
    for (const job_id of ["1 OR 1", "9".repeat(19)]) {
      const malformed = await callRoute(GET, "/api/tests/job/{job_id}", {
        job_id,
      });
      expect(malformed.status).toBe(400);
    }
    expect(query).not.toHaveBeenCalled();
    query.mockRestore();
  });
});
