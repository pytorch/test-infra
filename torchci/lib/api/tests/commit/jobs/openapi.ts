import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { commitJobsParameters } from "lib/api/tests/commit/jobs/parameters";
import {
  CommitJobSchema,
  CommitJobsSchema,
  CommitJobTestsSchema,
  FailingAttemptsSchema,
  JobStatusCountsSchema,
  JobTestsSchema,
} from "lib/api/tests/commit/jobs/types";

export const commitJobsApiOpenApi: ApiResource = {
  schemas: {
    JobStatusCounts: JobStatusCountsSchema,
    FailingAttempts: FailingAttemptsSchema,
    CommitJob: CommitJobSchema,
    JobTests: JobTestsSchema,
    CommitJobTests: CommitJobTestsSchema,
    CommitJobs: CommitJobsSchema,
  },
  paths: (ref) => ({
    "/api/tests/commit/{sha}/jobs": {
      get: {
        operationId: "listCommitJobs",
        tags: ["tests"],
        summary: "List the jobs of a commit",
        description:
          "Returns every GitHub job of one commit, whether it ran tests or not, as the commit page's timeline draws them: in jobs, when each job was created, started and ended and its Test step; in tests, for each job with a retained test run, what its recorded tests did (bundles by status, when tests were running, how many attempts failed). The two are joined by job ID. Commit membership is the one GET /api/tests/commit/{sha} uses, and the jobs' bundles by status add up to that commit's summary counts. Not paginated. A commit HUD does not know returns no jobs. The fields parameter names which of the two to answer, and each is one read: tests reads every retained run of the commit once, about 4 seconds on one thread on a main commit with 5 million bundles, and jobs a few hundredths of a second. The commit page asks for each on its own, at once, and draws the jobs while the tests are read.",
        parameters: commitJobsParameters(),
        responses: {
          "200": jsonResponse(
            "The commit's jobs, what their tests did and the commit's page.",
            ref(CommitJobsSchema)
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
