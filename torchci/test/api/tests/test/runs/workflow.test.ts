import {
  RunCatalogRecord,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";
import { expandRunWorkflow } from "lib/api/tests/test/runs/workflow";
import * as clickhouse from "lib/clickhouse";
import { runRecord, workflowRow } from "./fixtures";

function catalogRun(
  overrides: Partial<RunCatalogRecord> = {}
): RunCatalogRecord {
  const {
    tests_id: _testId,
    environments_id: _environmentId,
    env_vars_id: _envVarsId,
    ...run
  } = runRecord();
  return {
    ...run,
    test: null,
    environment: null,
    env_vars: null,
    owners: [],
    ...overrides,
  };
}

function workflowRun(
  overrides: Partial<RunCatalogRecord & RunWorkflowFields> = {}
) {
  return {
    ...catalogRun(),
    github_workflow_run_id: null,
    workflow_path: null,
    commit_sha: null,
    github_workflow_job_url: null,
    github_workflow_job_name: null,
    ...overrides,
  };
}

describe("run workflow expansion", () => {
  let queryClickhouse: jest.SpyInstance;

  beforeEach(() => {
    queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    queryClickhouse.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test("maps one batch by job ID while retaining input order, duplicates and large IDs", async () => {
    const firstWorkflow = workflowRow({
      github_workflow_job_id: "9007199254740993",
    });
    const secondWorkflow = workflowRow({
      github_workflow_job_id: "9223372036854775807",
    });
    queryClickhouse.mockResolvedValueOnce([secondWorkflow, firstWorkflow]);
    const runs = [
      catalogRun({
        github_workflow_job_id: firstWorkflow.github_workflow_job_id,
        owners: ["module: cuda"],
      }),
      catalogRun({
        github_workflow_job_id: secondWorkflow.github_workflow_job_id,
      }),
      catalogRun({
        github_workflow_job_id: firstWorkflow.github_workflow_job_id,
        rerun_number: 1,
        outcome: "passed",
      }),
    ];
    const result = await expandRunWorkflow(runs);

    expect(result.runs).toEqual([
      { ...runs[0], ...firstWorkflow },
      { ...runs[1], ...secondWorkflow },
      { ...runs[2], ...firstWorkflow },
    ]);
    expect(queryClickhouse).toHaveBeenCalledTimes(1);
    expect(result.runs[0].github_workflow_run_id).toEqual(
      result.runs[1].github_workflow_run_id
    );
    expect(result.runs[0].github_workflow_job_url).toBe(
      "https://github.com/pytorch/pytorch/actions/runs/9007199254740993/job/9007199254740993"
    );
    expect(result.runs[1].github_workflow_job_url).toBe(
      "https://github.com/pytorch/pytorch/actions/runs/9007199254740993/job/9223372036854775807"
    );
    expect(queryClickhouse.mock.calls[0][2]).toBe("api_run_workflow");
    expect(queryClickhouse.mock.calls[0][1]).toEqual({
      github_workflow_job_ids: ["9007199254740993", "9223372036854775807"],
    });
    result.runs.forEach((run) => {
      expect(run).not.toHaveProperty("github_workflow_run_url");
    });
    expect(runs[0]).not.toHaveProperty("github_workflow_run_id");
  });

  test("preserves job URLs, names and known run IDs when workflow metadata is missing", async () => {
    const partialWorkflow = workflowRow({
      github_workflow_job_id: "1",
      workflow_path: null,
      commit_sha: null,
    });
    queryClickhouse.mockResolvedValueOnce([
      partialWorkflow,
      workflowRow({ github_workflow_job_id: "99" }),
    ]);

    const result = await expandRunWorkflow([
      catalogRun({ github_workflow_job_id: "1" }),
      catalogRun({ github_workflow_job_id: "-1" }),
    ]);

    expect(result.runs).toEqual([
      workflowRun(partialWorkflow),
      workflowRun({ github_workflow_job_id: "-1" }),
    ]);
    expect(result.runs[0].github_workflow_job_name).toBe(
      "linux-jammy-py3.10-gcc11 / test (default, 1, 5, linux.4xlarge)"
    );
  });

  test("skips the metadata request for an empty page", async () => {
    expect(await expandRunWorkflow([])).toEqual({
      runs: [],
      query_duration_ms: 0,
    });
    expect(queryClickhouse).not.toHaveBeenCalled();
  });

  test("normalizes empty and invalid fields without discarding valid metadata", async () => {
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        github_workflow_job_id: "1",
        workflow_path: "",
        commit_sha: "not-a-commit",
        github_workflow_job_url: "not-a-url",
      }),
      workflowRow({
        github_workflow_job_id: "2",
        github_workflow_run_id: "18446744073709551616",
        commit_sha: "",
        github_workflow_job_url: "",
        github_workflow_job_name: "",
      }),
    ]);

    const result = await expandRunWorkflow([
      catalogRun({ github_workflow_job_id: "1" }),
      catalogRun({ github_workflow_job_id: "2" }),
    ]);

    expect(result.runs).toEqual([
      workflowRun({
        github_workflow_job_id: "1",
        github_workflow_run_id: "9007199254740993",
        github_workflow_job_name: workflowRow().github_workflow_job_name,
      }),
      workflowRun({
        github_workflow_job_id: "2",
        workflow_path: ".github/workflows/pull.yml",
      }),
    ]);
  });

  test("reports elapsed database time", async () => {
    jest.useFakeTimers();
    queryClickhouse.mockImplementation(async () => {
      jest.advanceTimersByTime(19);
      return [workflowRow()];
    });

    const result = await expandRunWorkflow([catalogRun()]);
    expect(result.query_duration_ms).toBe(19);
  });

  test("propagates lookup errors instead of hiding unavailable metadata", async () => {
    queryClickhouse.mockRejectedValueOnce(new Error("Workflow unavailable"));

    await expect(expandRunWorkflow([catalogRun()])).rejects.toThrow(
      "Workflow unavailable"
    );
  });
});
