import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { testDetailPathParameters } from "lib/api/tests/test/parameters";
import { TestDetailSchema } from "lib/api/tests/test/types";
import { TestConfigurationHealthSchema } from "lib/api/tests/types";

export const testDetailApiOpenApi: ApiResource = {
  schemas: {
    TestConfigurationHealth: TestConfigurationHealthSchema,
    TestDetail: TestDetailSchema,
  },
  paths: (ref) => ({
    "/api/tests/test/{test_id}": {
      get: {
        operationId: "getTest",
        tags: ["tests"],
        summary: "Get a test with its owners and all available health",
        description:
          "Returns the catalog test and its owners, with every observed environment, env var set, health window and code source. Each health entry uses the same environment, env var set and health shapes as GET /api/tests. Windows and code sources are kept separate: ran_on contains one source per health entry. No filtering or pagination is applied. A known test without health returns an empty health array; an unknown test returns 404.",
        parameters: testDetailPathParameters(),
        responses: {
          "200": jsonResponse(
            "The test, owners and all available health.",
            ref(TestDetailSchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed ID, or an unsupported parameter (invalid_parameters)."
          ),
          "404": errorResponse(ref, "No test has this ID (not_found)."),
        },
      },
    },
  }),
};
