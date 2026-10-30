import { parameterQueryParameters } from "lib/api/parameters";
import { ApiResource, pathParameter } from "lib/api/schema";
import {
  TEST_PAGE_PARAMETER_DEFINITIONS,
  TEST_PAGE_PATH,
  TEST_PAGE_PATH_PARAMETERS,
  TestPageQuerySchema,
  TESTS_PAGE_PAGING_PARAMETERS,
  TESTS_PAGE_PARAMETER_DEFINITIONS,
  TESTS_PAGE_PATH,
  TESTS_PAGE_PATH_PARAMETERS,
  TESTS_PAGE_UNSUPPORTED_PARAMETERS,
  TestsPageQuerySchema,
} from "lib/api/tests/pages/parameters";

// The HUD pages built on the tests endpoints, in /api/openapi.json under the
// `pages` tag: HTML for people, listed so that a caller of the API can give
// a reader the page that shows what it fetched, and knows which parameters
// that page takes. Their parameters are generated from the same definitions
// the pages read their URLs with (pages/parameters.ts), the list's own for
// the table page. Nothing here is served by app/api; the pages are under
// pages/tests/.

export const PAGES_TAG = "pages";

// What every page's description says about itself: a page, not an API.
const PAGE_NATURE =
  "A HUD page, for people: HTML, not JSON. Give a reader its URL rather than fetching it. The page loads its data from the tests endpoints with the reader's HUD sign-in, so it needs no token of its own, and a program fetching it gets the HTML shell or the bot challenge. The repository is two path segments, {organization}/{repo}, where the API takes one repo value, pytorch/pytorch.";

const HTML_RESPONSE = {
  description: "The page, as HTML.",
  content: { "text/html": { schema: { type: "string" } } },
};

export const testsPagesOpenApi: ApiResource = {
  schemas: {},
  paths: () => ({
    [TESTS_PAGE_PATH]: {
      get: {
        operationId: "testsPage",
        tags: [PAGES_TAG],
        summary: "HUD page: a repository's tests with their health",
        description: `The table built on listTests (GET /api/tests), one row per entry. ${PAGE_NATURE} The page reads the parameters below and no other, each spelled, encoded and defaulted exactly as GET /api/tests reads it; a parameter it does not list is ignored, so a link must not carry ${TESTS_PAGE_UNSUPPORTED_PARAMETERS.join(
          ", "
        )}, for which the page has no equivalent, and ${TESTS_PAGE_PAGING_PARAMETERS.join(
          " and "
        )} have no meaning, since the page pages by itself. A value the catalogs do not hold falls back to the parameter's default. TestListPage.hud_url is this page's URL for a request, or null when the request used a parameter the page lacks.`,
        parameters: [
          ...Object.entries(TESTS_PAGE_PATH_PARAMETERS).map(([name, schema]) =>
            pathParameter(name, schema)
          ),
          ...parameterQueryParameters(
            TestsPageQuerySchema,
            TESTS_PAGE_PARAMETER_DEFINITIONS
          ),
        ],
        responses: { "200": HTML_RESPONSE },
        security: [],
      },
    },
    [TEST_PAGE_PATH]: {
      get: {
        operationId: "testPage",
        tags: [PAGES_TAG],
        summary: "HUD page: one test, its runs by commit",
        description: `One test's page: its header from getTest (GET /api/tests/test/{test_id}) and the grid of its runs from listRuns (GET /api/tests/test/{test_id}/runs?group_by=commit), one lane per workflow and configuration, one column per commit. ${PAGE_NATURE} The test is addressed by its id, test.id in the API's responses, and TestRecord.hud_url is this page's URL with no parameters. ran_on and window are the grid endpoint's, with the page's own defaults; the other parameters are the page's own and name nothing the API filters on: environment and env_vars together mark a configuration among the others, they do not narrow the grid to it. TestHealthEntry.hud_url and RunGrid.hud_url are this page's URL for an entry's or a grid's runs.`,
        parameters: [
          ...Object.entries(TEST_PAGE_PATH_PARAMETERS).map(([name, schema]) =>
            pathParameter(name, schema)
          ),
          ...parameterQueryParameters(
            TestPageQuerySchema,
            TEST_PAGE_PARAMETER_DEFINITIONS
          ),
        ],
        responses: { "200": HTML_RESPONSE },
        security: [],
      },
    },
  }),
};
