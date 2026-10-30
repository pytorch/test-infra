// The glue between the tests table and GET /api/tests: how header sorts are
// spelled for the API and read back from a URL, how the title's choices are
// read from a URL and checked against GET /api/tests/options, how page
// requests are addressed, and how a test's name, its environment, its config
// and its mean duration are laid out in their cells.

import { CellBlock } from "components/tests/CellBlock";
import Config from "components/tests/Config";
import Environment from "components/tests/Environment";
import HeaderFilter from "components/tests/HeaderFilter";
import Health from "components/tests/Health";
import { lastRunLabel } from "components/tests/LastRun";
import MeanPassedDuration from "components/tests/MeanPassedDuration";
import NameSearch from "components/tests/NameSearch";
import Owners from "components/tests/Owners";
import TestName, {
  breakPieces,
  testNameParts,
} from "components/tests/TestName";
import { descriptionsFor } from "components/tests/TestsTable";
import TextButton from "components/tests/TextButton";
import TextLink from "components/tests/TextLink";
import { timeAgoLabel, whenPhrase } from "components/tests/TimeAgo";
import dayjs from "dayjs";
import { testOptionsFrom } from "lib/api/tests/options/options";
import { DEFAULT_SORT } from "lib/api/tests/parameters";
import type {
  EnvironmentRecord,
  EnvVarsRecord,
  TestRecord,
} from "lib/api/tests/types";
import {
  configToken,
  environmentDetails,
  environmentTokens,
  fitTokens,
  OWNER_LINE_BUDGET,
  ownerTokens,
  Token,
  variableLines,
  WORKFLOW_LINE_BUDGET,
  workflowTokens,
} from "lib/tests/environment";
import {
  CONFIG_COLUMN_FACETS,
  ENVIRONMENT_COLUMN_FACETS,
  FACET_TITLES,
  facetsPhrase,
  FacetValues,
  labelOf,
  menuOrder,
  NAME_FILTERS,
  noFacetValues,
  noNameFilterValues,
  OWNER_COLUMN_FACETS,
  pairText,
  phraseAlternatives,
  phraseList,
  sectionSummary,
  TESTS_FACETS,
} from "lib/tests/facets";
import {
  HealthCounts,
  healthDetails,
  healthFacts,
  healthRate,
  rateLabel,
  statusLabel,
} from "lib/tests/health";
import { COLUMN_HEADER_HEIGHT, NAME_FILTER_ROW_HEIGHT } from "lib/tests/layout";
import { testPagePath, testRunsHref } from "lib/tests/links";
import { endsTextSelection } from "lib/tests/selection";
import {
  accessReasonOf,
  apiErrorMessage,
  columnHeaderHeightFor,
  DEFAULT_TESTS_SORT,
  durationLabel,
  integerLabel,
  languagesPhrase,
  passedRunsLabel,
  ranOnPhrase,
  resolveTestsQuery,
  sortModelOf,
  sortParamOf,
  TESTS_TABLE_SORT_FIELDS,
  testsApiUrl,
  TestsQuery,
  testsQueryFromUrl,
  testsQueryKey,
  testsUrlParams,
  TestsUrlQuery,
} from "lib/tests/table";
import { workflowName } from "lib/workflowName";
import NextLink from "next/link";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, ReactTestRenderer } from "react-test-renderer";
import { CATALOG_VALUES } from "test/api/tests/fixtures";

// The options as the API would answer them for the fixture catalogs, built
// from its own definitions.
const options = testOptionsFrom(CATALOG_VALUES);
// What a bare URL resolves to: the API's defaults.
const defaultQuery: TestsQuery = {
  sort: DEFAULT_TESTS_SORT,
  window: options.window.default,
  ranOn: [...options.ran_on.default],
  languages: [...options.language.default],
  filters: noFacetValues(),
  nameFilters: noNameFilterValues(),
  search: "",
};
// The facet filters with the given facets chosen and the rest empty.
const filtersWith = (chosen: Partial<FacetValues>): FacetValues => ({
  ...noFacetValues(),
  ...chosen,
});

const ENVIRONMENT_SORT =
  "accelerator,accelerator_version,device_name,device_count,python_version,os,os_version,cpu_architecture,cpu_capability,cc_compiler,cc_compiler_version";

describe("sortParamOf", () => {
  test("spells the name column as its three fields in one direction", () => {
    expect(sortParamOf([{ field: "name", sort: "asc" }])).toBe(
      "file,suite,case_name"
    );
    expect(sortParamOf([{ field: "name", sort: "desc" }])).toBe(
      "-file,-suite,-case_name"
    );
  });

  test("spells the environment column as its fields, like with like", () => {
    expect(sortParamOf([{ field: "environment", sort: "asc" }])).toBe(
      ENVIRONMENT_SORT
    );
    expect(sortParamOf([{ field: "environment", sort: "desc" }])).toBe(
      ENVIRONMENT_SORT.split(",")
        .map((field) => `-${field}`)
        .join(",")
    );
  });

  test("spells the config and owners columns as the API fields", () => {
    expect(sortParamOf([{ field: "test_config", sort: "asc" }])).toBe(
      "test_config"
    );
    expect(sortParamOf([{ field: "owners", sort: "asc" }])).toBe("owner");
    expect(sortParamOf([{ field: "owners", sort: "desc" }])).toBe("-owner");
  });

  test("spells the health column as the status, the rate and count that grade it, the newest failure, then the skip rate and the passing mean", () => {
    expect(sortParamOf([{ field: "health", sort: "desc" }])).toBe(
      "-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds"
    );
    expect(
      sortModelOf(
        "-status,-failure_rate,-failed_runs,-last_failed_at,-skip_rate,-mean_passed_duration_milliseconds"
      )
    ).toEqual([{ field: "health", sort: "desc" }]);
    // The API's rate alone stands for no header.
    expect(sortModelOf("-failure_rate")).toEqual([]);
  });

  test("spells the last run column as the API field", () => {
    expect(sortParamOf([{ field: "last_run_at", sort: "desc" }])).toBe(
      "-last_run_at"
    );
    expect(sortParamOf([{ field: "last_run_at", sort: "asc" }])).toBe(
      "last_run_at"
    );
  });

  test("spells the mean duration column as the API field", () => {
    expect(
      sortParamOf([
        { field: "mean_passed_duration_milliseconds", sort: "desc" },
      ])
    ).toBe("-mean_passed_duration_milliseconds");
    expect(
      sortParamOf([{ field: "mean_passed_duration_milliseconds", sort: "asc" }])
    ).toBe("mean_passed_duration_milliseconds");
  });

  test("has nothing to say for an empty model or an unknown column", () => {
    expect(sortParamOf([])).toBeUndefined();
    expect(sortParamOf([{ field: "name", sort: null }])).toBeUndefined();
    expect(sortParamOf([{ field: "owner", sort: "asc" }])).toBeUndefined();
  });
});

describe("sortModelOf", () => {
  test("reads back every column in both directions", () => {
    for (const field of Object.keys(TESTS_TABLE_SORT_FIELDS)) {
      for (const sort of ["asc", "desc"] as const) {
        const model = [{ field, sort }];
        expect(sortModelOf(sortParamOf(model)!)).toEqual(model);
      }
    }
  });

  test("shows the default sort on the Health header", () => {
    expect(sortModelOf(DEFAULT_TESTS_SORT)).toEqual([
      { field: "health", sort: "desc" },
    ]);
  });

  test("spells the API's own default sort", () => {
    expect(DEFAULT_TESTS_SORT).toBe(DEFAULT_SORT.join(","));
  });

  test("is empty for sorts no header stands for", () => {
    expect(sortModelOf("-runs")).toEqual([]);
    expect(sortModelOf("file,-suite,-case_name")).toEqual([]);
    expect(sortModelOf("file,suite")).toEqual([]);
    expect(sortModelOf("suite,file,case_name")).toEqual([]);
    expect(sortModelOf("accelerator,device_name")).toEqual([]);
  });
});

describe("menuOrder and labelOf", () => {
  test("keep the offered values, in the options' order, once each", () => {
    expect(
      menuOrder(["cpp", "rust", "python", "cpp"], options.language.values)
    ).toEqual(["python", "cpp"]);
    expect(menuOrder([], options.window.values)).toEqual([]);
    expect(
      menuOrder(
        ["Tesla T4", "NVIDIA L4", "GeForce"],
        options.device_name.values
      )
    ).toEqual(["NVIDIA L4", "Tesla T4"]);
  });

  test("say a value as the options label it", () => {
    expect(labelOf("7d", options.window.values)).toBe("7 days");
    expect(labelOf("pull_request", options.ran_on.values)).toBe(
      "pull requests"
    );
    expect(labelOf("cuda", options.accelerator.values)).toBe("CUDA");
    expect(labelOf("3.11", options.python_version.values)).toBe("3.11");
  });

  test("say a folded section's choice: any, the one value, or a count", () => {
    expect(sectionSummary([], options.accelerator.values)).toBe("Any");
    expect(sectionSummary(["cuda"], options.accelerator.values)).toBe("CUDA");
    expect(sectionSummary(["plan9"], options.os.values)).toBe("plan9");
    expect(
      sectionSummary(["cuda", "rocm", "cpu"], options.accelerator.values)
    ).toBe("3 chosen");
  });
});

describe("testsQueryFromUrl", () => {
  test("reads a bare URL as asking for nothing in particular", () => {
    expect(testsQueryFromUrl({})).toEqual({
      sort: DEFAULT_TESTS_SORT,
      window: undefined,
      ranOn: [],
      languages: [],
      filters: noFacetValues(),
      nameFilters: noNameFilterValues(),
      search: "",
    });
  });

  test("reads each parameter as written, in the API's spelling", () => {
    expect(
      testsQueryFromUrl({
        sort: "file,suite,case_name",
        window: "1d",
        ran_on: "pull_request,main",
        language: "cpp",
        accelerator: "cuda",
        device_name: ["Tesla T4", "NVIDIA L4"],
        test_config: "default",
        file: "test/test_torch.py",
        case_name: ["test_add", "test_sub"],
        search: "Conv",
      })
    ).toEqual({
      sort: "file,suite,case_name",
      window: "1d",
      ranOn: ["pull_request", "main"],
      languages: ["cpp"],
      filters: filtersWith({
        accelerator: ["cuda"],
        device_name: ["Tesla T4", "NVIDIA L4"],
        test_config: ["default"],
      }),
      nameFilters: {
        ...noNameFilterValues(),
        file: ["test/test_torch.py"],
        case_name: ["test_add", "test_sub"],
      },
      search: "Conv",
    });
  });

  test("accepts repeated and comma-separated ran_on values", () => {
    expect(
      testsQueryFromUrl({ ran_on: ["pull_request", "main,pull_request"] }).ranOn
    ).toEqual(["pull_request", "main", "pull_request"]);
  });

  test("reads a comma in language and in a facet literally, as the API does", () => {
    expect(testsQueryFromUrl({ language: "python,cpp" }).languages).toEqual([
      "python,cpp",
    ]);
    expect(
      testsQueryFromUrl({ python_version: "3.11,3.12" }).filters.python_version
    ).toEqual(["3.11,3.12"]);
  });

  test("keeps values it cannot judge for the options to judge", () => {
    expect(
      testsQueryFromUrl({ window: "2d", ran_on: "nightly", language: "rust" })
    ).toEqual({
      sort: DEFAULT_TESTS_SORT,
      window: "2d",
      ranOn: ["nightly"],
      languages: ["rust"],
      filters: noFacetValues(),
      nameFilters: noNameFilterValues(),
      search: "",
    });
    expect(testsQueryFromUrl({ sort: "-runs" }).sort).toBe("-runs");
    expect(testsQueryFromUrl({ os: "plan9" }).filters.os).toEqual(["plan9"]);
  });
});

describe("resolveTestsQuery", () => {
  const resolve = (url: Record<string, string | string[] | undefined>) =>
    resolveTestsQuery(testsQueryFromUrl(url), options);

  test("resolves a bare URL to the API's defaults", () => {
    expect(resolve({})).toEqual(defaultQuery);
  });

  test("puts the chosen values in menu order without repeats", () => {
    expect(
      resolve({
        window: "1d",
        ran_on: ["pull_request", "main,pull_request"],
        language: ["unknown", "python", "unknown"],
        python_version: ["3.14", "3.9", "3.14"],
      })
    ).toEqual({
      sort: DEFAULT_TESTS_SORT,
      window: "1d",
      ranOn: ["main", "pull_request"],
      languages: ["python", "unknown"],
      filters: filtersWith({ python_version: ["3.9", "3.14"] }),
      nameFilters: noNameFilterValues(),
      search: "",
    });
  });

  test("falls back to the default for a value the options do not offer", () => {
    expect(
      resolve({
        window: "2d",
        ran_on: "nightly",
        language: "rust",
        os: "plan9",
      })
    ).toEqual(defaultQuery);
    expect(resolve({ language: "python,cpp" }).languages).toEqual(
      defaultQuery.languages
    );
    expect(resolve({ device_count: "3" }).filters.device_count).toEqual([]);
  });

  test("keeps the offered values next to one it drops", () => {
    expect(
      resolve({
        ran_on: "nightly,main",
        language: ["rust", "cpp"],
        accelerator: ["cuda", "tpu"],
      })
    ).toEqual({
      ...defaultQuery,
      ranOn: ["main"],
      languages: ["cpp"],
      filters: filtersWith({ accelerator: ["cuda"] }),
    });
  });

  test("passes an unknown sort through for the API to judge", () => {
    expect(resolve({ sort: "-runs" }).sort).toBe("-runs");
  });

  test("drops every facet when the options predate them, as a cached answer may", () => {
    const { window, ran_on, language } = options;
    const older = { window, ran_on, language } as typeof options;
    expect(
      resolveTestsQuery(
        testsQueryFromUrl({ accelerator: "cuda", test_config: "default" }),
        older
      )
    ).toEqual(defaultQuery);
    expect(testsUrlParams(defaultQuery, older).accelerator).toBeUndefined();
    expect(
      facetsPhrase(
        ENVIRONMENT_COLUMN_FACETS,
        filtersWith({ accelerator: ["cuda"] }),
        older
      )
    ).toBe("cuda");
  });

  test("follows the options' defaults, whatever they are", () => {
    const other = {
      ...options,
      window: { ...options.window, default: "3h" as const },
      ran_on: { ...options.ran_on, default: ["pull_request" as const] },
      language: { ...options.language, default: ["cpp" as const] },
      accelerator: { ...options.accelerator, default: ["cuda"] },
    };
    expect(resolveTestsQuery(testsQueryFromUrl({}), other)).toEqual({
      sort: DEFAULT_TESTS_SORT,
      window: "3h",
      ranOn: ["pull_request"],
      languages: ["cpp"],
      filters: filtersWith({ accelerator: ["cuda"] }),
      nameFilters: noNameFilterValues(),
      search: "",
    });
  });
});

describe("testsUrlParams", () => {
  test("leaves the defaults off", () => {
    expect(testsUrlParams(defaultQuery, options)).toEqual({
      sort: undefined,
      window: undefined,
      ran_on: undefined,
      language: undefined,
      search: undefined,
      ...Object.fromEntries(TESTS_FACETS.map((facet) => [facet, undefined])),
      ...Object.fromEntries(NAME_FILTERS.map((name) => [name, undefined])),
    });
  });

  test("spells each non-default the way the API reads it", () => {
    expect(
      testsUrlParams(
        {
          sort: "-file,-suite,-case_name",
          window: "14d",
          ranOn: ["pull_request", "main"],
          languages: ["unknown", "python"],
          filters: filtersWith({
            accelerator: ["rocm", "cuda"],
            device_count: ["4"],
          }),
          nameFilters: { ...noNameFilterValues(), suite: ["TestTorch"] },
          search: "conv",
        },
        options
      )
    ).toMatchObject({
      sort: "-file,-suite,-case_name",
      window: "14d",
      search: "conv",
      ran_on: "main,pull_request",
      language: ["python", "unknown"],
      accelerator: ["cuda", "rocm"],
      device_count: ["4"],
      device_name: undefined,
      suite: ["TestTorch"],
      file: undefined,
    });
  });

  test("round trips through a URL", () => {
    const query: TestsQuery = {
      sort: "last_run_at",
      window: "3h",
      ranOn: ["pull_request"],
      languages: ["cpp", "unknown"],
      filters: filtersWith({
        accelerator: ["cuda"],
        accelerator_version: ["13.2"],
        device_name: ["NVIDIA L4", "Tesla T4"],
        test_config: ["default"],
      }),
      nameFilters: {
        ...noNameFilterValues(),
        file: ["test/test_torch.py"],
        declared_case_name: ["test_add"],
      },
      search: "Conv Test",
    };
    expect(
      resolveTestsQuery(
        testsQueryFromUrl(testsUrlParams(query, options)),
        options
      )
    ).toEqual(query);
  });

  test("keeps a chosen empty value, which the options offer as none", () => {
    // One empty value is a choice, not the absence of one: it must not be
    // mistaken for the empty default.
    const query = {
      ...defaultQuery,
      filters: filtersWith({ accelerator_version: [""], device_name: [""] }),
    };
    expect(testsUrlParams(query, options)).toMatchObject({
      accelerator_version: [""],
      device_name: [""],
      os: undefined,
    });
    // It comes back from the URL and goes on to the API as written.
    const resolved = resolveTestsQuery(
      testsQueryFromUrl({ accelerator_version: "", device_name: [""] }),
      options
    );
    expect(resolved.filters).toEqual(query.filters);
    const api = new URL(
      testsApiUrl({ repo: "pytorch/pytorch", query: resolved, limit: 25 }),
      "http://hud"
    ).searchParams;
    expect(api.getAll("accelerator_version")).toEqual([""]);
    expect(api.getAll("device_name")).toEqual([""]);
  });
});

describe("testsQueryKey", () => {
  test("tells queries apart and ignores the order of code sources", () => {
    expect(
      testsQueryKey({ ...defaultQuery, ranOn: ["pull_request", "main"] })
    ).toBe(testsQueryKey({ ...defaultQuery, ranOn: ["main", "pull_request"] }));
    expect(testsQueryKey(defaultQuery)).not.toBe(
      testsQueryKey({ ...defaultQuery, languages: ["cpp"] })
    );
    expect(testsQueryKey(defaultQuery)).not.toBe(
      testsQueryKey({ ...defaultQuery, search: "conv" })
    );
  });

  test("tells facet filters apart whatever their order", () => {
    const cuda = {
      ...defaultQuery,
      filters: filtersWith({ accelerator: ["cuda", "rocm"] }),
    };
    expect(testsQueryKey(cuda)).toBe(
      testsQueryKey({
        ...defaultQuery,
        filters: filtersWith({ accelerator: ["rocm", "cuda"] }),
      })
    );
    expect(testsQueryKey(cuda)).not.toBe(testsQueryKey(defaultQuery));
    expect(testsQueryKey(cuda)).not.toBe(
      testsQueryKey({
        ...defaultQuery,
        filters: filtersWith({ os: ["cuda", "rocm"] }),
      })
    );
  });
});

describe("testsApiUrl", () => {
  test("addresses the first page without a cursor, naming its aggregation", () => {
    expect(
      testsApiUrl({
        repo: "pytorch/pytorch",
        query: defaultQuery,
        limit: 25,
      })
    ).toBe(
      "/api/tests?repo=pytorch%2Fpytorch&ran_on=main&window=12h&sort=-status%2C-failure_rate%2C-failed_runs%2C-last_failed_at%2C-skip_rate%2C-mean_passed_duration_milliseconds&limit=25"
    );
  });

  test("addresses a later page by its cursor, with the query's filters", () => {
    const url = testsApiUrl({
      repo: "pytorch/pytorch",
      query: {
        sort: "file,suite,case_name",
        window: "1d",
        ranOn: ["main", "pull_request"],
        languages: ["python", "cpp"],
        filters: filtersWith({
          device_name: ["NVIDIA L4", "Tesla T4"],
          test_config: ["default"],
        }),
        nameFilters: { ...noNameFilterValues(), file: ["test/test_nn.py"] },
        search: "nn",
      },
      limit: 100,
      cursor: "abc+/=",
    });
    const params = new URL(url, "http://hud").searchParams;
    expect(params.get("repo")).toBe("pytorch/pytorch");
    expect(params.get("ran_on")).toBe("main,pull_request");
    expect(params.get("window")).toBe("1d");
    expect(params.get("search")).toBe("nn");
    expect(params.getAll("language")).toEqual(["python", "cpp"]);
    expect(params.getAll("device_name")).toEqual(["NVIDIA L4", "Tesla T4"]);
    expect(params.getAll("test_config")).toEqual(["default"]);
    expect(params.getAll("file")).toEqual(["test/test_nn.py"]);
    expect(params.has("suite")).toBe(false);
    expect(params.has("accelerator")).toBe(false);
    expect(params.get("sort")).toBe("file,suite,case_name");
    expect(params.get("limit")).toBe("100");
    expect(params.get("cursor")).toBe("abc+/=");
  });
});

describe("apiErrorMessage", () => {
  test("prefers the API's error text, then the message", () => {
    expect(
      apiErrorMessage({
        message: "fetch failed",
        info: "repo must be owner/name",
      })
    ).toBe("repo must be owner/name");
    expect(apiErrorMessage(new Error("fetch failed"))).toBe("fetch failed");
    expect(apiErrorMessage("?")).toBe("unknown error");
  });
});

describe("timeAgoLabel", () => {
  const now = dayjs("2026-10-24T12:00:00");
  const at = (time: dayjs.Dayjs) => time.toDate().toISOString();

  test("rounds down to the coarsest whole unit", () => {
    expect(timeAgoLabel(at(now.subtract(20, "second")), now)).toBe("just now");
    expect(timeAgoLabel(at(now.subtract(90, "second")), now)).toBe("1 min ago");
    expect(timeAgoLabel(at(now.subtract(14, "minute")), now)).toBe(
      "14 mins ago"
    );
    expect(timeAgoLabel(at(now.subtract(119, "minute")), now)).toBe(
      "1 hour ago"
    );
    expect(timeAgoLabel(at(now.subtract(5, "hour")), now)).toBe("5 hours ago");
    expect(timeAgoLabel(at(now.subtract(49, "hour")), now)).toBe("2 days ago");
  });

  test("treats an instant from the future as just now", () => {
    expect(timeAgoLabel(at(now.add(3, "minute")), now)).toBe("just now");
  });
});

describe("whenPhrase and lastRunLabel", () => {
  // A Saturday noon, in the viewer's zone.
  const now = dayjs("2026-10-24T12:00:00");
  const at = (time: dayjs.Dayjs) => time.toDate().toISOString();

  test("name the day as a sentence would", () => {
    expect(whenPhrase(at(now.subtract(2, "hour")), now)).toBe(
      "today at 10:00 am"
    );
    expect(whenPhrase(at(now.subtract(3, "day")), now)).toBe(
      "Wednesday at 12:00 pm"
    );
    expect(whenPhrase(at(now.subtract(10, "day")), now)).toBe(
      "Oct 14, 2026 at 12:00 pm"
    );
  });

  test("draw the same line between today, the week and earlier", () => {
    expect(lastRunLabel(at(now.subtract(2, "hour")), now)).toBe(
      "Today 10:00 am"
    );
    // Yesterday through six days ago is the week; a week ago is a date.
    expect(lastRunLabel(at(now.subtract(1, "day")), now)).toBe("Fri 12:00 pm");
    expect(lastRunLabel(at(now.subtract(6, "day")), now)).toBe("Sun 12:00 pm");
    expect(lastRunLabel(at(now.subtract(7, "day")), now)).toBe(
      "Oct 17, 2026 12:00 pm"
    );
    expect(whenPhrase(at(now.subtract(7, "day")), now)).toBe(
      "Oct 17, 2026 at 12:00 pm"
    );
  });
});

describe("the title's phrases", () => {
  test("list items as a sentence does", () => {
    expect(phraseList([])).toBe("");
    expect(phraseList(["Python"])).toBe("Python");
    expect(phraseList(["Python", "C++"])).toBe("Python and C++");
    expect(phraseList(["Python", "C++", "Unknown"])).toBe(
      "Python, C++ and Unknown"
    );
  });

  test("offer alternatives as a sentence does", () => {
    expect(phraseAlternatives([])).toBe("");
    expect(phraseAlternatives(["3.11"])).toBe("3.11");
    expect(phraseAlternatives(["3.11", "3.12"])).toBe("3.11 or 3.12");
    expect(phraseAlternatives(["3.11", "3.12", "3.14t"])).toBe(
      "3.11, 3.12 or 3.14t"
    );
  });

  test("say the code sources in menu order, as the options label them", () => {
    expect(ranOnPhrase(["main"], options)).toBe("main");
    expect(ranOnPhrase(["pull_request", "main"], options)).toBe(
      "main and pull requests"
    );
  });

  test("say all languages when none is chosen", () => {
    expect(languagesPhrase([], options)).toBe("all languages");
    expect(languagesPhrase(["unknown", "python"], options)).toBe(
      "Python and Unknown"
    );
  });

  test("say a header's filter as tokens when a pair is chosen one value each", () => {
    const say = (chosen: Partial<FacetValues>) =>
      facetsPhrase(ENVIRONMENT_COLUMN_FACETS, filtersWith(chosen), options);
    expect(say({})).toBe("");
    expect(say({ accelerator: ["cuda"], accelerator_version: ["13.2"] })).toBe(
      "CUDA 13.2"
    );
    expect(
      say({
        accelerator: ["cuda"],
        accelerator_version: ["13.2"],
        device_name: ["NVIDIA H100 80GB HBM3"],
        device_count: ["4"],
      })
    ).toBe("CUDA 13.2 · NVIDIA H100 80GB HBM3 ×4");
    expect(say({ accelerator: ["cpu"], accelerator_version: [""] })).toBe(
      "CPU"
    );
  });

  test("say the rest as alternatives in the facets' order, titling bare numbers", () => {
    const say = (chosen: Partial<FacetValues>) =>
      facetsPhrase(ENVIRONMENT_COLUMN_FACETS, filtersWith(chosen), options);
    expect(say({ device_name: ["NVIDIA L4", "Tesla T4"] })).toBe(
      "NVIDIA L4 or Tesla T4"
    );
    expect(say({ accelerator_version: ["13.2"] })).toBe(
      "Accelerator version 13.2"
    );
    expect(say({ os: ["linux"], device_count: ["4", "8"] })).toBe(
      "Devices 4 or 8 · Linux"
    );
    // A device clicked in a cell beside an accelerator chosen alone.
    expect(
      say({
        accelerator: ["cuda"],
        device_name: ["NVIDIA L4"],
        device_count: ["1"],
      })
    ).toBe("CUDA · NVIDIA L4");
    expect(say({ python_version: ["3.11", "3.12"] })).toBe(
      "Python 3.11 or 3.12"
    );
    expect(
      say({
        accelerator: ["cuda"],
        accelerator_version: ["13.2"],
        python_version: ["3.11"],
        os: ["linux"],
      })
    ).toBe("CUDA 13.2 · Python 3.11 · Linux");
  });

  test("say the test config and owner columns' filters", () => {
    expect(
      facetsPhrase(
        CONFIG_COLUMN_FACETS,
        filtersWith({ test_config: ["default", "slow"] }),
        options
      )
    ).toBe("default or slow");
    expect(
      facetsPhrase(
        CONFIG_COLUMN_FACETS,
        filtersWith({
          test_config: ["default"],
          workflow_path: [
            ".github/workflows/pull.yml",
            ".github/workflows/trunk.yml",
          ],
        }),
        options
      )
    ).toBe("default · pull.yml or trunk.yml");
    expect(
      facetsPhrase(
        OWNER_COLUMN_FACETS,
        filtersWith({ owner: ["nn", "core_tests"] }),
        options
      )
    ).toBe("nn or core_tests");
  });
});

// The text of each element of some markup, in order, styles left out.
const texts = (markup: string) =>
  [
    ...markup
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "")
      .matchAll(/>([^<]+)</g),
  ].map((match) => match[1]);

describe("the headers' hover help", () => {
  test("name the window in force, and say 'the window' before it is known", () => {
    expect(descriptionsFor("7 days").last_run_at).toBe(
      "When the test most recently ran within the last 7 days."
    );
    expect(descriptionsFor("3 hours").mean_passed_duration_milliseconds).toBe(
      "The average time a successful run of the test takes within the last 3 hours."
    );
    expect(descriptionsFor(undefined).last_run_at).toBe(
      "When the test most recently ran within the window."
    );
    expect(descriptionsFor("7 days").health.split("\n")).toHaveLength(5);
  });
});

describe("the duration cell", () => {
  test("set the mean over its passed runs, plain, and a muted dash when nothing passed", () => {
    const render = (milliseconds: number | null) =>
      renderToStaticMarkup(
        <MeanPassedDuration milliseconds={milliseconds} passedRuns={31} />
      );
    expect(texts(render(25 * 60_000))).toEqual(["25.0 min", "31 passed runs"]);
    expect(texts(render(null))).toEqual(["—", "31 passed runs"]);
    expect(render(25 * 60_000)).not.toContain("background-color:#");
    expect(render(25 * 60_000)).toContain('title="1,500,000 ms"');
  });
});

describe("the duration cell's labels", () => {
  test("group digits in threes with commas, whatever the locale", () => {
    expect(integerLabel(0)).toBe("0");
    expect(integerLabel(625)).toBe("625");
    expect(integerLabel(12695)).toBe("12,695");
    expect(integerLabel(1234567)).toBe("1,234,567");
  });

  test("say a duration in the largest unit it fills", () => {
    expect(durationLabel(0)).toBe("0 ms");
    expect(durationLabel(4)).toBe("4 ms");
    expect(durationLabel(625)).toBe("625 ms");
    expect(durationLabel(999)).toBe("999 ms");
    expect(durationLabel(1000)).toBe("1.0 s");
    expect(durationLabel(12695)).toBe("12.7 s");
    expect(durationLabel(59949)).toBe("59.9 s");
    expect(durationLabel(125000)).toBe("2.1 min");
    expect(durationLabel(1939503)).toBe("32.3 min");
    expect(durationLabel(3596999)).toBe("59.9 min");
    expect(durationLabel(5400000)).toBe("1.5 h");
    expect(durationLabel(90000000)).toBe("25.0 h");
  });

  test("round up into the next unit rather than saying 60.0 of this one", () => {
    expect(durationLabel(59950)).toBe("1.0 min");
    expect(durationLabel(3599999)).toBe("1.0 h");
  });

  test("count the passed runs in the singular or the plural", () => {
    expect(passedRunsLabel(0)).toBe("0 passed runs");
    expect(passedRunsLabel(1)).toBe("1 passed run");
    expect(passedRunsLabel(8)).toBe("8 passed runs");
    expect(passedRunsLabel(1234)).toBe("1,234 passed runs");
  });
});

describe("MeanPassedDuration", () => {
  test("sets the mean over its count of passed runs", () => {
    const markup = renderToStaticMarkup(
      <MeanPassedDuration milliseconds={12695} passedRuns={8} />
    );
    expect(texts(markup)).toEqual(["12.7 s", "8 passed runs"]);
    expect(markup).toContain('title="12,695 ms"');
  });

  test("leads to the runs it averages when it has somewhere to lead", () => {
    const href = "/tests/pytorch/pytorch/test/42?window=12h";
    const markup = renderToStaticMarkup(
      <MeanPassedDuration milliseconds={12695} passedRuns={8} href={href} />
    );
    expect(markup).toMatch(/<a [^>]*>12\.7 s<\/a>/);
    expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain("color:var(--link-color)");
    // A dash leads nowhere.
    expect(
      renderToStaticMarkup(
        <MeanPassedDuration milliseconds={null} passedRuns={0} href={href} />
      )
    ).not.toContain("<a ");
  });

  test("shows a dash and no tooltip when nothing passed", () => {
    const markup = renderToStaticMarkup(
      <MeanPassedDuration milliseconds={null} passedRuns={0} />
    );
    expect(texts(markup)).toEqual(["—", "0 passed runs"]);
    expect(markup).not.toContain("title=");
  });
});

describe("health", () => {
  // Health counts with the given ones set and the rest zero, the rates and
  // the status as the API derives them.
  const counts = (over: Partial<HealthCounts>): HealthCounts => {
    const full = {
      runs: 0,
      passed_runs: 0,
      failed_runs: 0,
      flaky_runs: 0,
      skipped_runs: 0,
      attempts: 0,
      ...over,
    };
    const ratio = (part: number, whole: number) =>
      whole === 0 ? null : part / whole;
    const status: HealthCounts["status"] =
      full.runs === 0
        ? "skipped"
        : full.failed_runs > full.flaky_runs
        ? "failing"
        : full.failed_runs > 0
        ? "flaky"
        : "healthy";
    return {
      status,
      ...full,
      pass_rate: ratio(full.passed_runs, full.runs),
      failure_rate: ratio(full.failed_runs, full.runs),
      flaky_rate: ratio(full.flaky_runs, full.runs),
      skip_rate: ratio(full.skipped_runs, full.runs + full.skipped_runs),
    };
  };
  const failing = counts({
    runs: 39,
    passed_runs: 3,
    failed_runs: 36,
    flaky_runs: 30,
    skipped_runs: 124,
    attempts: 75,
  });
  const flaky = counts({
    runs: 31,
    failed_runs: 31,
    flaky_runs: 31,
    attempts: 93,
  });
  const healthy = counts({ runs: 155, passed_runs: 155, attempts: 155 });
  const skipped = counts({ skipped_runs: 62 });

  test("says the status as the options label it, first letter raised", () => {
    expect(statusLabel("failing", options)).toBe("Failing");
    expect(statusLabel("skipped", options)).toBe("Skipped");
    // Without the options, the API's spelling, its first letter raised.
    expect(statusLabel("flaky", undefined)).toBe("Flaky");
    expect(statusLabel("healthy", {})).toBe("Healthy");
  });

  test("sets rates with the precision the column has room for", () => {
    expect(rateLabel(0)).toBe("0%");
    expect(rateLabel(1)).toBe("100%");
    expect(rateLabel(36 / 39)).toBe("92%");
    expect(rateLabel(0.0995)).toBe("10%");
    expect(rateLabel(0.0994)).toBe("9.9%");
    expect(rateLabel(1 / 31)).toBe("3.2%");
    expect(rateLabel(0.001)).toBe("0.1%");
    expect(rateLabel(0.0004)).toBe("<0.1%");
  });

  test("sets the failure rate beside the word only when there is one to tell", () => {
    expect(healthRate(failing)).toBe("92%");
    expect(healthRate(flaky)).toBe("100%");
    expect(healthRate(healthy)).toBeNull();
    expect(healthRate(skipped)).toBeNull();
  });

  test("details the counts behind the word, only those with something to say", () => {
    expect(healthDetails(failing)).toEqual([
      "36 of 39 runs",
      "30 flaky",
      "124 skipped",
    ]);
    // Every failing run of a flaky test is flaky; the word says so.
    expect(healthDetails(flaky)).toEqual(["31 of 31 runs"]);
    expect(healthDetails(healthy)).toEqual(["155 runs"]);
    expect(healthDetails(counts({ runs: 1, passed_runs: 1 }))).toEqual([
      "1 run",
    ]);
    expect(
      healthDetails(counts({ runs: 1, failed_runs: 1, skipped_runs: 62 }))
    ).toEqual(["1 of 1 run", "62 skipped"]);
    expect(healthDetails(skipped)).toEqual(["0 runs", "62 skipped"]);
  });

  test("lists every count and rate for the tooltip", () => {
    expect(healthFacts(failing)).toEqual([
      { name: "Runs", value: "39" },
      { name: "Passed first time", value: "3" },
      { name: "Failed", value: "36" },
      { name: "Flaky", value: "30" },
      { name: "Skipped", value: "124" },
      { name: "Attempts", value: "75" },
      { name: "Failure rate", value: "92.3%" },
      { name: "Flaky rate", value: "76.9%" },
      { name: "Skip rate", value: "76.1%" },
      { name: "Pass rate", value: "7.7%" },
    ]);
    expect(healthFacts(skipped).map((fact) => fact.value)).toEqual([
      "0",
      "0",
      "0",
      "0",
      "62",
      "0",
      "—",
      "—",
      "100.0%",
      "—",
    ]);
    // Runs with another outcome than passed or failed are counted when
    // there are any.
    expect(
      healthFacts(counts({ runs: 10, passed_runs: 7, failed_runs: 1 }))
    ).toContainEqual({ name: "Other outcome", value: "2" });
  });

  test("renders the word, the rate and the counts, and leads to the runs", () => {
    const href = "/tests/pytorch/pytorch/test/42?window=12h";
    const render = (health: HealthCounts) =>
      renderToStaticMarkup(
        <Health health={health} options={options} href={href} />
      );
    const markup = render(failing);
    expect(texts(markup)).toEqual([
      "Failing",
      "92%",
      "36 of 39 runs",
      "·",
      "30 flaky",
      "·",
      "124 skipped",
    ]);
    // The block is a link to the test's runs, not draggable, so a drag
    // across it selects its text.
    expect(markup).toContain(`<a `);
    expect(markup).toContain(`href="${href}"`);
    expect(markup).toContain('draggable="false"');
    expect(markup).not.toContain('role="button"');
    expect(markup).toContain("background-color:#ffebe9");
    // Skipped has a block of its own, purple, and no rate.
    const skippedMarkup = render(skipped);
    expect(texts(skippedMarkup)).toEqual([
      "Skipped",
      "0 runs",
      "·",
      "62 skipped",
    ]);
    expect(skippedMarkup).toContain("background-color:#fbefff");
    // The block names its hue's ink for the table's link rule.
    expect(markup).toContain("--cell-link-color:#");
    // Healthy is plain text in the same frame, the word the link, in the
    // muted tone of the text around it rather than the link blue.
    const plain = render(healthy);
    expect(texts(plain)).toEqual(["Healthy", "155 runs"]);
    expect(plain).toMatch(/<a [^>]*>Healthy<\/a>/);
    expect(plain).toContain("--cell-link-color:currentColor");
    expect(plain).not.toContain("color:var(--link-color)");
    expect(plain).not.toContain("background-color:#");
    // With nowhere to lead yet, nothing is a link.
    expect(
      renderToStaticMarkup(<Health health={failing} options={options} />)
    ).not.toContain("<a ");
  });
});

describe("TestName", () => {
  // The texts of some markup with its break opportunities taken out, so each
  // part reads whole.
  const unbroken = (markup: string) => texts(markup.replace(/<wbr\/>/g, ""));
  const named = {
    file: "test/test_torch.py",
    suite: "TestTorch",
    case_name: "test_add_cpu_float32",
  };

  test("sets the case name over the file and suite, titled as a pytest node id", () => {
    const markup = renderToStaticMarkup(<TestName test={named} />);
    expect(unbroken(markup)).toEqual([
      "test_add_cpu_float32",
      "test/test_torch.py",
      "::",
      "TestTorch",
    ]);
    expect(markup).toContain(
      'title="test/test_torch.py::TestTorch::test_add_cpu_float32"'
    );
  });

  test("leaves out the suite of a module-level function", () => {
    const test = { file: "test/test_ops.py", suite: "", case_name: "test_x" };
    expect(testNameParts(test)).toEqual(["test/test_ops.py", "test_x"]);
    expect(unbroken(renderToStaticMarkup(<TestName test={test} />))).toEqual([
      "test_x",
      "test/test_ops.py",
    ]);
  });

  test("keeps the last part it has as the headline when the case name is empty", () => {
    const test = { file: "cpp/test_api", suite: "", case_name: "" };
    expect(unbroken(renderToStaticMarkup(<TestName test={test} />))).toEqual([
      "cpp/test_api",
    ]);
  });

  test("cuts a part into pieces after each underscore and slash", () => {
    expect(breakPieces("test/test_torch.py")).toEqual([
      "test/",
      "test_",
      "torch.py",
    ]);
    expect(breakPieces("test_add_cpu_float32")).toEqual([
      "test_",
      "add_",
      "cpu_",
      "float32",
    ]);
    expect(breakPieces("TestTorch")).toEqual(["TestTorch"]);
    expect(breakPieces("a__b/")).toEqual(["a_", "_", "b/"]);
    expect(breakPieces("")).toEqual([]);
  });

  test("lets a line break after a separator or a joint, and cuts nothing off", () => {
    const markup = renderToStaticMarkup(
      <TestName test={named} onSearch={() => {}} />
    );
    // A break opportunity between the case name's pieces; the file and the
    // suite are each one text node, so Chrome can select them (TestName).
    expect(markup).toContain("test_<wbr/>add_<wbr/>cpu_<wbr/>float32");
    expect(markup).toContain(">test/test_torch.py</span>");
    expect(markup).not.toContain("test/<wbr/>");
    // One after each separator, none before it.
    expect(markup).toContain("::</span><wbr/>");
    expect(markup).not.toMatch(/<wbr\/><span[^>]*>::/);
    // The styles wrap a long line rather than cutting it off.
    expect(markup).toContain("overflow-wrap:anywhere");
    expect(markup).not.toContain("ellipsis");
    expect(markup).not.toContain("nowrap");
    // The searches are spans with the button role, which run on over lines
    // as text does; a <button> is one box.
    expect(markup).toContain('role="button"');
    expect(markup).not.toContain("<button");
  });

  test("is a link to the test's page when it has one, the case name alone", () => {
    const markup = renderToStaticMarkup(
      <TestName
        test={named}
        href="/tests/pytorch/pytorch/test/42"
        onSearch={() => {}}
      />
    );
    expect(markup.match(/<a /g)).toHaveLength(1);
    // The link holds the case name with its break opportunities, and is not
    // draggable, so a drag across it selects the name; the file and the
    // suite stay searches.
    expect(markup).toMatch(
      /<a [^>]*draggable="false"[^>]*href="\/tests\/pytorch\/pytorch\/test\/42"[^>]*>test_<wbr\/>add_<wbr\/>cpu_<wbr\/>float32<\/a>/
    );
    expect(markup).toContain('aria-label="Search for test/test_torch.py"');
    // In HUD's link blue, so the name reads as the link it is.
    expect(markup).toContain("color:var(--link-color)");
    expect(renderToStaticMarkup(<TestName test={named} />)).not.toContain(
      "<a "
    );
  });

  test("keeps its text selectable, to copy", () => {
    const markup = renderToStaticMarkup(
      <TestName test={named} onSearch={() => {}} />
    );
    // ButtonBase's own user-select: none comes first in its class; the
    // override after it wins.
    expect(markup.lastIndexOf("user-select:text")).toBeGreaterThan(
      markup.lastIndexOf("user-select:none")
    );
  });
});

const gpuEnvironment: EnvironmentRecord = {
  id: "2081130751942693630",
  os: "linux",
  os_version: "22.04",
  cpu_architecture: "x86_64",
  cpu_capability: "avx2",
  python_version: "3.11",
  cc_compiler: "gcc",
  cc_compiler_version: "11.4",
  accelerator: "cuda",
  accelerator_version: "13.2",
  device_name: "NVIDIA H100 80GB HBM3",
  device_count: 4,
  first_seen_at: "2026-10-13T19:31:24.819Z",
};
const cpuEnvironment: EnvironmentRecord = {
  ...gpuEnvironment,
  id: "1",
  cpu_capability: "avx512",
  python_version: "3.14t",
  cc_compiler: "clang",
  cc_compiler_version: "21.1.8",
  accelerator: "cpu",
  accelerator_version: "",
  device_name: "",
  device_count: 0,
};
const tokenTexts = (tokens: { text: string }[]) =>
  tokens.map((token) => token.text);

describe("pairText", () => {
  test("joins a thing and its version, leaving an empty half out", () => {
    expect(
      pairText(["accelerator", "accelerator_version"], "CUDA", "13.2")
    ).toBe("CUDA 13.2");
    expect(pairText(["accelerator", "accelerator_version"], "CPU", "")).toBe(
      "CPU"
    );
    expect(pairText(["os", "os_version"], "", "22.04")).toBe("22.04");
  });

  test("counts a device only when there are several, and alone when unnamed", () => {
    expect(pairText(["device_name", "device_count"], "NVIDIA L4", "1")).toBe(
      "NVIDIA L4"
    );
    expect(pairText(["device_name", "device_count"], "NVIDIA L4", "4")).toBe(
      "NVIDIA L4 ×4"
    );
    expect(pairText(["device_name", "device_count"], "", "1")).toBe("1 device");
    expect(pairText(["device_name", "device_count"], "", "4")).toBe(
      "4 devices"
    );
    expect(pairText(["device_name", "device_count"], "", "0")).toBe("");
  });
});

describe("environmentTokens", () => {
  test("set the build and device full strength over the interpreter and platform", () => {
    const { primary, secondary } = environmentTokens(gpuEnvironment, options);
    expect(tokenTexts(primary)).toEqual([
      "CUDA 13.2",
      "NVIDIA H100 80GB HBM3 ×4",
    ]);
    expect(tokenTexts(secondary)).toEqual([
      "Python 3.11",
      "Linux 22.04",
      "x86_64 avx2",
      "GCC 11.4",
    ]);
  });

  test("stand for the facet values of both halves", () => {
    const { primary, secondary } = environmentTokens(gpuEnvironment, options);
    expect(primary[0].filters).toEqual({
      accelerator: "cuda",
      accelerator_version: "13.2",
    });
    expect(primary[1].filters).toEqual({
      device_name: "NVIDIA H100 80GB HBM3",
      device_count: "4",
    });
    expect(secondary.map((token) => token.filters)).toEqual([
      { python_version: "3.11" },
      { os: "linux", os_version: "22.04" },
      { cpu_architecture: "x86_64", cpu_capability: "avx2" },
      { cc_compiler: "gcc", cc_compiler_version: "11.4" },
    ]);
  });

  test("give a CPU build no device token", () => {
    const { primary, secondary } = environmentTokens(cpuEnvironment, options);
    expect(tokenTexts(primary)).toEqual(["CPU"]);
    expect(primary[0].filters).toEqual({
      accelerator: "cpu",
      accelerator_version: "",
    });
    expect(tokenTexts(secondary)).toEqual([
      "Python 3.14t",
      "Linux 22.04",
      "x86_64 avx512",
      "Clang 21.1.8",
    ]);
  });

  test("fall back to the catalog's spelling without the options", () => {
    const { primary, secondary } = environmentTokens(gpuEnvironment, undefined);
    expect(tokenTexts(primary)[0]).toBe("cuda 13.2");
    expect(tokenTexts(secondary)).toEqual([
      "Python 3.11",
      "linux 22.04",
      "x86_64 avx2",
      "gcc 11.4",
    ]);
  });
});

describe("environmentDetails", () => {
  test("title every field, with a dash for an empty one", () => {
    const details = environmentDetails(cpuEnvironment);
    expect(details).toHaveLength(11);
    expect(details.map((detail) => detail.name)).toEqual([
      "Accelerator",
      "Accelerator version",
      "Device",
      "Devices",
      "Python",
      "OS",
      "OS version",
      "CPU architecture",
      "CPU capability",
      "Compiler",
      "Compiler version",
    ]);
    expect(details.map((detail) => detail.value)).toEqual([
      "cpu",
      "—",
      "—",
      "0",
      "3.14t",
      "linux",
      "22.04",
      "x86_64",
      "avx512",
      "clang",
      "21.1.8",
    ]);
  });
});

const envVars: EnvVarsRecord = {
  id: "1688593832548410197",
  values: {
    TEST_CONFIG: "slow",
    PYTORCH_TEST_WITH_SLOW: "1",
    PYTORCH_TEST_SKIP_FAST: "1",
  },
  first_seen_at: "2026-10-13T19:03:23.252Z",
};

describe("the config token and variable lines", () => {
  test("read the config out of the set and filter by it", () => {
    expect(configToken(envVars)).toEqual({
      text: "slow",
      filters: { test_config: "slow" },
    });
    expect(configToken({ ...envVars, values: {} })).toBeNull();
  });

  test("name a workflow by its file and filter by its path", () => {
    expect(workflowName(".github/workflows/pull.yml")).toBe("pull.yml");
    expect(workflowName(".github/workflows/rocm-mi300.yaml")).toBe(
      "rocm-mi300.yaml"
    );
    expect(workflowName("reusable/_linux-test.yaml")).toBe(
      "reusable/_linux-test.yaml"
    );
    expect(
      workflowTokens([
        ".github/workflows/pull.yml",
        "reusable/_linux-test.yaml",
      ])
    ).toEqual([
      {
        text: "pull.yml",
        filters: { workflow_path: ".github/workflows/pull.yml" },
        tooltip: ".github/workflows/pull.yml",
      },
      {
        text: "reusable/_linux-test.yaml",
        filters: { workflow_path: "reusable/_linux-test.yaml" },
        tooltip: "reusable/_linux-test.yaml",
      },
    ]);
  });

  test("show the workflows that fit the line and count the rest", () => {
    const tokens = (names: string[]) =>
      workflowTokens(names.map((name) => `.github/workflows/${name}.yml`));
    const texts = (list: { text: string }[]) => list.map((t) => t.text);
    const fit = (list: readonly Token[]) =>
      fitTokens(list, WORKFLOW_LINE_BUDGET);
    const two = fit(tokens(["periodic", "trunk"]));
    expect(texts(two.shown)).toEqual(["periodic.yml", "trunk.yml"]);
    expect(two.hidden).toEqual([]);
    const long = fit(
      tokens(["inductor-rocm-mi300", "periodic-rocm-mi350", "pull"])
    );
    expect(texts(long.shown)).toEqual(["inductor-rocm-mi300.yml"]);
    expect(texts(long.hidden)).toEqual(["periodic-rocm-mi350.yml", "pull.yml"]);
    // The first always shows, however long.
    expect(
      texts(fit(tokens(["a-very-long-workflow-name-indeed"])).shown)
    ).toEqual(["a-very-long-workflow-name-indeed.yml"]);
    expect(fit([])).toEqual({ shown: [], hidden: [] });
  });

  test("make each owner label a token that filters by itself", () => {
    expect(ownerTokens(["nn", "linear algebra"])).toEqual([
      { text: "nn", filters: { owner: "nn" } },
      { text: "linear algebra", filters: { owner: "linear algebra" } },
    ]);
    const fit = fitTokens(
      ownerTokens(["higher order operators", "nn"]),
      OWNER_LINE_BUDGET
    );
    expect(fit.shown.map((t) => t.text)).toEqual(["higher order operators"]);
    expect(fit.hidden.map((t) => t.text)).toEqual(["nn"]);
  });

  test("list the variables with the config first, then by name, the config left out when asked", () => {
    expect(variableLines(envVars)).toEqual([
      "TEST_CONFIG=slow",
      "PYTORCH_TEST_SKIP_FAST=1",
      "PYTORCH_TEST_WITH_SLOW=1",
    ]);
    expect(variableLines(envVars, { withoutConfig: true })).toEqual([
      "PYTORCH_TEST_SKIP_FAST=1",
      "PYTORCH_TEST_WITH_SLOW=1",
    ]);
  });
});

describe("Environment", () => {
  const noop = () => {};

  test("sets the tokens on two lines with middle dots between them", () => {
    const markup = renderToStaticMarkup(
      <Environment
        environment={gpuEnvironment}
        options={options}
        onFilter={noop}
      />
    );
    expect(texts(markup)).toEqual([
      "CUDA 13.2",
      "·",
      "NVIDIA H100 80GB HBM3 ×4",
      "Python 3.11",
      "·",
      "Linux 22.04",
      "·",
      "x86_64 avx2",
      "·",
      "GCC 11.4",
    ]);
  });

  test("makes each token a button that says what it narrows to", () => {
    const markup = renderToStaticMarkup(
      <Environment
        environment={cpuEnvironment}
        options={options}
        onFilter={noop}
      />
    );
    expect(markup).toContain('aria-label="Only CPU"');
    expect(markup).toContain('aria-label="Only Python 3.14t"');
    expect(markup).toContain('aria-label="Only Clang 21.1.8"');
    // Spans with the button role, whose text can be selected; a <button>'s
    // cannot be in every browser.
    expect(markup.match(/role="button"/g)).toHaveLength(5);
    expect(markup).not.toContain("<button");
  });

  test("says when the environment is unknown", () => {
    const markup = renderToStaticMarkup(
      <Environment environment={null} options={options} onFilter={noop} />
    );
    expect(texts(markup)).toEqual(["unknown environment"]);
    expect(markup).not.toContain('role="button"');
  });
});

describe("HeaderFilter", () => {
  const noop = () => {};
  const sections = ENVIRONMENT_COLUMN_FACETS.map((facet) => ({
    facet,
    title: FACET_TITLES[facet],
    options: options[facet].values,
  }));

  test("offers to filter the column while nothing is chosen", () => {
    const markup = renderToStaticMarkup(
      <HeaderFilter
        column="environment"
        summary=""
        anyLabel="Any environment"
        sections={sections}
        value={noFacetValues()}
        onChange={noop}
      />
    );
    expect(markup).toContain('aria-label="Filter environment"');
    expect(markup).toContain('aria-haspopup="menu"');
    expect(markup).toContain("FilterAltOutlinedIcon");
  });

  test("says what the column is filtered by once something is chosen", () => {
    const markup = renderToStaticMarkup(
      <HeaderFilter
        column="environment"
        summary="CUDA 13.2 · Python 3.11"
        anyLabel="Any environment"
        sections={sections}
        value={filtersWith({
          accelerator: ["cuda"],
          accelerator_version: ["13.2"],
          python_version: ["3.11"],
        })}
        onChange={noop}
      />
    );
    expect(markup).toContain(
      'aria-label="Filtering environment by CUDA 13.2 · Python 3.11"'
    );
    expect(markup).toContain("FilterAltIcon");
  });

  test("keeps its clicks and keystrokes from the header around it", () => {
    // The grid sorts the column on a click or an Enter that reaches the
    // header, so the key stops both before they get there.
    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(
        <HeaderFilter
          column="environment"
          summary=""
          anyLabel="Any environment"
          sections={sections}
          value={noFacetValues()}
          onChange={noop}
        />
      );
    });
    const key = renderer!.root.findByType("button");
    const press = (type: "onKeyDown" | "onClick", eventKey?: string) => {
      const event = {
        key: eventKey,
        target: null,
        currentTarget: null,
        stopPropagation: jest.fn(),
        preventDefault: jest.fn(),
      };
      act(() => key.props[type](event));
      return event.stopPropagation;
    };
    expect(press("onKeyDown", "Enter")).toHaveBeenCalled();
    expect(press("onKeyDown", " ")).toHaveBeenCalled();
    expect(press("onKeyDown", "ArrowRight")).toHaveBeenCalled();
    expect(press("onClick")).toHaveBeenCalled();
  });
});

describe("Owners", () => {
  const noop = () => {};

  test("sets each label as a filtering token", () => {
    const markup = renderToStaticMarkup(
      <Owners owners={["nn", "autograd"]} onFilter={noop} />
    );
    expect(texts(markup)).toEqual(["nn", "·", "autograd"]);
    expect(markup).toContain('aria-label="Only nn"');
    expect(markup).toContain('aria-label="Only autograd"');
  });

  test("counts the labels the line cannot hold and shows a dash for none", () => {
    expect(
      texts(
        renderToStaticMarkup(
          <Owners owners={["higher order operators", "nn"]} onFilter={noop} />
        )
      )
    ).toEqual(["higher order operators", "+1"]);
    expect(
      texts(renderToStaticMarkup(<Owners owners={[]} onFilter={noop} />))
    ).toEqual(["—"]);
  });
});

describe("Config", () => {
  const noop = () => {};
  const workflows = [
    ".github/workflows/pull.yml",
    ".github/workflows/trunk.yml",
  ];
  const render = (vars: EnvVarsRecord | null, paths: string[]) =>
    renderToStaticMarkup(
      <Config envVars={vars} workflowPaths={paths} onFilter={noop} />
    );

  test("sets the config with its badge over the workflows that called it", () => {
    const markup = render(envVars, workflows);
    expect(texts(markup)).toEqual(["slow", "+2", "pull.yml", "·", "trunk.yml"]);
    expect(markup).toContain('aria-label="Only slow"');
    expect(markup).toContain('aria-label="2 more variables"');
    // A workflow's name is short for its path, which the token also says.
    expect(markup).toContain(
      'aria-label="Only pull.yml, .github/workflows/pull.yml"'
    );
    expect(markup).not.toContain("repro_env_vars");
  });

  test("counts the workflows the line cannot hold", () => {
    const markup = render({ ...envVars, values: { TEST_CONFIG: "default" } }, [
      ".github/workflows/inductor-rocm-mi300.yml",
      ".github/workflows/periodic-rocm-mi350.yml",
    ]);
    expect(texts(markup)).toEqual(["default", "inductor-rocm-mi300.yml", "+1"]);
    expect(markup).toContain('aria-label="1 more workflow"');
  });

  test("shows a dash without a config and nothing beneath without workflows", () => {
    expect(
      texts(
        render(
          { ...envVars, values: { PYTORCH_TEST_WITH_SLOW: "1" } },
          workflows
        )
      )
    ).toEqual(["—", "+1", "pull.yml", "·", "trunk.yml"]);
    expect(
      texts(render({ ...envVars, values: { TEST_CONFIG: "default" } }, []))
    ).toEqual(["default"]);
    expect(texts(render(null, []))).toEqual(["unknown"]);
  });
});

describe("TestName searches", () => {
  const named = {
    file: "test/test_torch.py",
    suite: "TestTorch",
    case_name: "test_add",
  };

  test("offers the file and the suite as searches when it can search", () => {
    const markup = renderToStaticMarkup(
      <TestName test={named} onSearch={() => {}} />
    );
    expect(markup).toContain('aria-label="Search for test/test_torch.py"');
    expect(markup).toContain('aria-label="Search for TestTorch"');
    expect(markup).not.toContain('aria-label="Search for test_add"');
  });

  test("is plain text when it cannot", () => {
    expect(renderToStaticMarkup(<TestName test={named} />)).not.toContain(
      'role="button"'
    );
  });
});

describe("text that acts stays selectable", () => {
  // A selection that holds the given nodes, or none.
  const selectionOf = (...nodes: object[]) => ({
    isCollapsed: nodes.length === 0,
    containsNode: (node: Node) => nodes.includes(node),
  });
  const element = {};
  const click = (detail = 1) => ({
    type: "click",
    detail,
    currentTarget: element as EventTarget,
  });

  test("a click that ends a drag selecting the element's text acts not", () => {
    expect(endsTextSelection(click(), selectionOf(element))).toBe(true);
  });

  test("a plain click acts, and so does one with a selection elsewhere", () => {
    expect(endsTextSelection(click(), selectionOf())).toBe(false);
    expect(endsTextSelection(click(), selectionOf({}))).toBe(false);
    expect(endsTextSelection(click(), null)).toBe(false);
    expect(
      endsTextSelection(
        { ...click(), currentTarget: null },
        selectionOf(element)
      )
    ).toBe(false);
  });

  test("Enter and Space act whatever is selected", () => {
    // A <button>'s click from the keyboard counts no clicks.
    expect(endsTextSelection(click(0), selectionOf(element))).toBe(false);
    // ButtonBase hands a span's keyboard activation on as the key event.
    expect(
      endsTextSelection(
        { type: "keydown", detail: 0, currentTarget: element as EventTarget },
        selectionOf(element)
      )
    ).toBe(false);
  });

  // The components read the document's selection; here the document is
  // stood in for.
  const withSelection = async (
    selection: ReturnType<typeof selectionOf> | null,
    run: () => void | Promise<void>
  ) => {
    const globals = globalThis as { window?: unknown };
    globals.window = { getSelection: () => selection };
    try {
      await run();
    } finally {
      delete globals.window;
    }
  };

  test("TextButton skips the click that ends a selection", async () => {
    const onClick = jest.fn();
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <TextButton label="Only CPU" onClick={onClick}>
          CPU
        </TextButton>
      );
    });
    const button = renderer!.root.find(
      (node) => node.type === "span" && node.props?.role === "button"
    );
    const press = (
      selection: ReturnType<typeof selectionOf> | null,
      target: object
    ) => {
      const stopPropagation = jest.fn();
      return withSelection(selection, () => {
        act(() => {
          button.props.onClick({
            type: "click",
            detail: 1,
            currentTarget: target,
            stopPropagation,
          });
        });
        expect(stopPropagation).toHaveBeenCalled();
      });
    };
    // Plain clicks act.
    await press(selectionOf(), {});
    await press(null, {});
    expect(onClick).toHaveBeenCalledTimes(2);
    // A click ending a selection of its own text does not.
    const selected = {};
    await press(selectionOf(selected), selected);
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test("a link, text or block, skips the click that ends a selection of its text", async () => {
    // Next's link schedules its prefetch check through `self`, which the
    // browser has and this environment does not.
    const globals = globalThis as { self?: unknown };
    globals.self = globalThis;
    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <>
          <TextLink href="/tests/pytorch/pytorch/test/42">test_add</TextLink>
          <CellBlock
            hue="red"
            href="/tests/pytorch/pytorch/test/42?window=12h"
            lead="Failing"
            caption="2 of 2 runs"
          />
        </>
      );
    });
    // The handlers sit on the Next links, which follow a click unless it
    // was prevented; neither link is draggable, so a drag across it selects.
    const links = renderer!.root.findAllByType(NextLink);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.props.draggable === false)).toBe(true);
    const click = async (
      selection: ReturnType<typeof selectionOf> | null,
      target: object
    ) => {
      const preventDefault = jest.fn();
      await withSelection(selection, () => {
        act(() => {
          for (const link of links) {
            link.props.onClick({
              type: "click",
              detail: 1,
              currentTarget: target,
              preventDefault,
            });
          }
        });
      });
      return preventDefault.mock.calls.length;
    };
    const target = {};
    // Plain clicks are followed, and so is one with a selection elsewhere.
    expect(await click(selectionOf(), target)).toBe(0);
    expect(await click(null, target)).toBe(0);
    expect(await click(selectionOf({}), target)).toBe(0);
    // A click ending a selection of the link's own text goes nowhere.
    expect(await click(selectionOf(target), target)).toBe(2);
    await act(async () => {
      renderer.unmount();
    });
    delete globals.self;
  });
});

describe("NameSearch", () => {
  test("names itself and shows the text with a clear button", () => {
    const markup = renderToStaticMarkup(
      <NameSearch value="conv" onChange={() => {}} onSubmit={() => {}} />
    );
    expect(markup).toContain('aria-label="Search names"');
    expect(markup).toContain('value="conv"');
    expect(markup).toContain('placeholder="Search names"');
    expect(markup).toContain('maxLength="200"');
    expect(markup).toContain('aria-label="Clear search"');
  });

  test("has no clear button while empty", () => {
    expect(
      renderToStaticMarkup(
        <NameSearch value="" onChange={() => {}} onSubmit={() => {}} />
      )
    ).not.toContain("Clear search");
  });

  test("shows the URL's exact name filters as chips, each with its remove button", () => {
    const markup = renderToStaticMarkup(
      <NameSearch
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        filters={{
          ...noNameFilterValues(),
          file: ["test/test_torch.py"],
          case_name: ["test_add", "test_sub"],
        }}
        onRemoveFilter={() => {}}
      />
    );
    expect(markup).toContain('title="File: test/test_torch.py"');
    expect(markup).toContain('title="Case name: test_add"');
    expect(markup).toContain('title="Case name: test_sub"');
    expect(markup).toContain(
      'aria-label="Remove file filter test/test_torch.py"'
    );
    expect(markup).toContain('aria-label="Remove case name filter test_sub"');
    expect(markup).not.toContain("Remove suite filter");
    // The field still searches beside the chips.
    expect(markup).toContain('placeholder="Search names"');
  });

  test("a chip's remove button names its filter and value", async () => {
    const onRemoveFilter = jest.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <NameSearch
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          filters={{ ...noNameFilterValues(), suite: ["TestTorch"] }}
          onRemoveFilter={onRemoveFilter}
        />
      );
    });
    const button = renderer!.root.findByProps({
      "aria-label": "Remove suite filter TestTorch",
    });
    await act(async () => {
      button.props.onClick();
    });
    expect(onRemoveFilter).toHaveBeenCalledWith("suite", "TestTorch");
    await act(async () => {
      renderer!.unmount();
    });
  });

  test("grows the header band by what the field reports, never shrinks it", () => {
    expect(columnHeaderHeightFor(0)).toBe(COLUMN_HEADER_HEIGHT);
    expect(columnHeaderHeightFor(NAME_FILTER_ROW_HEIGHT)).toBe(
      COLUMN_HEADER_HEIGHT + NAME_FILTER_ROW_HEIGHT
    );
    expect(columnHeaderHeightFor(2 * NAME_FILTER_ROW_HEIGHT)).toBe(
      COLUMN_HEADER_HEIGHT + 2 * NAME_FILTER_ROW_HEIGHT
    );
    expect(columnHeaderHeightFor(-3)).toBe(COLUMN_HEADER_HEIGHT);
  });

  test("reports no extra height while there are no chips", async () => {
    const onExtraHeightChange = jest.fn();
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <NameSearch
          value=""
          onChange={() => {}}
          onSubmit={() => {}}
          filters={noNameFilterValues()}
          onExtraHeightChange={onExtraHeightChange}
        />
      );
    });
    expect(onExtraHeightChange).toHaveBeenCalledWith(0);
    await act(async () => {
      renderer!.unmount();
    });
  });

  test("shows no chips without filters", () => {
    const markup = renderToStaticMarkup(
      <NameSearch
        value=""
        onChange={() => {}}
        onSubmit={() => {}}
        filters={noNameFilterValues()}
      />
    );
    expect(markup).not.toContain("Remove ");
    expect(markup).not.toContain('title="File');
  });
});

// A URL query the page could not have written is still resolved, never
// rejected: the type says so.
const _unchecked: TestsUrlQuery = testsQueryFromUrl({ window: "anything" });

describe("accessReasonOf", () => {
  const failed = (status: number) =>
    Object.assign(new Error("An error occurred while fetching the data"), {
      status,
    });

  test("a 401 asks a signed-out reader to sign in", () => {
    expect(accessReasonOf(failed(401), false)).toBe("signed_out");
  });

  test("a 401 tells a signed-in reader the sign-in stopped working", () => {
    expect(accessReasonOf(failed(401), true)).toBe("expired");
  });

  test("a 403 is the account's access, signed in or not", () => {
    expect(accessReasonOf(failed(403), true)).toBe("forbidden");
    expect(accessReasonOf(failed(403), false)).toBe("forbidden");
  });

  test.each([400, 404, 500, 503])("a %i is some other failure", (status) => {
    expect(accessReasonOf(failed(status), true)).toBeUndefined();
  });

  test("a connection failure has no status and is some other failure", () => {
    expect(
      accessReasonOf(new TypeError("Failed to fetch"), true)
    ).toBeUndefined();
    expect(accessReasonOf(undefined, false)).toBeUndefined();
  });
});

describe("where the rows lead", () => {
  const test42: TestRecord = {
    id: "42",
    hud_url: "https://hud.pytorch.org/tests/pytorch/pytorch/test/42",
    repo: "pytorch/pytorch",
    file: "test/test_torch.py",
    suite: "TestTorch",
    case_name: "test_add",
    declared_case_name: "test_add",
    language: "python",
    first_seen_at: "2026-10-13T19:31:24.819Z",
  };
  const envVars: EnvVarsRecord = {
    id: "7",
    values: { TEST_CONFIG: "default" },
    first_seen_at: "2026-10-13T19:31:24.819Z",
  };
  const entry = {
    test: test42,
    environment: gpuEnvironment,
    env_vars: envVars,
  };

  test("the name leads to the test's page, bare", () => {
    expect(testPagePath("pytorch/pytorch", "42")).toBe(
      "/tests/pytorch/pytorch/test/42"
    );
  });

  test("the figures lead to the runs they were counted over, the configuration named", () => {
    // The grid's own defaults, three days of main, are left off as the page
    // leaves them off its own URL.
    expect(
      testRunsHref("pytorch/pytorch", entry, { window: "3d", ranOn: ["main"] })
    ).toBe(
      "/tests/pytorch/pytorch/test/42?environment=2081130751942693630&env_vars=7"
    );
    expect(
      testRunsHref("pytorch/pytorch", entry, {
        window: "12h",
        ranOn: ["main", "pull_request"],
      })
    ).toBe(
      "/tests/pytorch/pytorch/test/42?ran_on=main%2Cpull_request&window=12h&environment=2081130751942693630&env_vars=7"
    );
    // A row whose catalog rows are missing names no configuration.
    expect(
      testRunsHref(
        "pytorch/pytorch",
        { ...entry, environment: null },
        { window: "3d", ranOn: ["main"] }
      )
    ).toBe("/tests/pytorch/pytorch/test/42");
  });
});
