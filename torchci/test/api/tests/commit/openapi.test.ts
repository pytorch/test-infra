import { buildOpenApiDocument } from "lib/api/openapi";
import {
  COMMIT_RUNS_PARAMETER_DEFINITIONS,
  commitRunsListParameters,
} from "lib/api/tests/commit/parameters";
import {
  RUN_LIST_PARAMETER_DEFINITIONS,
  RUN_SORT_FIELDS,
} from "lib/api/tests/test/runs/parameters";
import { RUN_OUTCOMES } from "../test/runs/fixtures";

describe("commit runs OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/commit/{sha}"] as any).get;
  const testRunsOperation = (
    document.paths["/api/tests/test/{test_id}/runs"] as any
  ).get;
  const schemas = document.components.schemas as Record<string, any>;

  test("documents the same path and query parameters that the handler accepts", () => {
    expect(operation.operationId).toBe("listCommitRuns");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(commitRunsListParameters());
    expect(
      operation.parameters.map((parameter: any) => parameter.name)
    ).toEqual(Object.keys(COMMIT_RUNS_PARAMETER_DEFINITIONS));
    const byName = Object.fromEntries(
      operation.parameters.map((parameter: any) => [parameter.name, parameter])
    );
    expect(byName.sha).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
    });
    expect(byName.sha.description).toMatch(/normalized to lowercase/i);
    expect(byName.repo).toMatchObject({
      in: "query",
      required: true,
      schema: { type: "string" },
    });
    expect(byName.repo.schema.pattern).toBeTruthy();
    expect(byName).not.toHaveProperty("test_id");
    for (const name of [
      "environments_id",
      "env_vars_id",
      "outcome",
      "last_attempt_outcome",
    ]) {
      expect(byName[name]).toMatchObject({
        in: "query",
        required: false,
        style: "form",
        explode: true,
        schema: { type: "array", minItems: 1, items: { type: "string" } },
      });
      expect(byName[name].description).toMatch(/repeat this parameter/i);
      expect(byName[name].schema).not.toHaveProperty("default");
    }
    expect(byName.outcome.schema.items.enum).toEqual(RUN_OUTCOMES);
    expect(byName.last_attempt_outcome.schema.items.enum).toEqual(RUN_OUTCOMES);
    expect(byName.last_attempt_outcome.description).toMatch(
      /last retained attempt/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(
      /after replacement deduplication/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(
      /started_at, ended_at, id/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(/UUID string/i);
    expect(byName.last_attempt_outcome.description).toMatch(
      /independently of outcome and rerun_number/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(
      /before pagination/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(
      /every attempt in a matching bundle is returned/i
    );
    expect(byName.last_attempt_outcome.description).toMatch(
      /does not imply a completed retry chain/i
    );

    expect(byName.sort).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: false,
      schema: {
        type: "array",
        default: ["-started_at"],
        items: {
          enum: RUN_SORT_FIELDS.flatMap((field) => [field, `-${field}`]),
        },
      },
    });
    expect(byName.env_vars).toMatchObject({
      in: "query",
      required: false,
      content: { "application/json": { schema: { type: "object" } } },
    });
    expect(
      byName.env_vars.content["application/json"].schema
    ).not.toHaveProperty("default");
    expect(byName.limit.schema).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 25,
    });
    expect(byName.cursor).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string" },
    });
    expect(byName.cursor.description).toMatch(
      /repository and commit SHA\), filters/i
    );
    for (const parameter of operation.parameters) {
      expect(parameter.description).toBeTruthy();
      const schema =
        parameter.schema ?? parameter.content["application/json"].schema;
      expect(schema.$schema).toBeUndefined();
    }
  });

  test("adds required outcome statistics while reusing run records and shared options", () => {
    const byName = (parameters: any[]) =>
      Object.fromEntries(
        parameters.map((parameter) => [parameter.name, parameter])
      );
    const commitParameters = byName(operation.parameters);
    const testParameters = byName(testRunsOperation.parameters);
    for (const name of Object.keys(RUN_LIST_PARAMETER_DEFINITIONS)) {
      expect(commitParameters[name]).toEqual(testParameters[name]);
    }
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/CommitRunListPage" });
    expect(
      testRunsOperation.responses["200"].content["application/json"].schema
    ).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/RunListPage" },
        { $ref: "#/components/schemas/RunGrid" },
      ],
    });
    expect(schemas.RunListPage.properties.runs.items).toEqual({
      $ref: "#/components/schemas/RunRecord",
    });
    for (const name of ["runs", "pagination"]) {
      expect(schemas.CommitRunListPage.properties[name]).toEqual(
        schemas.RunListPage.properties[name]
      );
    }
    expect(schemas.CommitRunListPage.properties.runs.items).toEqual({
      $ref: "#/components/schemas/RunRecord",
    });
    expect(schemas.CommitRunListPage.required).toEqual(
      expect.arrayContaining([
        "runs",
        "pagination",
        "query_duration_ms",
        "stats",
      ])
    );
    expect(schemas.CommitRunListPage.properties.stats).toMatchObject({
      $ref: "#/components/schemas/RunStats",
    });
    const countFields = ["total", ...RUN_OUTCOMES];
    expect(schemas.RunStats.required).toEqual(countFields);
    expect(Object.keys(schemas.RunStats.properties)).toEqual(countFields);
    for (const field of countFields) {
      expect(schemas.RunStats.properties[field]).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
      });
      expect(schemas.RunStats.properties).not.toHaveProperty(`${field}_runs`);
    }
    expect(schemas.CommitRunListPage.properties).not.toHaveProperty(
      "total_runs"
    );
    expect(schemas.CommitRunListPage.required).not.toContain("total_runs");
    expect(schemas.RunListPage.properties).not.toHaveProperty("total_runs");
    expect(schemas.RunListPage.properties).not.toHaveProperty("stats");
    expect(schemas).not.toHaveProperty("CommitRunRecord");
    expect(schemas.RunRecord.required).toEqual(
      expect.arrayContaining([
        "attempts",
        "test",
        "environment",
        "env_vars",
        "owners",
        "github_workflow",
      ])
    );
    for (const name of [
      "tests_id",
      "environments_id",
      "env_vars_id",
      "github_workflow_job_id",
      "github_workflow_run_id",
      "workflow_path",
      "commit_sha",
      "github_workflow_job_url",
      "github_workflow_job_name",
      "github_workflow_run_url",
      "report_uuid",
    ]) {
      expect(schemas.RunRecord.properties).not.toHaveProperty(name);
      expect(schemas.RunRecord.required).not.toContain(name);
    }
    expect(schemas.RunRecord.properties.github_workflow).toEqual({
      $ref: "#/components/schemas/GithubWorkflow",
    });
    expect(schemas.RunRecord.properties.attempts.items).toEqual({
      $ref: "#/components/schemas/RunAttempt",
    });
    expect(schemas.RunAttempt.properties.report).toEqual({
      $ref: "#/components/schemas/RunReport",
    });
    expect(schemas.GithubWorkflow.required).toEqual([
      "job_id",
      "run_id",
      "path",
      "commit_sha",
      "job_url",
      "job_name",
      "event",
      "pull_request",
    ]);
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({
        $ref: "#/components/schemas/ErrorResponse",
      });
    }
    expect(operation.responses).not.toHaveProperty("404");
  });

  test("describes commit membership, unrestricted attempts and pagination limits", () => {
    expect(operation.description).toMatch(
      /workflow job and workflow run metadata/i
    );
    expect(operation.description).toMatch(/only runs with matching metadata/i);
    expect(operation.description).toMatch(/matches workflow_run\.head_sha/i);
    expect(operation.description).toMatch(
      /merge SHA recorded on pull-request jobs/i
    );
    expect(operation.description).toMatch(
      /all matching workflow runs and job attempts/i
    );
    expect(operation.description).toMatch(
      /without a branch, event or time filter/i
    );
    expect(operation.description).toMatch(/empty page with 200/i);
    expect(operation.description).toMatch(/fixed snapshot/i);
    expect(operation.description).toMatch(
      /Search, all run filters including outcome and last_attempt_outcome, cursor, limit and ordering affect only the runs list, not stats/i
    );
    expect(operation.description).toMatch(
      /filters matching no retained runs.*stats still describe the entire commit/i
    );
    expect(operation.description).toMatch(
      /filters select bundles before pagination/i
    );
    expect(operation.description).toMatch(
      /same attempt after replacement deduplication/i
    );
    expect(operation.description).toMatch(
      /every attempt in a matching bundle is returned/i
    );
    expect(operation.description).toMatch(
      /each bundle counts once under its final outcome/i
    );
    expect(operation.description).toMatch(
      /failed and then passed on retry counts as passed/i
    );
    expect(operation.description).toMatch(
      /skip recorded in a rerun after a timeout or failure does not override it/i
    );
    expect(operation.description).toMatch(/AND across fields/i);
    expect(operation.description).toMatch(
      /Catalog IDs appear as test\.id, environment\.id and env_vars\.id/i
    );
    expect(operation.description).toMatch(/Missing catalog objects are null/i);
    expect(operation.description).toMatch(/owners reflect current data/i);
    expect(operation.description).toMatch(
      /github_workflow\.commit_sha is workflow_run\.head_sha/i
    );
    expect(operation.description).toMatch(
      /actual workflow_job\.html_url and workflow_job\.name/i
    );
    expect(operation.description).toMatch(
      /job URL and name remain available when workflow run metadata is missing/i
    );
    expect(operation.description).toMatch(
      /unavailable metadata fields are null/i
    );
    expect(operation.description).toMatch(
      /always-present github_workflow object/i
    );
    expect(operation.description).toMatch(
      /workflow_path filter and sort field apply to github_workflow\.path/i
    );
    expect(
      schemas.CommitRunListPage.properties.query_duration_ms.description
    ).toMatch(/catalog and workflow requests run concurrently/i);
    expect(
      schemas.CommitRunListPage.properties.query_duration_ms.description
    ).toMatch(/catalog and workflow requests .*omitted for an empty page/i);
    expect(
      schemas.CommitRunListPage.properties.query_duration_ms.description
    ).toMatch(/statistics/i);
    expect(schemas.CommitRunListPage.properties.stats.description).toMatch(
      /Search, all run filters including outcome and last_attempt_outcome, cursor, limit and sort order do not affect statistics/i
    );
    expect(schemas.CommitRunListPage.properties.stats.description).toMatch(
      /counts once, under its final outcome/i
    );
    expect(schemas.RunStats.description).toMatch(
      /bundles that ended passing are counted in passed/i
    );
    expect(schemas.RunStats.description).toMatch(
      /a skipped attempt never overrides an executed one/i
    );
    expect(schemas.RunStats.description).toMatch(
      /only way the final outcome differs from the last_attempt_outcome filter/i
    );
    expect(schemas.RunStats.description).toMatch(/sum to total/i);
    expect(schemas.RunStats.description).toMatch(
      /Search and all run filters, including outcome and last_attempt_outcome, are ignored/i
    );
    expect(schemas.RunStats.description).toMatch(/zero in every field/i);
  });
});
