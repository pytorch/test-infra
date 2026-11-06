import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import {
  costChangesQueryParameters,
  costQueryParameters,
  costTrendQueryParameters,
} from "lib/api/tests/cost/parameters";
import {
  ContributorSchema,
  CostChangesSchema,
  CostMachineSchema,
  CostSignalSchema,
  CostTrendSchema,
  RunnerHoursRowSchema,
  RunnerHoursSchema,
  UnprobedLabelSchema,
  WorkflowPresetSchema,
} from "lib/api/tests/cost/types";

export const costApiOpenApi: ApiResource = {
  schemas: {
    RunnerHours: RunnerHoursSchema,
    RunnerHoursRow: RunnerHoursRowSchema,
    Contributor: ContributorSchema,
    CostMachine: CostMachineSchema,
    CostSignal: CostSignalSchema,
    UnprobedLabel: UnprobedLabelSchema,
    WorkflowPreset: WorkflowPresetSchema,
    CostTrend: CostTrendSchema,
    CostChanges: CostChangesSchema,
  },
  paths: (ref) => ({
    "/api/tests/cost": {
      get: {
        operationId: "getTestsCost",
        tags: ["tests"],
        summary:
          "A repository's CI runner-hours by owner, workflow and machine",
        description:
          "Returns the runner-hours (job wall time on its runner, no queue) of a repository's test jobs over the last 1, 3 or 7 whole UTC days (window), read from the test_cost rollup, as one small fact table: a row per owner, workflow, machine, machine source and runner label, so a caller sums any scope itself, or prices the hours by runner label. Each job's wall time is split among its test files by occupancy, then evenly among each file's owners (ci.owners); hours no owner can be given are unattributed:no_owner (files without owners) and unattributed:no_test_reports (test jobs without test reports). Builds and other jobs are not counted. A machine comes from the jobs' test reports (machine_source environment), is estimated from the runner label of test jobs without reports (runner_label), or is unknown (none, machine empty, its labels in unprobed_labels). days is how many of the window's days the rollup holds, what a daily average divides by. contributors lists the unattributed buckets by runner label or test file; machines gives each machine's family, short name and runner labels; time_to_signal gives HUD's time to signal for pull and trunk on pushes to main; workflow_presets names scopes such as the PR Critical Path.",
        parameters: costQueryParameters(),
        responses: {
          "200": jsonResponse("The runner-hours.", ref(RunnerHoursSchema)),
          ...errorResponses(
            ref,
            "A missing, malformed or unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
    "/api/tests/cost/trend": {
      get: {
        operationId: "getTestsCostTrend",
        tags: ["tests"],
        summary:
          "A repository's CI runner-hours by period, owner and runner label",
        description:
          "Returns the runner-hours of a repository's test jobs, read from the test_cost rollup as GET /api/tests/cost reads them, for each period of a rollup: the last 42 days, 26 weeks (from Monday) or 13 calendar months, UTC, the last period running through yesterday. Each period's hours are split by owner as GET /api/tests/cost splits them (unattributed:no_owner, unattributed:no_test_reports for hours no owner is given) and by runner label, so a caller compares periods and owners, or prices the hours by runner label, from one answer. Names come once each, in owners and labels; cells are [period, owner, label, runner_hours] tuples of indexes. daily holds each day's runner-hours by label from January 1 of yesterday's year, for the year to date and the days each period has data: a period without every day in daily is partial. workflow narrows every figure to the workflows named. The API holds no prices.",
        parameters: costTrendQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The runner-hours by period, owner and runner label.",
            ref(CostTrendSchema)
          ),
          ...errorResponses(
            ref,
            "A missing, malformed or unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
    "/api/tests/cost/changes": {
      get: {
        operationId: "getTestsCostChanges",
        tags: ["tests"],
        summary:
          "What changed in a repository's CI runner-hours between two periods",
        description:
          "Returns the runner-hours of a repository's test jobs in two periods of whole UTC days, A and B, read from the test_cost rollup as GET /api/tests/cost/trend reads them, by runner label, all of them and those of pushes to main (the trigger push:main: a push to main or master), so a caller finds what moved between the periods, prices the hours by runner label, or divides the pushes to main's hours by the pushes for what a main push costs. With owner, the hours are those owners' share as the trend splits them (a file's hours evenly among its owners, or the buckets unattributed:no_owner and unattributed:no_test_reports); without, every owner's. days lists the days of A and B the rollup holds, what per-day figures divide by, each with its pushes to main (distinct head commits pushed, by day), for runner-hours per push. A day in both periods counts in both. workflow narrows every figure to the workflows named. The API holds no prices.",
        parameters: costChangesQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The two periods' runner-hours by runner label.",
            ref(CostChangesSchema)
          ),
          ...errorResponses(
            ref,
            "A missing, malformed or unsupported parameter (invalid_parameters)."
          ),
        },
      },
    },
  }),
};
