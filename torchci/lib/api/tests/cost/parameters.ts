import {
  ParameterDefinition,
  parameterQueryParameters,
  parameterSchema,
  parseParameters,
  RawQuery,
} from "lib/api/parameters";
import { COST_WINDOWS, DEFAULT_COST_WINDOW } from "lib/api/tests/cost/windows";
import { PARAMETER_DEFINITIONS as TEST_PARAMETERS } from "lib/api/tests/parameters";
import { z } from "zod/v4";

// The endpoint takes the repository and the window: its answer holds every
// owner, workflow and machine of the window's days, so whatever a reader
// scopes or highlights is summed from the one answer.
export const COST_PARAMETER_DEFINITIONS = {
  repo: TEST_PARAMETERS.repo,
  window: {
    encoding: "single",
    schema: z
      .enum(COST_WINDOWS, {
        error: `window must be one of: ${COST_WINDOWS.join(", ")}`,
      })
      .default(DEFAULT_COST_WINDOW)
      .describe(
        "The last whole UTC days the runner-hours cover, ending at the start of today."
      ),
  },
} as const satisfies Record<string, ParameterDefinition>;

export const CostParamsSchema = parameterSchema(COST_PARAMETER_DEFINITIONS);
export type CostParams = z.infer<typeof CostParamsSchema>;

export function parseCostParams(rawQuery: RawQuery) {
  return parseParameters(
    rawQuery,
    COST_PARAMETER_DEFINITIONS,
    CostParamsSchema
  );
}

export function costQueryParameters() {
  return parameterQueryParameters(CostParamsSchema, COST_PARAMETER_DEFINITIONS);
}

// Named scopes of workflows a reader picks in one click, published with the
// runner-hours. The PR critical path is what a pull request runs and must pass to
// merge.
export const WORKFLOW_PRESETS = [
  {
    value: "pr_critical_path",
    label: "PR Critical Path",
    description: "what a PR runs on each update and must pass to merge",
    workflows: ["pull", "trunk"],
  },
];

// The signals a pull request's author waits on, each measured by the workflow
// that gives it, as HUD's time to signal does on pushes to main: a stand-in
// for the wait on a pull request itself, not exact, but the numbers readers
// know.
export const SIGNALS = [
  {
    value: "pr_update",
    label: "PR update signals",
    workflow: "pull",
    description: "runs on every PR update",
  },
  {
    value: "pr_merge",
    label: "PR merge signals",
    workflow: "trunk",
    description: "must pass for a PR to merge",
  },
];
