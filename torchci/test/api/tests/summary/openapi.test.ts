import { buildOpenApiDocument } from "lib/api/openapi";
import { TEST_FIGURE_KINDS } from "lib/api/tests/options/types";

describe("test summary OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/summary"] as any).get;
  const listOperation = (document.paths["/api/tests"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;
  const parameters = Object.fromEntries(
    operation.parameters.map((parameter: any) => [parameter.name, parameter])
  ) as Record<string, any>;
  const listParameters = Object.fromEntries(
    listOperation.parameters.map((parameter: any) => [
      parameter.name,
      parameter,
    ])
  ) as Record<string, any>;

  test("documents an operation that answers TestSummary or fails, never a page or a 404", () => {
    expect(operation.operationId).toBe("getTestSummary");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.description).toMatch(/GET \/api\/tests\/options/);
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/TestSummary" });
    for (const status of ["400", "401", "403", "500", "503"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
    expect(operation.responses).not.toHaveProperty("404");
    // Not a heavy query: nothing to refuse.
    expect(operation.responses).not.toHaveProperty("429");
  });

  test("takes the repository, the window and the languages, as the list validates them", () => {
    expect(
      operation.parameters.map((parameter: any) => parameter.name)
    ).toEqual(["repo", "window", "language"]);
    expect(parameters.repo).toMatchObject({ in: "query", required: true });
    expect(parameters.repo.schema).toEqual(listParameters.repo.schema);
    expect(parameters.repo.description).toBe(listParameters.repo.description);
    expect(parameters.window).toMatchObject({ in: "query", required: false });
    expect(parameters.window.schema).toEqual(listParameters.window.schema);
    expect(parameters.window.schema.default).toBe("3h");
    expect(parameters.language).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: true,
    });
    expect(parameters.language.schema).toEqual(listParameters.language.schema);
    // The words are the summary's own.
    for (const name of ["window", "language"]) {
      expect(parameters[name].description).toBeTruthy();
      expect(parameters[name].description).not.toBe(
        listParameters[name].description
      );
    }
  });

  test("describes a figure by its kind, with the fields the other kinds leave null", () => {
    const figure = schemas.TestViewFigure;
    expect(figure.required).toEqual([
      "id",
      "kind",
      "window",
      "count",
      "duration_milliseconds",
      "test",
      "hud_url",
    ]);
    expect(figure.properties.kind.enum).toEqual([...TEST_FIGURE_KINDS]);
    expect(figure.properties.window.enum).toEqual(
      listParameters.window.schema.enum
    );
    for (const field of ["count", "duration_milliseconds"]) {
      expect(figure.properties[field].anyOf).toEqual([
        expect.objectContaining({ type: "integer", minimum: 0 }),
        { type: "null" },
      ]);
    }
    expect(figure.properties.test.anyOf).toEqual([
      { $ref: "#/components/schemas/TestRecord" },
      { type: "null" },
    ]);
    // The same kinds a view's figure names in the options.
    const viewFigure =
      schemas.TestOptions.properties.views.items.properties.figure;
    expect(viewFigure.properties.kind.enum).toEqual(
      figure.properties.kind.enum
    );
    // And there, the filters a figure adds to its view's, always present.
    expect(viewFigure.required).toEqual(["kind", "caption", "params"]);
    expect(viewFigure.properties.params.type).toBe("object");
    expect(viewFigure.properties.params.description).toMatch(/failing/);
    expect(figure.properties.count.description).toMatch(/figure\.params/);
  });

  test("describes the summary as the figures, their page and when the health was refreshed", () => {
    const summary = schemas.TestSummary;
    expect(summary.required).toEqual([
      "views",
      "hud_url",
      "refreshed_at",
      "query_duration_ms",
    ]);
    expect(summary.properties.views.items).toEqual({
      $ref: "#/components/schemas/TestViewFigure",
    });
    expect(summary.properties.query_duration_ms).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(summary.properties.refreshed_at.description).toMatch(/minute/);
  });
});
