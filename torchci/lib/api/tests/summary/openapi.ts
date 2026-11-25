import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { testSummaryQueryParameters } from "lib/api/tests/summary/parameters";
import {
  TestSummarySchema,
  TestViewFigureSchema,
} from "lib/api/tests/summary/types";

export const testSummaryApiOpenApi: ApiResource = {
  schemas: {
    TestViewFigure: TestViewFigureSchema,
    TestSummary: TestSummarySchema,
  },
  paths: (ref) => ({
    "/api/tests/summary": {
      get: {
        operationId: "getTestSummary",
        tags: ["tests"],
        summary: "Say how a repository's tests stand, one figure per view",
        description:
          "Answers every named view of GET /api/tests/options with the one figure its figure.kind names, without listing a page of it: for a count, how many entries GET /api/tests lists over all its pages, one per test, environment and env var set; for slowest, the largest mean passed duration among them and its test; for total_duration, the machine time the attempts of all of them took. Each figure is read as GET /api/tests reads the view's params with its figure.params added, over the window and the languages asked for; a view that sets its own window keeps it, and its figure says which. Most figures add nothing and are of everything their view lists; the first view lists every entry with the unhealthy ones first, and its figure counts the unhealthy ones, failing or flaky. Every figure is read from the rows the list would return for the same parameters, so a count is the length of that list. The server keeps a figure for up to a minute and for one health refresh, so every figure of a response is of the refresh in refreshed_at, or of the next if it landed while the figures were being read. A repository the catalog does not know has zero counts and no slowest test. The HUD tests page (testsPage) shows the figures as the cells of the band above its table, and choosing a cell lists its view.",
        parameters: testSummaryQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The figure of every view, the page that shows them and the health refresh timestamp.",
            ref(TestSummarySchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed repository, a window or language the list does not accept, or an unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
  }),
};
