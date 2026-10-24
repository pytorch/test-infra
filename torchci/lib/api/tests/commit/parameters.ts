import {
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { PARAMETER_DEFINITIONS } from "lib/api/tests/parameters";
import { RUN_LIST_PARAMETER_DEFINITIONS } from "lib/api/tests/test/runs/parameters";
import { z } from "zod/v4";

export const COMMIT_RUNS_PARAMETER_DEFINITIONS = {
  sha: {
    encoding: "single",
    schema: z
      .string({
        error: "sha must be a full 40-character hexadecimal commit SHA",
      })
      .regex(/^[0-9a-fA-F]{40}$/, {
        error: "sha must be a full 40-character hexadecimal commit SHA",
      })
      .transform((value) => value.toLowerCase())
      .describe(
        "Full 40-character commit SHA. Hexadecimal letters are case-insensitive and normalized to lowercase; abbreviated SHAs are not accepted."
      ),
  },
  repo: PARAMETER_DEFINITIONS.repo,
  ...RUN_LIST_PARAMETER_DEFINITIONS,
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
