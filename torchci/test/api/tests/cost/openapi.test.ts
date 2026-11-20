import { buildOpenApiDocument } from "lib/api/openapi";
import { costQueryParameters } from "lib/api/tests/cost/parameters";

describe("cost OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/cost"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;
  const parameter = (name: string) =>
    operation.parameters.find((p: any) => p.name === name);

  test("documents the repository and a window of 1, 3 or 7 days, 7 by default", () => {
    expect(operation.operationId).toBe("getTestsCost");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(costQueryParameters());
    expect(operation.parameters.map((p: any) => p.name)).toEqual([
      "repo",
      "window",
    ]);
    expect(parameter("repo")).toMatchObject({ in: "query", required: true });
    expect(parameter("window")).toMatchObject({
      in: "query",
      schema: { enum: ["1d", "3d", "7d"], default: "7d" },
    });
    expect(parameter("window").required).toBeFalsy();
  });

  test("answers RunnerHours, or an error for bad parameters and failures; not heavy, so no 429", () => {
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/RunnerHours" });
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
    expect(operation.responses).not.toHaveProperty("404");
    expect(operation.responses).not.toHaveProperty("429");
  });

  test("says the rows sum to the window's runner-hours and keep the runner label a rates file prices, with no prices of its own", () => {
    expect(schemas.RunnerHours.properties.rows.items).toEqual({
      $ref: "#/components/schemas/RunnerHoursRow",
    });
    expect(schemas.RunnerHours.properties.rows.description).toMatch(
      /sum to the window's runner-hours/
    );
    expect(schemas.RunnerHoursRow.required).toEqual([
      "owner",
      "workflow",
      "machine",
      "machine_source",
      "label",
      "runner_hours",
    ]);
    expect(schemas.RunnerHoursRow.properties.label.description).toMatch(
      /what a rates file prices/
    );
    expect(schemas.RunnerHoursRow.properties.machine_source.enum).toEqual([
      "environment",
      "runner_label",
      "none",
    ]);
    expect(operation.description).toMatch(/prices the hours by runner label/);
    // Runner-hours only: no field of the answer is a price.
    for (const name of ["RunnerHours", "RunnerHoursRow", "CostMachine"]) {
      expect(Object.keys(schemas[name].properties)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/cost|rate|price|\$/i)])
      );
    }
  });
});

describe("cost V2 OpenAPI", () => {
  const document = buildOpenApiDocument();
  const schemas = document.components.schemas as Record<string, any>;
  const op = (path: string) => (document.paths[path] as any).get;

  test.each([
    [
      "/api/tests/cost/scope",
      "getTestsCostScope",
      ["repo", "a", "b", "trail", "by", "workflow"],
      "CostScope",
      false,
    ],
    [
      "/api/tests/cost/series",
      "getTestsCostSeries",
      ["repo", "trail", "by", "from", "to", "workflow"],
      "CostSeries",
      false,
    ],
    [
      "/api/tests/cost/cases",
      "getTestsCostCases",
      ["repo", "file", "machine", "a", "b", "environment"],
      "CostCases",
      true,
    ],
    [
      "/api/tests/cost/coverage",
      "getTestsCostCoverage",
      ["repo", "from", "to", "workflow"],
      "CostCoverage",
      false,
    ],
    [
      "/api/tests/cost/coverage/jobs",
      "getTestsCostCoverageJobs",
      ["repo", "from", "to"],
      "CostCoverageJobs",
      true,
    ],
  ])(
    "%s: %s, its parameters, its answer, a 429 only when heavy",
    (path, id, names, schema, heavy) => {
      const operation = op(path);
      expect(operation.operationId).toBe(id);
      expect(operation.tags).toEqual(["tests"]);
      expect(operation.parameters.map((p: any) => p.name)).toEqual(names);
      for (const p of operation.parameters) expect(p.description).toBeTruthy();
      expect(
        operation.responses["200"].content["application/json"].schema
      ).toEqual({
        $ref: `#/components/schemas/${schema}`,
      });
      expect(Object.hasOwn(operation.responses, "429")).toBe(heavy);
      // Runner-hours only: no field of the answer is a price.
      expect(Object.keys(schemas[schema].properties)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/cost|rate|price|\$/i)])
      );
    }
  );

  test("trail and by are documented as the page writes them; by is required, trail is not", () => {
    const params = op("/api/tests/cost/scope").parameters;
    const trail = params.find((p: any) => p.name === "trail");
    const by = params.find((p: any) => p.name === "by");
    expect(trail.required).toBeFalsy();
    expect(trail.description).toMatch(/o:inductor;m:Linux%20x86_64%20avx512/);
    expect(by.required).toBe(true);
    expect(by.schema.enum).toEqual(["o", "m", "f", "lane", "label"]);
  });
});
