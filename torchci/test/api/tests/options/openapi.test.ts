import { buildOpenApiDocument } from "lib/api/openapi";
import { ENVIRONMENT_FACETS } from "lib/api/tests/options/options";

describe("test options OpenAPI", () => {
  const document = buildOpenApiDocument();
  const operation = (document.paths["/api/tests/options"] as any).get;
  const listOperation = (document.paths["/api/tests"] as any).get;
  const schemas = document.components.schemas as Record<string, any>;
  const listParameters = Object.fromEntries(
    listOperation.parameters.map((parameter: any) => [
      parameter.name,
      parameter,
    ])
  ) as Record<string, any>;
  const FIXED_CHOICES = ["window", "ran_on", "language", "status"];
  const CATALOG_CHOICES = [
    ...ENVIRONMENT_FACETS,
    "test_config",
    "workflow_path",
    "owner",
  ];

  test("documents a parameterless operation that answers TestOptions or fails", () => {
    expect(operation.operationId).toBe("getTestOptions");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual([]);
    expect(operation.description).toMatch(/same parameter definitions/i);
    expect(operation.description).toMatch(/catalogs/i);
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/TestOptions" });
    expect(
      operation.responses["400"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    expect(
      operation.responses["500"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    expect(operation.responses).not.toHaveProperty("404");
  });

  test("describes each fixed choice with the list parameter's own enum, a default and labelled values", () => {
    const options = schemas.TestOptions;
    expect(options.required).toEqual([
      ...FIXED_CHOICES,
      ...CATALOG_CHOICES,
      "views",
    ]);
    const valueEnum = (choice: string) =>
      options.properties[choice].properties.values.items.properties.value.enum;
    expect(valueEnum("window")).toEqual(listParameters.window.schema.enum);
    expect(options.properties.window.properties.default).toMatchObject({
      type: "string",
      enum: listParameters.window.schema.enum,
    });
    expect(valueEnum("ran_on")).toEqual(
      listParameters.ran_on.schema.items.enum
    );
    expect(options.properties.ran_on.properties.default).toMatchObject({
      type: "array",
      minItems: 1,
      items: { enum: listParameters.ran_on.schema.items.enum },
    });
    expect(valueEnum("language")).toEqual(
      listParameters.language.schema.items.enum
    );
    expect(options.properties.language.properties.default).toMatchObject({
      type: "array",
      items: { enum: listParameters.language.schema.items.enum },
    });
    expect(valueEnum("status")).toEqual(
      listParameters.status.schema.items.enum
    );
    expect(options.properties.status.properties.default).toMatchObject({
      type: "array",
      items: { enum: listParameters.status.schema.items.enum },
    });
    for (const choice of [...FIXED_CHOICES, ...CATALOG_CHOICES]) {
      const schema = options.properties[choice];
      expect(schema.description).toBeTruthy();
      expect(schema.required).toEqual(["default", "values"]);
      expect(schema.properties.default.description).toBeTruthy();
      expect(schema.properties.values.description).toBeTruthy();
      expect(schema.properties.values.items.required).toEqual([
        "value",
        "label",
      ]);
      expect(schema.properties.values.items.properties.label).toMatchObject({
        type: "string",
      });
      expect(
        schema.properties.values.items.properties.label.description
      ).toMatch(/running text/i);
    }
  });

  test("describes each catalog choice as open strings the list filters on", () => {
    const options = schemas.TestOptions;
    for (const choice of CATALOG_CHOICES) {
      const schema = options.properties[choice];
      // The list takes any string for these filters; the catalogs say which
      // strings exist.
      expect(listParameters[choice]).toBeDefined();
      expect(schema.properties.values.items.properties.value).toMatchObject({
        type: "string",
      });
      expect(
        schema.properties.values.items.properties.value.enum
      ).toBeUndefined();
      expect(schema.properties.default).toMatchObject({
        type: "array",
        items: { type: "string" },
      });
      expect(schema.description).toContain(`${choice} filter`);
    }
  });
});
