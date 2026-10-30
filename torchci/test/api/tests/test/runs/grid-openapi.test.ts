import { buildOpenApiDocument } from "lib/api/openapi";
import { RAN_ONS, WINDOWS } from "lib/api/tests/parameters";
import { RUN_OUTCOMES } from "./fixtures";

describe("test runs grid OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/test/{test_id}/runs"] as any)
    .get;
  const schemas = document.components.schemas as Record<string, any>;
  const byName = Object.fromEntries(
    operation.parameters.map((parameter: any) => [parameter.name, parameter])
  );

  test("documents group_by, ran_on and window as the grid's parameters", () => {
    expect(byName.group_by).toMatchObject({
      in: "query",
      required: false,
      schema: { const: "commit" },
    });
    expect(byName.group_by.description).toMatch(
      /one lane per calling workflow/i
    );
    expect(byName.group_by.description).toMatch(
      /sort, limit, cursor, search, outcome, last_attempt_outcome and rerun_number are not accepted/i
    );
    expect(byName.ran_on).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: false,
      schema: { type: "array", minItems: 1, items: { enum: [...RAN_ONS] } },
    });
    expect(byName.ran_on.schema).not.toHaveProperty("default");
    expect(byName.ran_on.description).toMatch(/only with group_by=commit/i);
    expect(byName.ran_on.description).toMatch(/ciflow tag pushes/i);
    expect(byName.window).toMatchObject({
      in: "query",
      required: false,
      schema: { enum: [...WINDOWS] },
    });
    expect(byName.window.schema).not.toHaveProperty("default");
    expect(byName.window.description).toMatch(/only with group_by=commit/i);
    // The grid's parameters come first, then the shared and the page's.
    expect(Object.keys(byName).slice(0, 4)).toEqual([
      "test_id",
      "group_by",
      "ran_on",
      "window",
    ]);
  });

  test("describes the grid's components and the operation's two answers", () => {
    expect(operation.summary).toBe(
      "List runs of a test, or group them by commit"
    );
    expect(operation.description).toMatch(/With group_by=commit/);
    expect(operation.description).toMatch(
      /exactly as the health view classifies them/
    );
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/RunListPage" },
        { $ref: "#/components/schemas/RunGrid" },
      ],
    });
    expect(Object.keys(schemas.RunGrid.properties)).toEqual([
      "commits",
      "lanes",
      "hud_url",
      "query_duration_ms",
    ]);
    expect(schemas.RunGrid.properties.lanes.items).toEqual({
      $ref: "#/components/schemas/RunGridLane",
    });
    expect(Object.keys(schemas.RunGridLane.properties)).toEqual([
      "workflow_path",
      "environment",
      "env_vars",
      "cells",
    ]);
    expect(schemas.RunGridLane.properties.cells.items).toEqual({
      $ref: "#/components/schemas/RunGridCell",
    });
    expect(Object.keys(schemas.RunGridCell.properties)).toEqual([
      "commit_sha",
      "outcome",
      "started_at",
      "duration_milliseconds",
      "passed_duration_milliseconds",
      "jobs",
    ]);
    expect(schemas.RunGridCell.properties.outcome.enum).toEqual(RUN_OUTCOMES);
    expect(schemas.RunGridCell.properties.outcome.description).toMatch(
      /same name are one retry sequence.*different names are siblings.*worst sibling/
    );
    expect(schemas.RunGridCell.properties.jobs.items).toEqual({
      $ref: "#/components/schemas/RunGridJob",
    });
    expect(schemas.RunGridCell.properties.jobs.minItems).toBe(1);
    expect(Object.keys(schemas.RunGridJob.properties)).toEqual([
      "job_id",
      "job_url",
      "job_name",
      "outcome",
      "attempts",
      "started_at",
      "duration_milliseconds",
      "passed_duration_milliseconds",
      "decisive",
    ]);
    expect(schemas.RunGridJob.properties.attempts.items.enum).toEqual(
      RUN_OUTCOMES
    );
    expect(schemas.RunGridJob.properties.decisive.type).toBe("boolean");
    expect(schemas.RunGridCommit.properties.sha.pattern).toBe("^[0-9a-f]{40}$");
    for (const name of [
      "RunGrid",
      "RunGridLane",
      "RunGridCell",
      "RunGridJob",
      "RunGridCommit",
    ]) {
      expect(schemas[name].description).toBeTruthy();
    }
  });
});
