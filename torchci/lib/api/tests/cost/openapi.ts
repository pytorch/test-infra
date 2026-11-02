import { errorResponses } from "lib/api/handler";
import { ApiResource, errorResponse, jsonResponse } from "lib/api/schema";
import { costQueryParameters } from "lib/api/tests/cost/parameters";
import {
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
          "Returns runner-hours (job wall time on its runner, no queue) of a repository's completed jobs over the last 7 whole UTC days as one small fact table: a row per owner, workflow and machine, so a caller sums any scope of workflows, owners or machines itself. Test jobs are split among test file owners by each owner's share of their test config's test time on the job's machine (ci.health, 7 days), pooled over every workflow, so one workflow's owner split is approximate while its total is exact; build and other jobs are shared:build and shared:other, test time no owner can be given unattributed:no_test_reports and unattributed:no_owner. machines gives each machine's family (its accelerator, or its OS's CPUs), a short name and the runner labels mapped to it; an empty machine is Not probed, its labels in unprobed_labels. time_to_signal gives the PR update signals (pull) and PR merge signals (trunk), HUD's time to signal for those workflows on pushes to main at the median and 90th percentile; workflow_presets names scopes such as the PR Critical Path. The days are fixed until a daily rollup holds the hours",
        parameters: costQueryParameters(),
        responses: {
          "200": jsonResponse("The runner-hours.", ref(RunnerHoursSchema)),
          ...errorResponses(
            ref,
            "A missing, malformed or unsupported parameter (invalid_parameters)."
          ),
          // The runner-hours query runs in the heavy workload, so it can be refused.
          "429": errorResponse(
            ref,
            "The database's queue for heavy queries is full; retry after the Retry-After seconds (overloaded)."
          ),
        },
      },
    },
  }),
};
