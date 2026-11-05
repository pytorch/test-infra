import {
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { pathParameter } from "lib/api/schema";
import { PARAMETER_DEFINITIONS } from "lib/api/tests/parameters";
import { PullRequestNumberSchema } from "lib/api/tests/pull/number";
import { z } from "zod/v4";

// The pull request endpoint takes only the pull request: the repository as
// owner/name, as the commit endpoints take it, and the number.
export const PULL_REQUEST_PARAMETER_DEFINITIONS = {
  number: { encoding: "single", schema: PullRequestNumberSchema },
  repo: PARAMETER_DEFINITIONS.repo,
} as const;

export const PullRequestParamsSchema = parameterSchema(
  PULL_REQUEST_PARAMETER_DEFINITIONS
);
export type PullRequestQuery = z.infer<typeof PullRequestParamsSchema>;

export function parsePullRequestParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    PULL_REQUEST_PARAMETER_DEFINITIONS,
    PullRequestParamsSchema
  );
}

export function pullRequestParameters() {
  return [
    pathParameter("number", PullRequestParamsSchema.shape.number),
    ...parameterQueryParameters(
      PullRequestParamsSchema.omit({ number: true }),
      PULL_REQUEST_PARAMETER_DEFINITIONS
    ),
  ];
}
