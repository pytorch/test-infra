import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { pullRequestParameters } from "lib/api/tests/pull/parameters";
import { PullRequestHeadSchema } from "lib/api/tests/pull/types";

export const pullRequestApiOpenApi: ApiResource = {
  schemas: { PullRequestHead: PullRequestHeadSchema },
  paths: (ref) => ({
    "/api/tests/pull/{number}": {
      get: {
        operationId: "getPullRequest",
        tags: ["tests"],
        summary: "Find the newest head commit of a pull request",
        description:
          "Returns a pull request with its newest head commit as HUD knows it, the commit whose tests the pull request's HUD page (pullPage) opens through the commit page. The head is the one the pull request's latest retained pull_request record names, unless the record fell behind a push: when the recorded head ran pull_request workflows on the pull request's branch and another head the pull request's records have named ran there since, that later head is returned. A recorded head that never ran such a workflow is taken from the record as it is: GitHub runs none while a pull request has a merge conflict, though a push waiting for a maintainer's approval records its run. One case is answered wrong: a pull request with a merge conflict pushed back to an earlier head that had run gets no new run, so the later head is returned. Pass head_sha to getCommitSummary and listCommitRuns for the head's tests. A number with no pull request record in the repository returns 404. Two lookups, run concurrently, each well under a tenth of a second of server time.",
        parameters: pullRequestParameters(),
        responses: {
          "200": jsonResponse(
            "The pull request, its newest head commit and its page.",
            ref(PullRequestHeadSchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed repository or number, or an unsupported parameter (invalid_parameters)."
          ),
          "404": errorResponse(
            ref,
            "HUD has no record of a pull request with this number in this repository (not_found)."
          ),
        },
      },
    },
  }),
};
