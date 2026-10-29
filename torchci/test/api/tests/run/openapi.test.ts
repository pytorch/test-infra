import { buildOpenApiDocument } from "lib/api/openapi";
import { runDetailPathParameters } from "lib/api/tests/run/parameters";
import { RUN_ID } from "../test/runs/fixtures";

describe("run detail OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/run/{run_id}"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;

  test("documents a single required UUID path parameter and no filters", () => {
    expect(operation.operationId).toBe("getRun");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(runDetailPathParameters());
    expect(operation.parameters).toHaveLength(1);
    expect(operation.parameters[0]).toMatchObject({
      name: "run_id",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    expect(operation.parameters[0].schema.pattern).toBeTruthy();
    const uuidPattern = new RegExp(operation.parameters[0].schema.pattern);
    expect(uuidPattern.test(RUN_ID.toUpperCase())).toBe(true);
    expect(uuidPattern.test(RUN_ID.replace("0199", "g199"))).toBe(false);
    expect(operation.parameters[0].schema.$schema).toBeUndefined();
    expect(operation.parameters[0].description).toMatch(/UUID/i);
    expect(operation.parameters[0].description).toMatch(/attempts\[\]\.id/);
    expect(operation.parameters[0].description).toMatch(/full bundle/i);
    expect(operation.parameters[0].description).toMatch(/lowercase/i);
    expect(operation.parameters[0].description).toMatch(/report\.uuid/);
    expect(operation.parameters[0].description).toMatch(
      /github_workflow\.run_id/
    );
  });

  test("reuses the list bundle schema with each attempt's public UUID and report", () => {
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({
      $ref: "#/components/schemas/RunDetail",
    });
    expect(schemas.RunDetail.required).toEqual(["run", "query_duration_ms"]);
    expect(schemas.RunDetail.properties.run).toEqual({
      $ref: "#/components/schemas/RunRecord",
    });
    expect(schemas.RunListPage.properties.runs.items).toEqual(
      schemas.RunDetail.properties.run
    );
    expect(schemas.CommitRunListPage.properties.runs.items).toEqual(
      schemas.RunDetail.properties.run
    );
    expect(schemas.RunRecord.required).toContain("attempts");
    expect(schemas.RunRecord.properties).not.toHaveProperty("id");
    expect(schemas.RunRecord.properties.attempts.items).toEqual({
      $ref: "#/components/schemas/RunAttempt",
    });
    expect(schemas.RunAttempt.required).toContain("id");
    expect(schemas.RunAttempt.properties.id).toMatchObject({ type: "string" });
    expect(schemas.RunAttempt.properties.id.pattern).toBeTruthy();
    // One lookup scans the whole id column, so only the run operation itself
    // names the endpoint, together with what a call costs and that it is
    // provisional; the lists must not send callers there attempt by attempt.
    expect(schemas.RunAttempt.properties.id.description).not.toMatch(
      /\/api\/tests\/run\//
    );
    for (const [path, item] of Object.entries<any>(document.paths)) {
      if (path === "/api/tests/run/{run_id}") continue;
      expect(item.get.description ?? "").not.toMatch(/\/api\/tests\/run\//);
    }
    expect(operation.description).toMatch(/not indexed/i);
    expect(operation.description).toMatch(/one run at a time/i);
    expect(operation.description).toMatch(/provisional/i);
    expect(schemas.RunAttempt.properties.report).toEqual({
      $ref: "#/components/schemas/RunReport",
    });
    expect(schemas.RunDetail.properties.query_duration_ms).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemas.RunDetail.properties.query_duration_ms.description).toMatch(
      /concurrent/i
    );
    expect(operation.description).toMatch(
      /any retained attempt ID resolves the same bundle/i
    );
    expect(operation.description).toMatch(/includes the initial execution/i);
  });

  test("documents malformed, missing and failed run responses", () => {
    for (const status of ["400", "404", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({
        $ref: "#/components/schemas/ErrorResponse",
      });
    }
    expect(operation.responses["404"].description).toMatch(/run/i);
    expect(operation.description).toMatch(/retained/i);
  });
});
