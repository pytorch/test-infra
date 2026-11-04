import { errorResponses } from "lib/api/handler";
import { ApiResource, jsonResponse } from "lib/api/schema";
import { costQueryParameters } from "lib/api/tests/cost/parameters";
import {
  ContributorSchema,
  CostMachineSchema,
  CostSignalSchema,
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
  },
  paths: (ref) => ({
    "/api/tests/cost": {
      get: {
        operationId: "getTestsCost",
        tags: ["tests"],
        summary:
          "A repository's CI runner-hours by owner, workflow and machine",
        description:
          "Returns the runner-hours (job wall time on its runner, no queue) of a repository's test jobs over the last 1, 3 or 7 whole UTC days (window), read from the test_cost rollup, as one small fact table: a row per owner, workflow, machine and machine source, so a caller sums any scope itself. Each job's wall time is split among its test files by occupancy, then evenly among each file's owners (ci.owners); hours no owner can be given are unattributed:no_owner (files without owners) and unattributed:no_test_reports (test jobs without test reports). Builds and other jobs are not counted. A machine comes from the jobs' test reports (machine_source environment), is estimated from the runner label of test jobs without reports (runner_label), or is unknown (none, machine empty, its labels in unprobed_labels). days is how many of the window's days the rollup holds, what a daily average divides by. contributors lists the unattributed buckets by runner label or test file; machines gives each machine's family, short name and runner labels; time_to_signal gives HUD's time to signal for pull and trunk on pushes to main; workflow_presets names scopes such as the PR Critical Path.",
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
  }),
};
