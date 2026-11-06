import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { commitSummaryParameters } from "lib/api/tests/commit/summary/parameters";
import {
  CommitCountsSchema,
  CommitPullRequestSchema,
  CommitRecordSchema,
  CommitStatusCountsSchema,
  CommitSummarySchema,
  CommitTestCountsSchema,
} from "lib/api/tests/commit/summary/types";

export const commitSummaryApiOpenApi: ApiResource = {
  schemas: {
    CommitCounts: CommitCountsSchema,
    CommitStatusCounts: CommitStatusCountsSchema,
    CommitTestCounts: CommitTestCountsSchema,
    CommitPullRequest: CommitPullRequestSchema,
    CommitRecord: CommitRecordSchema,
    CommitSummary: CommitSummarySchema,
  },
  paths: (ref) => ({
    "/api/tests/commit/{sha}/summary": {
      get: {
        operationId: "getCommitSummary",
        tags: ["tests"],
        summary: "Summarize the tests on a commit",
        description:
          "Returns what happened to the tests on one commit, as the commit page's header and summary row show it: the commit as GitHub described it to HUD (title, author, timestamp, branch, pull request, and on a branch the neighbouring commits with test jobs; a pull request from a fork, whose runs record none, is found by the commit's SHA among the repository's pull request records), its retained test runs counted by status, when they ran, and the page. Commit membership is the one the commit's runs endpoint uses: workflow jobs of the workflow runs whose head_sha is the commit in the repository. Counts follow the bundle status rule after replacement deduplication, the rule the status and worst_status filters of GET /api/tests/commit/{sha} select by: by_worst_status counts every test once under the worst status among its bundles and adds up to the total, while by_status counts the tests, jobs and bundles of each status over every bundle, so a test can appear under several. A commit GitHub never reported to HUD, with no workflow run and no push, returns 404; a known commit whose runs expired with the runs table's retention, or that has none yet, returns zero counts, and retention_starts_at tells the two apart against committed_at. The counts read every retained run of the commit, about 5 seconds on one thread and 1.5 to 5 seconds of wall time on a main commit with 9 million bundles.",
        parameters: commitSummaryParameters(),
        responses: {
          "200": jsonResponse(
            "The commit, its test counts by status, the span of its runs and its page.",
            ref(CommitSummarySchema)
          ),
          ...errorResponses(
            ref,
            "A missing or malformed repository or SHA, or an unsupported parameter (invalid_parameters)."
          ),
          "404": errorResponse(
            ref,
            "HUD has no workflow run and no push for this commit in this repository (not_found)."
          ),
        },
      },
    },
  }),
};
