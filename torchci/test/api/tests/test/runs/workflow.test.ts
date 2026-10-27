import {
  GithubWorkflowSchema,
  RunCatalogRecord,
  RunWorkflowFields,
} from "lib/api/tests/test/runs/types";
import { expandRunWorkflow } from "lib/api/tests/test/runs/workflow";
import * as clickhouse from "lib/clickhouse";
import { expandedRunRecord, runRecord, workflowRow } from "./fixtures";

const WORKFLOW_REPOSITORY_ID = "65600975";

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
    workflow_event: null,
    workflow_pull_request: null,
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
        owners: ["cuda"],
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
      workflowRun({ ...runs[0], ...firstWorkflow }),
      workflowRun({ ...runs[1], ...secondWorkflow }),
      workflowRun({ ...runs[2], ...firstWorkflow }),
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

  test.each(["pull_request", "pull_request_target", "push"])(
    "returns PR 201952 within the workflow repository for a %s event",
    async (event) => {
      queryClickhouse.mockResolvedValueOnce([
        workflowRow({
          workflow_metadata_available: 1,
          workflow_repository_id: WORKFLOW_REPOSITORY_ID,
          workflow_event: event,
          workflow_pull_requests: [
            {
              number: 201952,
              url: "https://api.github.com/repos/pytorch/pytorch/pulls/201952",
              base_repository_id: WORKFLOW_REPOSITORY_ID,
            },
            {
              number: 456,
              url: "https://api.github.com/repos/contributor/pytorch-fork/pulls/456",
              base_repository_id: "999",
            },
          ],
        }),
      ]);

      const result = await expandRunWorkflow([catalogRun()]);

      expect(result.runs[0]).toMatchObject({
        workflow_event: event,
        workflow_pull_request: {
          number: 201952,
          url: "https://github.com/pytorch/pytorch/pull/201952",
        },
      });
      expect(result.runs[0]).not.toHaveProperty("workflow_metadata_available");
      expect(result.runs[0]).not.toHaveProperty("workflow_repository_id");
      expect(result.runs[0]).not.toHaveProperty("workflow_pull_requests");
      expect(result.runs[0].workflow_pull_request).toEqual({
        number: 201952,
        url: "https://github.com/pytorch/pytorch/pull/201952",
      });
      expect(queryClickhouse).toHaveBeenCalledTimes(1);
    }
  );

  test("deduplicates repeated PR numbers using the first valid association", async () => {
    const association = {
      number: 201952,
      url: "https://api.github.com/repos/pytorch/pytorch/pulls/201952",
      base_repository_id: WORKFLOW_REPOSITORY_ID,
    };
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        workflow_metadata_available: 1,
        workflow_repository_id: WORKFLOW_REPOSITORY_ID,
        workflow_event: "push",
        workflow_pull_requests: [
          { ...association, url: "not-a-url" },
          association,
          { ...association },
          {
            ...association,
            url: "https://api.github.com/repos/PyTorch/renamed-repo/pulls/201952",
          },
        ],
      }),
    ]);

    const result = await expandRunWorkflow([catalogRun()]);

    expect(result.runs[0].workflow_pull_request).toEqual({
      number: 201952,
      url: "https://github.com/pytorch/pytorch/pull/201952",
    });
  });

  test.each([
    [123, 456],
    [456, 123],
  ])(
    "returns null for ambiguous matching PRs %j and %j",
    async (first, second) => {
      queryClickhouse.mockResolvedValueOnce([
        workflowRow({
          workflow_metadata_available: 1,
          workflow_repository_id: WORKFLOW_REPOSITORY_ID,
          workflow_event: "pull_request",
          workflow_pull_requests: [first, second].map((number) => ({
            number,
            url: `https://api.github.com/repos/pytorch/pytorch/pulls/${number}`,
            base_repository_id: WORKFLOW_REPOSITORY_ID,
          })),
        }),
      ]);

      const result = await expandRunWorkflow([catalogRun()]);

      expect(result.runs[0]).toMatchObject({
        workflow_event: "pull_request",
        workflow_pull_request: null,
        workflow_path: ".github/workflows/pull.yml",
        github_workflow_job_name: workflowRow().github_workflow_job_name,
      });
    }
  );

  test.each([
    "pull_request",
    "pull_request_target",
    "push",
    "schedule",
    "workflow_dispatch",
    "repository_dispatch",
  ])(
    "retains the %s trigger when no PR associations were recorded",
    async (event) => {
      queryClickhouse.mockResolvedValueOnce([
        workflowRow({
          workflow_metadata_available: 1,
          workflow_repository_id: WORKFLOW_REPOSITORY_ID,
          workflow_event: event,
          workflow_pull_requests: [],
        }),
      ]);

      const result = await expandRunWorkflow([catalogRun()]);

      expect(result.runs[0]).toMatchObject({
        workflow_event: event,
        workflow_pull_request: null,
      });
    }
  );

  test("returns no PR when all seven recorded associations target other repositories", async () => {
    // Associations recorded on the push workflow for run 1691e322-bbd1-4c55-847d-49ec0dcf1b40.
    const associations = [
      ["botbw", 1, "829850672"],
      ["SkBlaz", 1, "843886882"],
      ["yixuqiu", 1, "727000293"],
      ["sagargulabani", 5, "778669783"],
      ["Dylynniscoding", 1, "664864358"],
      ["kkpan11", 1, "638032568"],
      ["changlan", 5, "501340649"],
    ] as const;
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        workflow_metadata_available: 1,
        workflow_repository_id: WORKFLOW_REPOSITORY_ID,
        workflow_event: "push",
        workflow_pull_requests: associations.map(
          ([owner, number, base_repository_id]) => ({
            number,
            url: `https://api.github.com/repos/${owner}/pytorch/pulls/${number}`,
            base_repository_id,
          })
        ),
      }),
    ]);

    const result = await expandRunWorkflow([catalogRun()]);

    expect(result.runs[0]).toMatchObject({
      workflow_event: "push",
      workflow_pull_request: null,
    });
  });

  test.each([
    {
      name: "a non-PyTorch workflow",
      repositoryId: "12345",
      jobRepository: "acme/widgets",
      prRepository: "acme/widgets",
    },
    {
      name: "a repository rename and different casing",
      repositoryId: WORKFLOW_REPOSITORY_ID,
      jobRepository: "pytorch/pytorch",
      prRepository: "PyTorch/renamed-repo",
    },
    {
      name: "repository IDs larger than JavaScript's exact integer range",
      repositoryId: "9007199254740993",
      jobRepository: "acme/widgets",
      prRepository: "acme/widgets",
    },
  ])(
    "matches destination IDs for $name",
    async ({ repositoryId, jobRepository, prRepository }) => {
      queryClickhouse.mockResolvedValueOnce([
        workflowRow({
          workflow_metadata_available: 1,
          workflow_repository_id: repositoryId,
          github_workflow_job_url: `https://github.com/${jobRepository}/actions/runs/1/job/2`,
          workflow_event: "pull_request",
          workflow_pull_requests: [
            {
              number: 123,
              url: `https://api.github.com/repos/${prRepository}/pulls/123`,
              base_repository_id: repositoryId,
            },
            {
              number: 456,
              url: `https://api.github.com/repos/${prRepository}/pulls/456`,
              base_repository_id: "9007199254740992",
            },
          ],
        }),
      ]);

      const result = await expandRunWorkflow([catalogRun()]);

      expect(result.runs[0].workflow_pull_request).toEqual({
        number: 123,
        url: `https://github.com/${prRepository}/pull/123`,
      });
    }
  );

  test.each([undefined, null, "", "0", "-1", "not-an-id", 65600975])(
    "returns unknown associations when the workflow repository ID is %p",
    async (repositoryId) => {
      queryClickhouse.mockResolvedValueOnce([
        workflowRow({
          workflow_metadata_available: 1,
          workflow_repository_id: repositoryId,
          workflow_event: "pull_request",
          workflow_pull_requests: [
            {
              number: 123,
              url: "https://api.github.com/repos/pytorch/pytorch/pulls/123",
              base_repository_id: WORKFLOW_REPOSITORY_ID,
            },
          ],
        }),
      ]);

      const result = await expandRunWorkflow([catalogRun()]);

      expect(result.runs[0]).toMatchObject({
        workflow_event: "pull_request",
        workflow_pull_request: null,
      });
    }
  );

  test("drops associations with missing or invalid destination repository IDs", async () => {
    const valid = {
      number: 123,
      url: "https://api.github.com/repos/pytorch/pytorch/pulls/123",
      base_repository_id: WORKFLOW_REPOSITORY_ID,
    };
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        workflow_metadata_available: 1,
        workflow_repository_id: WORKFLOW_REPOSITORY_ID,
        workflow_event: "pull_request",
        workflow_pull_requests: [
          ...[undefined, null, "", "0", "-1", "not-an-id", 65600975].map(
            (base_repository_id) => ({ ...valid, base_repository_id })
          ),
          valid,
        ],
      }),
    ]);

    const result = await expandRunWorkflow([catalogRun()]);

    expect(result.runs[0].workflow_pull_request).toEqual({
      number: 123,
      url: "https://github.com/pytorch/pytorch/pull/123",
    });
  });

  test("keeps available job metadata when no PR is identifiable", async () => {
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        github_workflow_job_id: "1",
        workflow_metadata_available: 0,
        workflow_event: null,
        workflow_pull_requests: [],
      }),
      workflowRow({
        github_workflow_job_id: "2",
        workflow_metadata_available: 1,
        workflow_repository_id: WORKFLOW_REPOSITORY_ID,
        workflow_event: "",
        workflow_pull_requests: [],
      }),
    ]);

    const result = await expandRunWorkflow([
      catalogRun({ github_workflow_job_id: "1" }),
      catalogRun({ github_workflow_job_id: "2" }),
      catalogRun({ github_workflow_job_id: "3" }),
    ]);

    expect(result.runs.map((run) => run.workflow_event)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.runs.map((run) => run.workflow_pull_request)).toEqual([
      null,
      null,
      null,
    ]);
    expect(result.runs[0].github_workflow_job_name).toBe(
      workflowRow().github_workflow_job_name
    );
  });

  test("drops malformed PR associations individually while preserving valid metadata", async () => {
    const valid = {
      number: 123,
      url: "https://api.github.com/repos/pytorch/pytorch/pulls/123",
      base_repository_id: WORKFLOW_REPOSITORY_ID,
    };
    queryClickhouse.mockResolvedValueOnce([
      workflowRow({
        workflow_metadata_available: 1,
        workflow_repository_id: WORKFLOW_REPOSITORY_ID,
        workflow_event: "pull_request",
        workflow_pull_requests: [
          null,
          {},
          ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "123"].map((number) => ({
            ...valid,
            number,
          })),
          ...[
            "not-a-url",
            "https://example.com/repos/pytorch/pytorch/pulls/123",
            "http://api.github.com/repos/pytorch/pytorch/pulls/123",
            "https://api.github.com/repos/pytorch/pytorch/pulls/124",
            "https://api.github.com/repos/pytorch/pytorch/issues/123",
            "https://api.github.com/repos/pytorch/pytorch/pulls/123?query=1",
            "https://api.github.com/repos/pytorch/pytorch/pulls/123#fragment",
          ].map((url) => ({ ...valid, url })),
          valid,
        ],
      }),
    ]);

    const result = await expandRunWorkflow([catalogRun()]);

    expect(result.runs[0]).toMatchObject({
      workflow_event: "pull_request",
      workflow_pull_request: {
        number: 123,
        url: "https://github.com/pytorch/pytorch/pull/123",
      },
      workflow_path: ".github/workflows/pull.yml",
      github_workflow_run_id: "9007199254740993",
    });
  });

  test("validates the public PR metadata shape and requires both new fields", () => {
    const workflow = expandedRunRecord({
      github_workflow: {
        event: "pull_request",
        pull_request: {
          number: 123,
          url: "https://github.com/pytorch/pytorch/pull/123",
        },
      },
    }).github_workflow;
    expect(GithubWorkflowSchema.parse(workflow)).toEqual(workflow);
    expect(
      GithubWorkflowSchema.safeParse({ ...workflow, pull_request: null })
        .success
    ).toBe(true);
    expect(workflow).not.toHaveProperty("pull_requests");
    for (const field of ["event", "pull_request"]) {
      expect(
        GithubWorkflowSchema.safeParse({ ...workflow, [field]: undefined })
          .success
      ).toBe(false);
    }
    for (const pull_request of [
      {},
      [],
      [null],
      [{ number: 123 }],
      [{ number: 123, url: "https://github.com/pytorch/pytorch/pull/123" }],
      { number: 0, url: "https://github.com/pytorch/pytorch/pull/123" },
      { number: 123, url: "not-a-url" },
    ]) {
      expect(
        GithubWorkflowSchema.safeParse({ ...workflow, pull_request }).success
      ).toBe(false);
    }
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
