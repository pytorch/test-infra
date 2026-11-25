import {
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import {
  PARAMETER_DEFINITIONS,
  ParameterDefinition,
} from "lib/api/tests/parameters";
import { z } from "zod/v4";

// The summary's own parameter list: the repository, and the two choices of
// GET /api/tests that a reader makes and the views leave alone, the window
// and the languages. Each is the list's own schema, so the summary validates
// and defaults it as the list does; the descriptions are the summary's. What
// a view sets, its code sources, sort and filters, is not a parameter here:
// the figure is the view's.
export const TEST_SUMMARY_PARAMETER_DEFINITIONS = {
  repo: PARAMETER_DEFINITIONS.repo,
  window: {
    encoding: "single",
    schema: PARAMETER_DEFINITIONS.window.schema.describe(
      "Rolling health window the figures are read over, ending at the health data's refresh time, as GET /api/tests reads it. A view that sets its own window keeps it: its figure says which in window."
    ),
  },
  language: {
    encoding: "repeat",
    schema: PARAMETER_DEFINITIONS.language.schema.describe(
      "Read every figure over the tests in these languages only, as GET /api/tests filters on language. Exact, case-sensitive matching. Repeat this parameter to match any supplied value. Every language when absent."
    ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const TestSummaryParamsSchema = parameterSchema(
  TEST_SUMMARY_PARAMETER_DEFINITIONS
);
export type TestSummaryQuery = z.infer<typeof TestSummaryParamsSchema>;

export function parseTestSummaryParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    TEST_SUMMARY_PARAMETER_DEFINITIONS,
    TestSummaryParamsSchema
  );
}

export function testSummaryQueryParameters() {
  return parameterQueryParameters(
    TestSummaryParamsSchema,
    TEST_SUMMARY_PARAMETER_DEFINITIONS
  );
}
