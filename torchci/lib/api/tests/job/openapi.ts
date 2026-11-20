import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { jobDetailPathParameters } from "lib/api/tests/job/parameters";
import {
  JobDetailSchema,
  JobStepSchema,
  JobTestFileSchema,
} from "lib/api/tests/job/types";

export const jobDetailApiOpenApi: ApiResource = {
  schemas: {
    JobStep: JobStepSchema,
    JobTestFile: JobTestFileSchema,
    JobDetail: JobDetailSchema,
  },
  paths: (ref) => ({
    "/api/tests/job/{job_id}": {
      get: {
        operationId: "getJob",
        tags: ["tests"],
        summary: "Read a job's steps and test files",
        description:
          "Returns one GitHub job and what its recorded tests did, as GET /api/tests/commit/{sha}/jobs answers them in jobs and in tests, with its steps and, for each test file it ran, the file's bundles by status, its runs (one per launch of the file in its own process) and how many of its attempts failed, as the commit page's timeline shows an opened job. The tests of a file are GET /api/tests/commit/{sha} with job_id and file. Three reads of one job's rows, a few tenths of a second together.",
        parameters: jobDetailPathParameters(),
        responses: {
          "200": jsonResponse(
            "The job, its steps, its test files and its page.",
            ref(JobDetailSchema)
          ),
          ...errorResponses(
            ref,
            "A malformed job ID, or an unsupported parameter (invalid_parameters)."
          ),
          "404": errorResponse(ref, "HUD has no such job (not_found)."),
        },
      },
    },
  }),
};
