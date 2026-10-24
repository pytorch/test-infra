import { listErrorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { commitRunsListParameters } from "lib/api/tests/commit/parameters";
import { CommitRunListPageSchema } from "lib/api/tests/commit/types";
import { RUNS_PAGE_DESCRIPTION } from "lib/api/tests/test/runs/openapi";
import { RunStatsSchema } from "lib/api/tests/test/runs/types";

export const commitRunsApiOpenApi: ApiResource = {
  schemas: {
    RunStats: RunStatsSchema,
    CommitRunListPage: CommitRunListPageSchema,
  },
  paths: (ref) => ({
    "/api/tests/commit/{sha}": {
      get: {
        operationId: "listCommitRuns",
        tags: ["tests"],
        summary: "List test runs on a commit",
        description: `Returns retained test runs with their attempts bundled by configuration and GitHub job for GitHub Actions jobs associated with the requested repository and commit. Workflow job and workflow run metadata in the default database identify matching jobs; only runs with matching metadata can be included. Selection matches workflow_run.head_sha, which may differ from the merge SHA recorded on pull-request jobs. All matching workflow runs and job attempts are eligible, without a branch, event or time filter. Returns the same run records and pagination fields as /api/tests/test/{test_id}/runs, plus stats: the exact total and per-outcome counts of individual executions for the entire repository and commit. Statistics count the initial execution and every attempt after replacement deduplication, not bundles. Search, all run filters including outcome, cursor, limit and ordering affect only the runs list, not stats. Successful executions are counted in stats.passed; every other recorded outcome has its own counter. By default every test, environment, env var set and outcome is eligible. ${RUNS_PAGE_DESCRIPTION} Cursors bind the repository, normalized commit SHA, filters and ordering. Cursors issued before attempt bundling are rejected with 400. Each page and statistics query reads current data separately and may differ as data changes; pagination does not enumerate a fixed snapshot. An unknown commit returns an empty page with 200 and all stats counts zero. Filters matching no retained runs return an empty runs list while stats still describe the entire commit.`,
        parameters: commitRunsListParameters(),
        responses: {
          "200": jsonResponse(
            "A page of test run bundles with all attempts, shared catalog details, owners, workflow metadata and exact individual-execution statistics for the entire commit.",
            ref(CommitRunListPageSchema)
          ),
          ...listErrorResponses(ref),
        },
      },
    },
  }),
};
