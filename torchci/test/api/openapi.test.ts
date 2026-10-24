import { GET as getOpenApiDocument } from "app/api/openapi.json/route";
import { readdirSync } from "fs";
import { buildOpenApiDocument } from "lib/api/openapi";
import { ErrorResponseSchema } from "lib/api/schema";
import {
  FILTER_DEFINITIONS,
  PARAMETER_DEFINITIONS,
} from "lib/api/tests/parameters";
import { testDetailPathParameters } from "lib/api/tests/test/parameters";
import { TestListPageSchema } from "lib/api/tests/types";
import * as clickhouse from "lib/clickhouse";
import { join } from "path";
import { answerQueries, entityRow, getTests } from "./tests/fixtures";

// The route files under app/api and the path each serves. A [name] folder is
// a path parameter, written {name} like OpenAPI.
function routeFiles(
  directory = join(__dirname, "../../app/api"),
  path = "/api"
): { file: string; path: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      const segment = entry.name.replace(/^\[(\w+)\]$/, "{$1}");
      return routeFiles(join(directory, entry.name), `${path}/${segment}`);
    }
    return entry.name === "route.ts"
      ? [{ file: join(directory, entry.name), path }]
      : [];
  });
}

function* walk(
  value: unknown,
  path: string[] = []
): Generator<[string[], unknown]> {
  yield [path, value];
  if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      yield* walk(child, [...path, key]);
    }
  }
}

describe("GET /api/openapi.json", () => {
  let document: any;

  beforeAll(async () => {
    const response = getOpenApiDocument();
    expect(response.status).toBe(200);
    document = await response.json();
  });

  test("is an OpenAPI 3.1 document that caches well", () => {
    expect(document.openapi).toBe("3.1.0");
    expect(document.info.title).toBeTruthy();
    expect(document.servers).toEqual([{ url: "https://hud.pytorch.org" }]);
    expect(getOpenApiDocument().headers.get("Cache-Control")).toMatch(
      /max-age=/
    );
  });

  test("names the deploy that serves it as its version", () => {
    const deployedCommit = process.env.VERCEL_GIT_COMMIT_SHA;
    try {
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      expect(buildOpenApiDocument().info.version).toBe("development");
      process.env.VERCEL_GIT_COMMIT_SHA =
        "0123456789abcdef0123456789abcdef01234567";
      expect(buildOpenApiDocument().info.version).toBe(
        "0123456789abcdef0123456789abcdef01234567"
      );
    } finally {
      if (deployedCommit === undefined) {
        delete process.env.VERCEL_GIT_COMMIT_SHA;
      } else {
        process.env.VERCEL_GIT_COMMIT_SHA = deployedCommit;
      }
    }
  });

  test("documents exactly the routes under app/api, with their path parameter names", () => {
    const served = routeFiles()
      .map(({ path }) => path)
      .filter((path) => path !== "/api/openapi.json");
    expect(Object.keys(document.paths).sort()).toEqual(served.sort());
    for (const [route, item] of Object.entries<any>(document.paths)) {
      const templated = Array.from(
        route.matchAll(/\{(\w+)\}/g),
        (match) => match[1]
      );
      const declared = item.get.parameters
        .filter((parameter: any) => parameter.in === "path")
        .map((parameter: any) => parameter.name);
      expect(declared).toEqual(templated);
    }
  });

  test("routes export only GET and dynamic = force-dynamic, so they never run at build time", async () => {
    for (const { file } of routeFiles()) {
      const route = await import(file);
      expect({
        file,
        exports: Object.keys(route).sort(),
        dynamic: route.dynamic,
      }).toEqual({
        file,
        exports: ["GET", "dynamic"],
        dynamic: "force-dynamic",
      });
    }
  });

  test("documents /api/tests from the central parameter registry", () => {
    const operation = document.paths["/api/tests"].get;
    expect(operation.operationId).toBe("listTests");
    expect(
      operation.parameters.map((parameter: any) => parameter.name)
    ).toEqual(Object.keys(PARAMETER_DEFINITIONS));
    const byName = Object.fromEntries(
      operation.parameters.map((parameter: any) => [parameter.name, parameter])
    ) as Record<string, any>;
    expect(byName).not.toHaveProperty("test_id");
    expect(byName).not.toHaveProperty("environment_id");
    expect(byName).not.toHaveProperty("workflow_paths");
    expect(byName.repo).toMatchObject({ in: "query", required: true });
    expect(byName.repo.schema.pattern).toBeTruthy();
    expect(byName.search).toMatchObject({
      required: false,
      schema: { type: "string", maxLength: 200 },
    });
    expect(byName.search.description).toMatch(/exact, case-sensitive/i);
    expect(byName.workflow_path).toMatchObject({
      in: "query",
      required: false,
      style: "form",
      explode: true,
      schema: { type: "array", minItems: 1, items: { type: "string" } },
    });
    expect(byName.workflow_path.schema).not.toHaveProperty("default");
    expect(byName.workflow_path.description).toMatch(/exact, case-sensitive/i);
    expect(byName.ran_on).toMatchObject({
      required: false,
      style: "form",
      explode: false,
      schema: {
        type: "array",
        default: ["main"],
        items: { type: "string", enum: ["main", "pull_request"] },
      },
    });
    for (const name of Object.keys(FILTER_DEFINITIONS)) {
      expect(byName[name]).toMatchObject({
        required: false,
        style: "form",
        explode: true,
        schema: { type: "array", minItems: 1 },
      });
      expect(byName[name].description).toMatch(/repeat this parameter/i);
    }
    for (const name of ["environments_id", "env_vars_id"]) {
      expect(byName[name]).toMatchObject({
        in: "query",
        style: "form",
        explode: true,
        schema: { type: "array", items: { type: "string" } },
      });
    }
    expect(byName.env_vars).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
        },
      },
    });
    expect(byName.window.schema).toMatchObject({
      type: "string",
      default: "7d",
      enum: ["3h", "12h", "1d", "3d", "7d", "14d"],
    });
    expect(byName.sort).toMatchObject({
      style: "form",
      explode: false,
      schema: { type: "array", default: ["-last_run_at"] },
    });
    expect(byName.sort.schema.items.enum).toEqual(
      expect.arrayContaining([
        "failure_rate",
        "-failure_rate",
        "-runs",
        "case_name",
        "cpu_architecture",
        "-device_count",
      ])
    );
    for (const name of [
      "test_id",
      "environments_id",
      "env_vars_id",
      "workflow_path",
      "workflow_paths",
    ]) {
      expect(byName.sort.schema.items.enum).not.toContain(name);
      expect(byName.sort.schema.items.enum).not.toContain(`-${name}`);
    }
    expect(byName.limit.schema).toMatchObject({
      type: "integer",
      default: 25,
      minimum: 1,
      maximum: 100,
    });
    for (const parameter of operation.parameters) {
      expect(parameter.description).toBeTruthy();
      const schema =
        parameter.schema ?? parameter.content["application/json"].schema;
      expect(schema.$schema).toBeUndefined();
    }
    expect(operation.tags).toEqual(["tests"]);
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({
      $ref: "#/components/schemas/TestListPage",
    });
    for (const status of ["400", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({
        $ref: "#/components/schemas/ErrorResponse",
      });
    }
    expect(operation.responses).not.toHaveProperty("405");
  });

  test("has every referenced component, free of JSON Schema headers", () => {
    const schemas = document.components.schemas;
    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        "ErrorResponse",
        "TestHealthEntry",
        "TestListPage",
        "TestConfigurationHealth",
        "TestDetail",
        "RunDetail",
        "CommitRunListPage",
        "RunStats",
      ])
    );
    for (const [path, value] of walk(document)) {
      const key = path[path.length - 1];
      if (key === "$ref") {
        const target = String(value).replace("#/components/schemas/", "");
        expect(schemas[target]).toBeDefined();
      }
      if (path.length > 2 && path[0] === "components") {
        expect(key).not.toBe("$schema");
      }
    }
    for (const schema of Object.values(schemas) as any[]) {
      expect(schema.id).toBeUndefined();
      expect(schema.description).toBeTruthy();
      for (const property of Object.values(schema.properties) as any[]) {
        expect(property.description ?? property.$ref).toBeTruthy();
      }
    }
    expect(schemas.TestHealthEntry.properties.health).toEqual({
      $ref: "#/components/schemas/HealthSummary",
    });
    expect(schemas.HealthSummary.required).toContain("workflow_paths");
    expect(schemas.HealthSummary.properties.workflow_paths).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(schemas.TestHealthEntry.properties.test).toEqual({
      $ref: "#/components/schemas/TestRecord",
    });
    expect(schemas.TestRecord.type).toBe("object");
    expect(schemas.TestHealthEntry.required).toContain("test");
    for (const field of ["environments_id", "env_vars_id"]) {
      expect(schemas.TestHealthEntry.properties).not.toHaveProperty(field);
      expect(schemas.TestHealthEntry.required).not.toContain(field);
    }
    for (const schema of [schemas.EnvironmentRecord, schemas.EnvVarsRecord]) {
      expect(schema.required).toContain("id");
      expect(schema.properties.id).toMatchObject({
        type: "string",
        pattern: "^\\d{1,20}$",
      });
    }
    expect(schemas.TestListPage.properties.tests.items).toEqual({
      $ref: "#/components/schemas/TestHealthEntry",
    });
    expect(schemas.TestListPage.properties.query_duration_ms).toMatchObject({
      type: "integer",
      minimum: 0,
    });
    expect(schemas.TestListPage.required).toEqual([
      "tests",
      "next_cursor",
      "refreshed_at",
      "query_duration_ms",
    ]);
  });

  test("documents a detail path with an ID and all health without list filters", () => {
    const operation = document.paths["/api/tests/test/{test_id}"].get;
    expect(operation.operationId).toBe("getTest");
    expect(operation.tags).toEqual(["tests"]);
    expect(operation.parameters).toEqual(testDetailPathParameters());
    expect(operation.parameters).toHaveLength(1);
    expect(operation.parameters[0]).toMatchObject({
      name: "test_id",
      in: "path",
      required: true,
      schema: { type: "string" },
    });
    expect(operation.parameters[0].description).toBeTruthy();
    expect(operation.parameters[0].schema.$schema).toBeUndefined();
    expect(operation.description).toMatch(/every observed/i);
    expect(operation.description).toMatch(
      /windows and code sources are kept separate/i
    );
    expect(
      operation.responses["200"].content["application/json"].schema
    ).toEqual({ $ref: "#/components/schemas/TestDetail" });
    for (const status of ["400", "404", "500"]) {
      expect(
        operation.responses[status].content["application/json"].schema
      ).toEqual({ $ref: "#/components/schemas/ErrorResponse" });
    }
  });

  test("detail responses reuse the list's test, owner and health shapes", () => {
    const schemas = document.components.schemas;
    const detail = schemas.TestDetail;
    const configuration = schemas.TestConfigurationHealth;
    const entry = schemas.TestHealthEntry;
    expect(detail.required).toEqual([
      "test",
      "owners",
      "health",
      "refreshed_at",
      "query_duration_ms",
    ]);
    expect(detail.properties.test).toEqual(entry.properties.test);
    expect(detail.properties.owners).toEqual(entry.properties.owners);
    expect(detail.properties.health).toMatchObject({
      type: "array",
      items: { $ref: "#/components/schemas/TestConfigurationHealth" },
    });
    expect(detail.properties).not.toHaveProperty("next_cursor");
    expect(configuration.required).toEqual([
      "environment",
      "env_vars",
      "health",
    ]);
    for (const property of ["environment", "env_vars", "health"]) {
      expect(configuration.properties[property]).toEqual(
        entry.properties[property]
      );
    }
    expect(configuration.properties).not.toHaveProperty("test");
    expect(configuration.properties).not.toHaveProperty("owners");
  });
});

describe("the handler answers what its schemas describe", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("a tests page includes hardware and environment variables with no undocumented fields", async () => {
    const queryClickhouse = jest.spyOn(clickhouse, "queryClickhouse");
    answerQueries(queryClickhouse, {
      tests: [
        entityRow(1, undefined, undefined, {
          workflow_paths_combined: [
            ".github/workflows/pull.yml",
            ".github/workflows/trunk.yml",
          ],
        }),
        entityRow(2, "2081130751942693631", "1688593832548410198", {
          environment_id_string: "0",
          env_var_set_id_string: "0",
        }),
      ],
    });
    const res = await getTests();
    expect(res.status).toBe(200);
    expect(TestListPageSchema.parse(res.body)).toEqual(res.body);
    expect(res.body.tests).toHaveLength(2);
    expect(res.body.tests[0].health.ran_on).toEqual(["main"]);
    expect(res.body.tests[0].health.workflow_paths).toEqual([
      ".github/workflows/pull.yml",
      ".github/workflows/trunk.yml",
    ]);
    expect(res.body.tests[0].environment.cpu_architecture).toBe("x86_64");
    expect(res.body.tests[0].env_vars.env_vars).toEqual({
      TEST_CONFIG: "default",
    });
    expect(res.body.tests[0].environment.id).toBe("2081130751942693630");
    expect(res.body.tests[0].env_vars.id).toBe("1688593832548410197");
    for (const entry of res.body.tests) {
      expect(entry).not.toHaveProperty("environments_id");
      expect(entry).not.toHaveProperty("env_vars_id");
    }
    expect(res.body.tests[1].test.id).toBeDefined();
    expect(res.body.tests[1].environment).toBeNull();
    expect(res.body.tests[1].env_vars).toBeNull();
    expect(res.body.tests[1].health).toBeDefined();
    expect(res.body.tests[1].health.workflow_paths).toEqual([]);
  });

  test("an error validates against ErrorResponse", async () => {
    const res = await getTests({ repo: "nope" });
    expect(res.status).toBe(400);
    expect(ErrorResponseSchema.parse(res.body)).toEqual(res.body);
  });
});
