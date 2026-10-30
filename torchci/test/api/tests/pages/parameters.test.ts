import {
  decodePageQuery,
  GRID_OUTCOMES,
  pageQueryString,
  pageUrlParams,
  TEST_PAGE_PARAMETER_DEFINITIONS,
  testPagePath,
  TESTS_PAGE_PAGING_PARAMETERS,
  TESTS_PAGE_PARAMETER_DEFINITIONS,
  TESTS_PAGE_PARAMETER_NAMES,
  TESTS_PAGE_UNSUPPORTED_PARAMETERS,
  testsPagePath,
} from "lib/api/tests/pages/parameters";
import {
  DEFAULT_RAN_ON,
  DEFAULT_SORT,
  DEFAULT_WINDOW,
  PARAMETER_DEFINITIONS,
} from "lib/api/tests/parameters";
import { NAME_FILTERS, TESTS_FACETS } from "lib/tests/facets";

describe("the table page's parameters", () => {
  test("are the list's own definitions, picked by name", () => {
    for (const name of TESTS_PAGE_PARAMETER_NAMES) {
      expect(TESTS_PAGE_PARAMETER_DEFINITIONS[name]).toBe(
        PARAMETER_DEFINITIONS[name]
      );
    }
    expect(Object.keys(TESTS_PAGE_PARAMETER_DEFINITIONS)).toEqual([
      ...TESTS_PAGE_PARAMETER_NAMES,
    ]);
  });

  // Both ways: a facet or name filter the page offers must be listed, and a
  // listed name must have a reader on the page, else the document says the
  // page reads it and the links carry it while the page ignores it. Besides
  // the facets and the name filters the page reads the search, the language
  // and the title's code sources, window and sort (resolveTestsQuery in
  // lib/tests/table.ts).
  test("are exactly what the page reads", () => {
    expect([...TESTS_PAGE_PARAMETER_NAMES].sort()).toEqual(
      [
        ...TESTS_FACETS,
        ...NAME_FILTERS,
        "search",
        "language",
        "ran_on",
        "window",
        "sort",
      ].sort()
    );
  });

  test("account for every list parameter: read, paging, or unsupported", () => {
    expect(TESTS_PAGE_UNSUPPORTED_PARAMETERS).toEqual([
      "environments_id",
      "env_vars_id",
      "env_vars",
    ]);
    expect(
      [
        "repo",
        ...TESTS_PAGE_PARAMETER_NAMES,
        ...TESTS_PAGE_PAGING_PARAMETERS,
        ...TESTS_PAGE_UNSUPPORTED_PARAMETERS,
      ].sort()
    ).toEqual(Object.keys(PARAMETER_DEFINITIONS).sort());
  });
});

describe("the test page's parameters", () => {
  test("default to three days of main, every outcome and the time bar", () => {
    const defaults = Object.fromEntries(
      Object.entries(TEST_PAGE_PARAMETER_DEFINITIONS).map(
        ([name, definition]) => [name, definition.schema.parse(undefined)]
      )
    );
    expect(defaults).toEqual({
      ran_on: ["main"],
      window: "3d",
      outcomes: [...GRID_OUTCOMES],
      time_bar: "1",
      commit: undefined,
      environment: undefined,
      env_vars: undefined,
    });
  });

  test("check an id as the API spells ids", () => {
    const { schema } = TEST_PAGE_PARAMETER_DEFINITIONS.environment;
    expect(schema.parse("2081130751942693630")).toBe("2081130751942693630");
    expect(schema.parse("007")).toBe("7");
    expect(schema.safeParse("abc").success).toBe(false);
    expect(schema.safeParse("99999999999999999999").success).toBe(false);
  });
});

describe("decodePageQuery", () => {
  test("decodes each parameter by its encoding and ignores the rest", () => {
    expect(
      decodePageQuery(
        {
          ran_on: ["pull_request", " main ,pull_request"],
          sort: "-runs, case_name",
          language: "python,cpp",
          device_name: ["Tesla T4", "NVIDIA L4"],
          window: "7d",
          search: "conv",
          organization: "pytorch",
          limit: "10",
          bogus: "1",
        },
        TESTS_PAGE_PARAMETER_DEFINITIONS
      )
    ).toEqual({
      ran_on: ["pull_request", "main", "pull_request"],
      sort: ["-runs", "case_name"],
      language: ["python,cpp"],
      device_name: ["Tesla T4", "NVIDIA L4"],
      window: "7d",
      search: "conv",
    });
  });

  test("drops a single-valued parameter written twice", () => {
    expect(
      decodePageQuery(
        { window: ["7d", "3h"], commit: ["a", "b"], search: ["x"] },
        {
          ...TESTS_PAGE_PARAMETER_DEFINITIONS,
          ...TEST_PAGE_PARAMETER_DEFINITIONS,
        }
      )
    ).toEqual({ search: undefined, window: undefined, commit: undefined });
  });
});

describe("pageUrlParams", () => {
  test("leaves off what is absent, empty or the definition's default", () => {
    expect(
      pageUrlParams(
        {
          sort: [...DEFAULT_SORT],
          window: DEFAULT_WINDOW,
          ran_on: [...DEFAULT_RAN_ON],
          language: [],
          search: "",
          file: undefined,
        },
        TESTS_PAGE_PARAMETER_DEFINITIONS
      )
    ).toEqual(
      Object.fromEntries(
        TESTS_PAGE_PARAMETER_NAMES.map((name) => [name, undefined])
      )
    );
    expect(
      pageUrlParams(
        {
          ran_on: ["main"],
          window: "3d",
          outcomes: [...GRID_OUTCOMES],
          time_bar: "1",
          commit: "",
        },
        TEST_PAGE_PARAMETER_DEFINITIONS
      )
    ).toEqual({
      ran_on: undefined,
      window: undefined,
      outcomes: undefined,
      time_bar: undefined,
      commit: undefined,
      environment: undefined,
      env_vars: undefined,
    });
  });

  test("spells a comma-separated parameter joined and a repeated one as an array", () => {
    expect(
      pageUrlParams(
        {
          sort: ["-runs"],
          window: "7d",
          ran_on: ["main", "pull_request"],
          language: ["python", "cpp"],
          accelerator_version: [""],
          search: "conv",
        },
        TESTS_PAGE_PARAMETER_DEFINITIONS
      )
    ).toMatchObject({
      sort: "-runs",
      window: "7d",
      ran_on: "main,pull_request",
      language: ["python", "cpp"],
      accelerator_version: [""],
      search: "conv",
      file: undefined,
    });
    expect(
      pageUrlParams(
        {
          ran_on: ["main", "pull_request"],
          window: "14d",
          outcomes: ["failed", "flaky"],
          time_bar: "0",
          commit: "8f3a1",
          environment: "1",
          env_vars: "7",
        },
        TEST_PAGE_PARAMETER_DEFINITIONS
      )
    ).toEqual({
      ran_on: "main,pull_request",
      window: "14d",
      outcomes: "failed,flaky",
      time_bar: "0",
      commit: "8f3a1",
      environment: "1",
      env_vars: "7",
    });
  });

  test("round trips through a URL's query", () => {
    const values = {
      sort: ["-runs"],
      ran_on: ["main", "pull_request"],
      language: ["python", "cpp"],
      device_name: ["Tesla T4", "NVIDIA L4"],
      file: ["test/test_torch.py"],
      search: "conv test",
    };
    const params = pageUrlParams(values, TESTS_PAGE_PARAMETER_DEFINITIONS);
    // The query as Next's router hands it to a page: a repeated parameter
    // as an array.
    const url: Record<string, string | string[]> = {};
    for (const [name, value] of new URLSearchParams(pageQueryString(params))) {
      const existing = url[name];
      url[name] = existing === undefined ? value : [existing, value].flat();
    }
    expect(decodePageQuery(url, TESTS_PAGE_PARAMETER_DEFINITIONS)).toEqual(
      values
    );
  });
});

describe("pageQueryString", () => {
  test("writes a repeated parameter once per value and nothing for none", () => {
    expect(
      pageQueryString({
        ran_on: "main,pull_request",
        language: ["python", "cpp"],
        search: "a b&c",
        file: undefined,
      })
    ).toBe(
      "?ran_on=main%2Cpull_request&language=python&language=cpp&search=a+b%26c"
    );
    expect(pageQueryString({ file: undefined })).toBe("");
  });
});

describe("the pages' paths", () => {
  test("address a repository and a test", () => {
    expect(testsPagePath("pytorch/pytorch")).toBe("/tests/pytorch/pytorch");
    expect(testPagePath("pytorch/vision", "42")).toBe(
      "/tests/pytorch/vision/test/42"
    );
    expect(testPagePath("a b/c", "1")).toBe("/tests/a%20b/c/test/1");
  });
});
