import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import {
  CommitGreenlightSchema,
  GreenlightVerdictSchema,
} from "lib/api/tests/commit/greenlight/types";
import { commitSummaryParameters } from "lib/api/tests/commit/summary/parameters";

export const commitGreenlightApiOpenApi: ApiResource = {
  schemas: {
    GreenlightVerdict: GreenlightVerdictSchema,
    CommitGreenlight: CommitGreenlightSchema,
  },
  paths: (ref) => ({
    "/api/tests/commit/{sha}/greenlight": {
      get: {
        operationId: "getCommitGreenlight",
        tags: ["tests"],
        summary: "Read GreenLight's verdict on a commit",
        description:
          "Returns the latest status GreenLight, the automated review that decides whether a pull request may merge without human review, recorded for one commit, as the commit page's header shows it. The commit's pull request is the one getCommitSummary names. For a pull request head the status is that head's own; for a commit on a branch it is the status of the pull request head that landed as it, found from the merge bot's record of the landing, else from the last push to the pull request's branch before the commit's timestamp. Another head's status is never answered: a commit GreenLight did not review has a null verdict, and so has a commit with no pull request, a commit HUD does not know, and any commit of a repository GreenLight does not review, so the endpoint has no 404; no_verdict_reason says which it is. A status is superseded by a later review of the same head. Two or three lookups, well under a second of server time together.",
        parameters: commitSummaryParameters(),
        responses: {
          "200": jsonResponse(
            "GreenLight's verdict on the commit, or why it has none, and the commit's page.",
            ref(CommitGreenlightSchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed repository or SHA, or an unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
  }),
};
