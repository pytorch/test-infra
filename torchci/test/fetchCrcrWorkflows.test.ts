import { queryClickhouse } from "../lib/clickhouse";
import {
  fetchCrcrActivityPRs,
  fetchCrcrWorkflows,
} from "../lib/fetchRecentWorkflows";

// The real module opens a ClickHouse client at import time, which the oracle for
// this test is not: it is only the row-to-job mapping that matters here.
jest.mock("../lib/clickhouse", () => ({
  queryClickhouse: jest.fn(),
  queryClickhouseSaved: jest.fn(),
}));

const queryClickhouseMock = queryClickhouse as jest.MockedFunction<
  typeof queryClickhouse
>;

// The columns fetchCrcrWorkflows names in its SELECT, as ClickHouse returns
// them: snake_case, with the check run id as a string.
function row(overrides: Record<string, unknown> = {}) {
  return {
    name: "CRCR L3 CI",
    jobName: "test-L3-checkrun-creation",
    pr_number: "123",
    id: "456",
    conclusion: "failure",
    completed_at: "2023-08-08 06:03:21",
    html_url: "https://github.com/pytorch/crcr-test/actions/runs/555",
    head_sha: "abcdef1234567890",
    downstream_repo: "pytorch/crcr-test",
    downstream_repo_level: "L3",
    run_attempt: 2,
    run_id: "999",
    ...overrides,
  };
}

describe("fetchCrcrWorkflows", () => {
  beforeEach(() => {
    queryClickhouseMock.mockReset();
  });

  test("returns every job that reported, not only the failures", async () => {
    queryClickhouseMock.mockResolvedValue([
      row(),
      row({ conclusion: "success", jobName: "test-L3-cancel-checkrun" }),
    ]);

    const jobs = await fetchCrcrWorkflows("pytorch/pytorch", [123]);
    expect(jobs).toHaveLength(2);

    // The denominator of "N of M jobs failed" needs the passing rows, so the
    // query must not filter on the conclusion. It must not filter on the status
    // either: a job still running is one of the M, and leaving it out makes a
    // matrix mid-flight read as a small matrix that all failed. run_id places a
    // row in its run, which run_attempt alone cannot.
    const sql = queryClickhouseMock.mock.calls[0][0];
    expect(sql).not.toMatch(/conclusion\s+IN/i);
    expect(sql).not.toMatch(/status\s*=/i);
    expect(sql).toContain("run_attempt");
    expect(sql).toContain("run_id");
    expect(sql).toContain("downstream_repo");
  });

  test("keeps an empty conclusion empty instead of calling it a failure", async () => {
    // A downstream job can report `completed` without a conclusion: the action's
    // input is optional and the relay passes it through untouched. Nothing else
    // in the pipeline turns that into a failure, and the query excluded these
    // rows before it stopped filtering -- so it must not become a red job here,
    // and for L4 a blocking one. The caller classifies.
    queryClickhouseMock.mockResolvedValue([row({ conclusion: "" })]);

    const [job] = await fetchCrcrWorkflows("pytorch/pytorch", [123]);
    expect(job.conclusion).toBe("");
  });

  test("names each job after its check run and carries what the pin needs", async () => {
    queryClickhouseMock.mockResolvedValue([row()]);

    const [job] = await fetchCrcrWorkflows("pytorch/pytorch", [123]);
    // The name is the check run name, which is also the job's identity across
    // re-runs -- latestAttemptPerJob dedupes on it.
    expect(job.name).toBe(
      "crcr/pytorch/crcr-test/CRCR L3 CI/test-L3-checkrun-creation"
    );
    expect(job.downstreamRepo).toBe("pytorch/crcr-test");
    expect(job.downstreamLevel).toBe("L3");
    expect(job.runAttempt).toBe(2);
    expect(job.runId).toBe(999);
    expect(job.id).toBe(456);
    expect(job.html_url).toBe(
      "https://github.com/pytorch/crcr-test/actions/runs/555"
    );
  });

  test("defuses the comment's control strings in the text it builds", async () => {
    // Workflow and job names, and the run URL, are downstream-supplied and land
    // in the Dr. CI comment -- in the grouped section and in the generic list it
    // falls back to -- while the section's delimiters and pin markers are parsed
    // back out of that comment. A name carrying one could make the section parse
    // from the wrong place, or mark a handle paged that was never mentioned, so
    // the row builder takes the capability away for every consumer at once.
    queryClickhouseMock.mockResolvedValue([
      row({
        name: "CI <!-- crcr-section-start -->",
        jobName: "build <!-- crcr-pinned:alice -->",
        html_url: "https://example.com/<!-- crcr-section-end -->",
      }),
    ]);

    const [job] = await fetchCrcrWorkflows("pytorch/pytorch", [123]);

    expect(job.name).not.toContain("<!-- crcr-");
    expect(job.html_url).not.toContain("<!-- crcr-");
    expect(job.name).toContain("<!- -crcr-");
    // A real conclusion is untouched, because the classification compares it
    // exactly (["failure", "cancelled", "timed_out"]).
    expect(job.conclusion).toBe("failure");
  });

  test("treats a row without an attempt as the first one", async () => {
    queryClickhouseMock.mockResolvedValue([row({ run_attempt: undefined })]);

    const [job] = await fetchCrcrWorkflows("pytorch/pytorch", [123]);
    expect(job.runAttempt).toBe(1);
  });

  test("queries the PRs it was asked for, defaulting to none", async () => {
    queryClickhouseMock.mockResolvedValue([]);

    await fetchCrcrWorkflows("pytorch/pytorch", []);
    expect(queryClickhouseMock.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      prNumbers: [0],
    });
  });
});

describe("fetchCrcrActivityPRs", () => {
  beforeEach(() => {
    queryClickhouseMock.mockReset();
  });

  test("wakes a PR on any recent row write, verdict or not", async () => {
    // An in_progress write and the completed rewrite of the same key both
    // refresh _inserted_at, so "written recently" covers a matrix still going
    // as well as a failure that just landed. Filtering on the conclusion or
    // the status would blind the wake to exactly the runs it exists for: a
    // downstream report is not upstream workflow activity, so this query is
    // the only thing telling the sweep the PR moved at all.
    queryClickhouseMock.mockResolvedValue([
      { pr_number: "123" },
      { pr_number: "0" },
    ]);

    const prs = await fetchCrcrActivityPRs("pytorch/pytorch", "30");
    const sql = queryClickhouseMock.mock.calls[0][0];
    expect(sql).toContain("_inserted_at");
    expect(sql).toContain("upstream_repo");
    expect(sql).not.toMatch(/conclusion\s*=|status\s*=/i);
    expect(queryClickhouseMock.mock.calls[0][1]).toEqual({
      repo: "pytorch/pytorch",
      numMinutes: 30,
    });
    // A row without a PR cannot wake one.
    expect(prs).toEqual([123]);
  });
});
