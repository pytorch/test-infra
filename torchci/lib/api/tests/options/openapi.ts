import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { testOptionsQueryParameters } from "lib/api/tests/options/parameters";
import { TestOptionsSchema } from "lib/api/tests/options/types";

export const testOptionsApiOpenApi: ApiResource = {
  schemas: {
    TestOptions: TestOptionsSchema,
  },
  paths: (ref) => ({
    "/api/tests/options": {
      get: {
        operationId: "getTestOptions",
        tags: ["tests"],
        summary:
          "List the values GET /api/tests offers a reader to choose from",
        description:
          "The windows, code sources, languages and health statuses GET /api/tests accepts, and the environment fields, test configs, calling workflow paths and owner labels found in the catalogs and the health table, each with a label for running text, and the value that applies when the parameter is absent. The fixed choices are read from the same parameter definitions that validate GET /api/tests, so a value the list accepts is offered and no other; the catalog choices are the distinct values recorded at the time of the request. Takes no parameters; the response may be cached briefly.",
        parameters: testOptionsQueryParameters(),
        responses: {
          "200": jsonResponse("The options.", ref(TestOptionsSchema)),
          ...errorResponses(
            ref,
            "An unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
  }),
};
