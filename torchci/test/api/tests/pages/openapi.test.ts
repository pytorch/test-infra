import { buildOpenApiDocument } from "lib/api/openapi";
import {
  COMMIT_PAGE_FILTER_NAMES,
  COMMIT_PAGE_PARAMETER_DEFINITIONS,
  GRID_OUTCOMES,
  TEST_PAGE_PARAMETER_DEFINITIONS,
  TESTS_PAGE_PARAMETER_NAMES,
  TESTS_PAGE_UNSUPPORTED_PARAMETERS,
} from "lib/api/tests/pages/parameters";

// The HUD pages in the document: HTML for people, listed so that a caller
// of the API can give a reader the page that shows what it fetched, their
// parameters generated from the same definitions the pages read their URLs
// with and the list validates with.
describe("the pages in /api/openapi.json", () => {
  const document: any = buildOpenApiDocument();
  const operations = Object.fromEntries(
    Object.values<any>(document.paths).map((item) => [
      item.get.operationId,
      item.get,
    ])
  );
  const byName = (operation: any) =>
    Object.fromEntries(
      operation.parameters.map((parameter: any) => [parameter.name, parameter])
    ) as Record<string, any>;

  test("are tagged pages, for people, with an HTML answer and no token of their own", () => {
    expect(document.tags.map((tag: any) => tag.name)).toEqual([
      "tests",
      "pages",
    ]);
    for (const tag of document.tags) expect(tag.description).toBeTruthy();
    expect(document.paths["/tests/{organization}/{repo}"].get).toBe(
      operations.testsPage
    );
    expect(
      document.paths["/tests/{organization}/{repo}/test/{test_id}"].get
    ).toBe(operations.testPage);
    expect(
      document.paths["/tests/{organization}/{repo}/commit/{sha}"].get
    ).toBe(operations.commitPage);
    for (const page of [
      operations.testsPage,
      operations.testPage,
      operations.commitPage,
    ]) {
      expect(page.tags).toEqual(["pages"]);
      expect(page.summary).toMatch(/^HUD page/);
      expect(page.description).toMatch(/for people/);
      expect(page.description).toMatch(/rather than fetching it/);
      expect(page.security).toEqual([]);
      expect(Object.keys(page.responses)).toEqual(["200"]);
      expect(Object.keys(page.responses["200"].content)).toEqual(["text/html"]);
    }
  });

  test("the table page takes the list's parameters, the very same objects", () => {
    const page = operations.testsPage;
    const list = byName(operations.listTests);
    expect(
      page.parameters.map((parameter: any) => [parameter.in, parameter.name])
    ).toEqual([
      ["path", "organization"],
      ["path", "repo"],
      ...TESTS_PAGE_PARAMETER_NAMES.map((name) => ["query", name]),
    ]);
    for (const parameter of page.parameters) {
      if (parameter.in === "query") {
        expect(parameter).toEqual(list[parameter.name]);
      } else {
        expect(parameter.required).toBe(true);
        expect(parameter.description).toBeTruthy();
      }
    }
    for (const name of TESTS_PAGE_UNSUPPORTED_PARAMETERS) {
      expect(page.description).toContain(name);
    }
    expect(page.description).toMatch(/limit and cursor/);
  });

  test("the test page takes the grid's code sources and window, with its own defaults, and its own parameters", () => {
    const page = byName(operations.testPage);
    const runs = byName(operations.listRuns);
    const detail = byName(operations.getTest);
    expect(
      operations.testPage.parameters.map((parameter: any) => [
        parameter.in,
        parameter.name,
      ])
    ).toEqual([
      ["path", "organization"],
      ["path", "repo"],
      ["path", "test_id"],
      ...Object.keys(TEST_PAGE_PARAMETER_DEFINITIONS).map((name) => [
        "query",
        name,
      ]),
    ]);
    expect(page.test_id.schema).toEqual(detail.test_id.schema);
    expect(page.ran_on.schema.items).toEqual(runs.ran_on.schema.items);
    expect(page.ran_on.schema.default).toEqual(["main"]);
    expect(page.ran_on).toMatchObject({ style: "form", explode: false });
    expect(page.window.schema.enum).toEqual(runs.window.schema.enum);
    expect(page.window.schema.default).toBe("3d");
    expect(page.outcomes.schema).toMatchObject({
      type: "array",
      default: [...GRID_OUTCOMES],
      items: { enum: [...GRID_OUTCOMES] },
    });
    expect(page.time_bar.schema).toMatchObject({
      enum: ["0", "1"],
      default: "1",
    });
    expect(page.environment.schema.type).toBe("string");
    expect(page.env_vars.description).toMatch(/not the env_vars filter/);
    for (const parameter of operations.testPage.parameters) {
      expect(parameter.description).toBeTruthy();
      expect(parameter.required).toBe(parameter.in === "path");
    }
  });

  test("the commit page takes the commit runs endpoint's filters, the very same objects, and its own view", () => {
    const page = byName(operations.commitPage);
    const runs = byName(operations.listCommitRuns);
    expect(
      operations.commitPage.parameters.map((parameter: any) => [
        parameter.in,
        parameter.name,
      ])
    ).toEqual([
      ["path", "organization"],
      ["path", "repo"],
      ["path", "sha"],
      ...Object.keys(COMMIT_PAGE_PARAMETER_DEFINITIONS).map((name) => [
        "query",
        name,
      ]),
    ]);
    expect(page.sha.schema).toEqual(runs.sha.schema);
    for (const name of COMMIT_PAGE_FILTER_NAMES) {
      expect(page[name]).toEqual(runs[name]);
    }
    expect(page.status.schema).toMatchObject({
      type: "array",
      default: ["failed", "timed_out", "flaky", "other"],
      items: {
        enum: [
          "failed",
          "timed_out",
          "flaky",
          "passed",
          "other",
          "xfailed",
          "skipped",
        ],
      },
    });
    expect(page.status).toMatchObject({ style: "form", explode: true });
    expect(page.sort.schema).toMatchObject({
      type: "array",
      default: ["-duration_milliseconds"],
    });
    // The page puts the endpoint's status sort first itself, so its own
    // sort offers every other field.
    expect(page.sort.schema.items.enum).toEqual(
      runs.sort.schema.items.enum.filter(
        (field: string) => field !== "status" && field !== "-status"
      )
    );
    expect(runs.sort.schema.items.enum).toContain("status");
    for (const parameter of operations.commitPage.parameters) {
      expect(parameter.description).toBeTruthy();
      expect(parameter.required).toBe(parameter.in === "path");
    }
  });

  test("the API and the pages name each other", () => {
    expect(operations.listTests.description).toMatch(/testsPage/);
    expect(operations.getTest.description).toMatch(/testPage/);
    expect(operations.listRuns.description).toMatch(/testPage/);
    expect(operations.testsPage.description).toMatch(/listTests/);
    expect(operations.testPage.description).toMatch(/getTest/);
    expect(operations.testPage.description).toMatch(/listRuns/);
    expect(operations.commitPage.description).toMatch(/getCommitSummary/);
    expect(operations.commitPage.description).toMatch(/listCommitRuns/);
    expect(operations.getCommitSummary.description).toMatch(/commit page/);
  });

  test("every response that leads to a page says so", () => {
    const schemas = document.components.schemas;
    expect(schemas.TestRecord.properties.hud_url).toMatchObject({
      type: "string",
      format: "uri",
    });
    expect(schemas.TestRecord.required).toContain("hud_url");
    expect(schemas.TestHealthEntry.properties.hud_url).toMatchObject({
      type: "string",
      format: "uri",
    });
    expect(schemas.TestListPage.properties.hud_url.anyOf).toEqual([
      { type: "string", format: "uri" },
      { type: "null" },
    ]);
    expect(schemas.TestListPage.properties.hud_url.description).toMatch(
      /Null when/
    );
    expect(schemas.RunGrid.properties.hud_url.anyOf).toEqual([
      { type: "string", format: "uri" },
      { type: "null" },
    ]);
    expect(schemas.TestConfigurationHealth.properties).not.toHaveProperty(
      "hud_url"
    );
    for (const name of ["CommitSummary", "CommitRunListPage"]) {
      expect(schemas[name].properties.hud_url).toMatchObject({
        type: "string",
        format: "uri",
      });
      expect(schemas[name].required).toContain("hud_url");
      expect(schemas[name].properties.hud_url.description).toMatch(
        /commitPage/
      );
    }
  });
});
