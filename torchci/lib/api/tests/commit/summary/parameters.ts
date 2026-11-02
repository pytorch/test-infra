import {
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { CommitShaSchema } from "lib/api/tests/commit/sha";
import { PARAMETER_DEFINITIONS } from "lib/api/tests/parameters";
import { z } from "zod/v4";

// The summary takes only the commit: the repository as owner/name and the
// full SHA, as the commit's runs endpoint does.
export const COMMIT_SUMMARY_PARAMETER_DEFINITIONS = {
  sha: { encoding: "single", schema: CommitShaSchema },
  repo: PARAMETER_DEFINITIONS.repo,
} as const;

export const CommitSummaryParamsSchema = parameterSchema(
  COMMIT_SUMMARY_PARAMETER_DEFINITIONS
);
export type CommitSummaryQuery = z.infer<typeof CommitSummaryParamsSchema>;

export function parseCommitSummaryParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COMMIT_SUMMARY_PARAMETER_DEFINITIONS,
    CommitSummaryParamsSchema
  );
}

export function commitSummaryParameters() {
  return [
    pathParameter("sha", CommitSummaryParamsSchema.shape.sha),
    ...parameterQueryParameters(
      CommitSummaryParamsSchema.omit({ sha: true }),
      COMMIT_SUMMARY_PARAMETER_DEFINITIONS
    ),
  ];
}
