import {
  canonicalValues,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { CommitShaSchema } from "lib/api/tests/commit/sha";
import { PARAMETER_DEFINITIONS } from "lib/api/tests/parameters";
import { RUN_LIST_PARAMETER_DEFINITIONS } from "lib/api/tests/test/runs/parameters";
import { BUNDLE_STATUSES } from "lib/runOutcomes";
import { z } from "zod/v4";

// The shared run list's filters, then the commit's own, then the paging, in
// the order the other endpoints document theirs.
const { sort, limit, cursor, ...runFilters } = RUN_LIST_PARAMETER_DEFINITIONS;

export const COMMIT_RUNS_PARAMETER_DEFINITIONS = {
  sha: { encoding: "single", schema: CommitShaSchema },
  repo: PARAMETER_DEFINITIONS.repo,
  ...runFilters,
  status: {
    encoding: "repeat",
    schema: z
      .array(z.enum(BUNDLE_STATUSES))
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Select bundles by status, the outcomes the commit page lists. A bundle's status follows its final outcome after replacement deduplication: failed for a final failed, error or crashed; timed_out for a final timeout; flaky for a final pass after a failing attempt (failed, error, crashed or timed_out); passed for a pass with no failing attempt; xfailed for a final expected failure; other for a final unexpected pass or unknown; skipped when every attempt was skipped. A skip never overrides an executed attempt. Repeat this parameter to match any supplied status. Combines with outcome, last_attempt_outcome, rerun_number and worst_status, which must all hold. Omit to include every status. The summary endpoint's by_status counts the bundles each status selects over the whole commit."
      ),
  },
  worst_status: {
    encoding: "repeat",
    schema: z
      .array(z.enum(BUNDLE_STATUSES))
      .min(1)
      .transform(canonicalValues)
      .optional()
      .describe(
        "Select the bundles of tests whose worst status on the commit is one of these: the first status, in the order failed, timed_out, flaky, passed, other, xfailed, skipped, that any bundle of the test has in any job of the commit, before the other filters narrow the bundles. Repeat this parameter to match any supplied status. The summary endpoint's by_worst_status counts these tests once each; with status set to the same value, the page lists the bundles those counts' jobs come from. Omit to select the tests of every worst status."
      ),
  },
  sort,
  limit,
  cursor,
} as const;

export const CommitRunsListParamsSchema = parameterSchema(
  COMMIT_RUNS_PARAMETER_DEFINITIONS
);
export const CommitRunsListQuerySchema = CommitRunsListParamsSchema.omit({
  cursor: true,
});
export type CommitRunsListQuery = z.infer<typeof CommitRunsListQuerySchema>;

export function parseCommitRunsListParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COMMIT_RUNS_PARAMETER_DEFINITIONS,
    CommitRunsListParamsSchema
  );
}

export function commitRunsListParameters() {
  return [
    pathParameter("sha", CommitRunsListParamsSchema.shape.sha),
    ...parameterQueryParameters(
      CommitRunsListParamsSchema.omit({ sha: true }),
      COMMIT_RUNS_PARAMETER_DEFINITIONS
    ),
  ];
}
