import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { runDetailPathParameters } from "lib/api/tests/run/parameters";
import { RunDetailSchema } from "lib/api/tests/run/types";

export const runDetailApiOpenApi: ApiResource = {
  schemas: { RunDetail: RunDetailSchema },
  paths: (ref) => ({
    "/api/tests/run/{run_id}": {
      get: {
        operationId: "getRun",
        tags: ["tests"],
        summary: "Get a test run bundle by execution ID",
        description:
          "Returns the full run bundle containing the execution UUID exposed as attempts[].id in the run lists. Any retained attempt ID resolves the same bundle for its test, environment, environment-variable set and GitHub workflow job ID. The run has the same attempts, test, environment, env_vars, owners and github_workflow shapes as GET /api/tests/test/{test_id}/runs and GET /api/tests/commit/{sha}. The attempts array includes the initial execution and all subsequent executions in chronological started_at, ended_at and id order, each with its own report link and original rerun_number. Replacement rows are deduplicated before selecting the ID and expanding the bundle. Missing catalog or workflow metadata does not remove a run; unavailable metadata follows the run lists' null and empty-array conventions. No filtering or pagination is applied. An unknown or expired execution ID returns 404.",
        parameters: runDetailPathParameters(),
        responses: {
          "200": jsonResponse(
            "The full run bundle with all attempts, their report links, shared catalog details and workflow metadata.",
            ref(RunDetailSchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed run UUID, or an unsupported parameter."
          ),
          "404": errorResponse(ref, "No retained run has this ID."),
        },
      },
    },
  }),
};
