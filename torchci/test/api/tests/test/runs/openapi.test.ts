import { buildOpenApiDocument } from "lib/api/openapi";
import {
  RUN_FILTER_DEFINITIONS,
  RUN_SORT_FIELDS,
  RUNS_PARAMETER_DEFINITIONS,
  runsListParameters,
} from "lib/api/tests/test/runs/parameters";
import { RUN_OUTCOMES } from "./fixtures";

describe("test runs OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/test/{test_id}/runs"] as any)
    .get;
  const schemas = document.components.schemas as Record<string, any>;

  test("documents the same path and query parameters that the handler accepts", () => {
    expect(operation.operationId).toBe("listRuns");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(runsListParameters());
    expect(
      operation.parameters.map((parameter: any) => parameter.name)
    ).toEqual(Object.keys(RUNS_PARAMETER_DEFINITIONS));
    const byName = Object.fromEntries(
      operation.parameters.map((parameter: any) => [parameter.name, parameter])
    );
    expect(byName.test_id).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    for (const name of [
      ...Object.keys(RUN_FILTER_DEFINITIONS).filter(
        (name) => name !== "device_count"
      ),
      "outcome",
      "workflow_path",
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
    expect(byName.outcome.schema.items).not.toHaveProperty("description");
    expect(byName.outcome.description).toMatch(/omit to include all outcomes/i);
    expect(byName.outcome.description).toMatch(/case-sensitive/i);
    for (const name of ["outcome", "rerun_number"]) {
      expect(byName[name].description).toMatch(/same attempt/i);
      expect(byName[name].description).toMatch(
        /every attempt in a matching bundle is returned/i
      );
    }
    expect(byName.workflow_path.description).toMatch(
      /latest retained workflow run metadata/i
    );
    expect(byName.workflow_path.description).not.toMatch(/selected window/i);
    expect(byName.language.schema.items.enum).toEqual([
      "unknown",
      "python",
      "cpp",
    ]);
    for (const [name, maximum] of [
      ["device_count", 255],
      ["rerun_number", 65535],
    ] as const) {
      expect(byName[name]).toMatchObject({
        in: "query",
        required: false,
        style: "form",
        explode: true,
        schema: {
          type: "array",
          minItems: 1,
          items: {
            anyOf: [
              { type: "integer", minimum: 0, maximum },
              { type: "string", pattern: "^\\d+$" },
            ],
          },
        },
      });
      expect(byName[name].schema).not.toHaveProperty("default");
      for (const item of byName[name].schema.items.anyOf) {
        expect(item).not.toHaveProperty("description");
      }
    }
    expect(byName.env_vars).toMatchObject({
      in: "query",
      required: false,
      content: {
        "application/json": {
          schema: {
            type: "object",
            propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
            additionalProperties: {
              type: "array",
              minItems: 1,
              items: { type: "string" },
            },
          },
        },
      },
    });
    expect(
      byName.env_vars.content["application/json"].schema
    ).not.toHaveProperty("default");
    expect(byName.env_vars.description).toMatch(
      /missing variable does not match an empty value/i
    );
    expect(byName.search).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", maxLength: 200 },
    });
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
    expect(byName.sort.description).toMatch(/nulls always sort last/i);
    expect(byName.sort.description).toMatch(/alphabetically first owner/i);
    expect(byName.sort.description).toMatch(/earliest attempt start/i);
    expect(byName.sort.description).toMatch(/latest attempt end/i);
    expect(byName.sort.description).toMatch(
      /last attempt in chronological order/i
    );
    for (const name of [
      "tests_id",
      "test_id",
      "environment_id",
      "environments_id",
      "env_vars_id",
      "runs",
      "pass_rate",
      "last_run_at",
    ]) {
      expect(byName.sort.schema.items.enum).not.toContain(name);
      expect(byName.sort.schema.items.enum).not.toContain(`-${name}`);
    }
    expect(byName.limit.schema).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 100,
      default: 25,
    });
    expect(byName.limit.description).toMatch(/bundles per page/i);
    expect(byName.limit.description).toMatch(/never split across pages/i);
    expect(byName.cursor).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string" },
    });
    expect(byName.cursor.description).toMatch(
      /cursors issued before attempt bundling are rejected with 400/i
    );
    for (const parameter of operation.parameters) {
      expect(parameter.description).toBeTruthy();
      const schema =
        parameter.schema ?? parameter.content["application/json"].schema;
      expect(schema.$schema).toBeUndefined();
    }
  });

  test("documents the page and shared error responses including empty results", () => {
    expect(operation.description).toMatch(/every environment/i);
    expect(operation.description).toMatch(/empty page with 200/i);
    expect(operation.description).toMatch(/fixed snapshot/i);
    expect(operation.description).toMatch(
      /filters select bundles before pagination/i
    );
    expect(operation.description).toMatch(/AND across fields/i);
    expect(operation.description).toMatch(/after replacement deduplication/i);
    expect(operation.description).toMatch(/includes the initial execution/i);
    expect(operation.description).toMatch(/attempts may span reports/i);
    expect(operation.description).toMatch(/never split across pages/i);
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/RunListPage" });
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
    expect(operation.responses).not.toHaveProperty("404");
    expect(schemas.RunListPage.required).toEqual([
      "runs",
      "next_cursor",
      "query_duration_ms",
    ]);
    expect(schemas.RunListPage.properties.runs.items).toEqual({
      $ref: "#/components/schemas/RunRecord",
    });
    expect(schemas.RunListPage.properties).not.toHaveProperty("refreshed_at");
  });

  test("documents attempt execution fields separately from shared bundle metadata", () => {
    const run = schemas.RunRecord;
    expect(Object.keys(run.properties).sort()).toEqual(
      [
        "github_workflow",
        "attempts",
        "test",
        "environment",
        "env_vars",
        "owners",
      ].sort()
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
      expect(run.properties).not.toHaveProperty(name);
      expect(run.required).not.toContain(name);
    }
    expect(run.properties.github_workflow).toEqual({
      $ref: "#/components/schemas/GithubWorkflow",
    });
    expect(run.properties.attempts).toMatchObject({
      type: "array",
      minItems: 1,
      items: { $ref: "#/components/schemas/RunAttempt" },
    });
    const attempt = schemas.RunAttempt;
    expect(Object.keys(attempt.properties).sort()).toEqual(
      [
        "id",
        "report",
        "rerun_number",
        "outcome",
        "outcome_summary",
        "started_at",
        "ended_at",
      ].sort()
    );
    expect(attempt.required).toEqual(Object.keys(attempt.properties));
    for (const name of Object.keys(attempt.properties)) {
      expect(run.properties).not.toHaveProperty(name);
    }
    expect(attempt.properties.report).toEqual({
      $ref: "#/components/schemas/RunReport",
    });
    const report = schemas.RunReport;
    expect(report.type).toBe("object");
    expect(Object.keys(report.properties)).toEqual(["uuid", "s3_url"]);
    expect(report.required).toEqual(["uuid", "s3_url"]);
    expect(report.properties.uuid).toMatchObject({ type: "string" });
    expect(report.properties.uuid.pattern).toBeTruthy();
    expect(report.properties.s3_url.anyOf).toEqual([
      expect.objectContaining({ type: "string", format: "uri" }),
      { type: "null" },
    ]);
    expect(report.properties.s3_url.description).toMatch(/gha-artifacts/i);
    expect(report.properties.s3_url.description).toMatch(/null if/i);
    const workflow = schemas.GithubWorkflow;
    expect(workflow.type).toBe("object");
    expect(Object.keys(workflow.properties)).toEqual([
      "job_id",
      "run_id",
      "path",
      "commit_sha",
      "job_url",
      "job_name",
    ]);
    expect(workflow.required).toEqual(Object.keys(workflow.properties));
    expect(workflow.description).toMatch(/always present/i);
    expect(workflow.properties.job_id).toMatchObject({
      type: "string",
      pattern: "^-?\\d{1,19}$",
    });
    for (const name of [
      "run_id",
      "path",
      "commit_sha",
      "job_url",
      "job_name",
    ]) {
      expect(workflow.properties[name].anyOf).toEqual([
        expect.objectContaining({ type: "string" }),
        { type: "null" },
      ]);
      expect(workflow.properties[name].description).toMatch(/null if/i);
    }
    expect(workflow.properties.run_id.anyOf[0].pattern).toBe("^-?\\d{1,19}$");
    expect(workflow.properties.commit_sha.anyOf[0].pattern).toBe(
      "^[0-9a-f]{40}$"
    );
    expect(workflow.properties.job_url.anyOf[0].format).toBe("uri");
    expect(workflow.properties.commit_sha.description).toMatch(
      /workflow_run\.head_sha/
    );
    expect(workflow.properties.job_url.description).toMatch(
      /workflow_job\.html_url/
    );
    expect(workflow.properties.job_name.description).toMatch(
      /workflow_job\.name/
    );
    for (const name of ["started_at", "ended_at"]) {
      expect(attempt.properties[name]).toMatchObject({
        type: "string",
        format: "date-time",
      });
    }
    for (const [name, component] of [
      ["test", "TestRecord"],
      ["environment", "EnvironmentRecord"],
      ["env_vars", "EnvVarsRecord"],
    ]) {
      expect(run.properties[name].anyOf).toEqual([
        { $ref: `#/components/schemas/${component}` },
        { type: "null" },
      ]);
      expect(run.properties[name].description).toMatch(
        /catalog row is missing/i
      );
      expect(schemas[component].properties.id).toMatchObject({
        type: "string",
      });
      expect(schemas[component].required).toContain("id");
    }
    expect(attempt.properties.rerun_number.description).toMatch(/report\.uuid/);
    expect(attempt.properties.rerun_number.description).toMatch(/reset/i);
    expect(attempt.properties.rerun_number.description).not.toMatch(
      /report_uuid/
    );
    expect(attempt.properties.rerun_number.description).not.toMatch(/tests_id/);
    expect(run.properties.owners).toEqual(
      schemas.TestHealthEntry.properties.owners
    );
    expect(run.required).toEqual(Object.keys(run.properties));
    for (const property of Object.values(run.properties) as any[]) {
      const description = property.$ref
        ? schemas[property.$ref.split("/").pop()].description
        : property.description;
      expect(description).toBeTruthy();
    }
    for (const property of Object.values(workflow.properties) as any[]) {
      expect(property.description).toBeTruthy();
    }
  });

  test("distinguishes nested response metadata from the workflow_path option", () => {
    expect(operation.description).toMatch(
      /always-present github_workflow object/i
    );
    expect(operation.description).toMatch(
      /workflow_path filter and sort field apply to github_workflow\.path/i
    );
    expect(operation.description).not.toMatch(
      /github_workflow_(?:job_id|run_id|job_url|job_name)/
    );
  });
});
