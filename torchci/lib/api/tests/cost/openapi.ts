import { errorResponses } from "lib/api/handler";
import {
  ApiResource,
  errorResponse,
  jsonResponse,
  type SchemaRef,
} from "lib/api/schema";
import {
  costCasesQueryParameters,
  costChangesQueryParameters,
  costCoverageJobsQueryParameters,
  costCoverageQueryParameters,
  costQueryParameters,
  costScopeQueryParameters,
  costSeriesQueryParameters,
  costTrendQueryParameters,
} from "lib/api/tests/cost/parameters";
import {
  CasesLaneSchema,
  ContributorSchema,
  CostCasesSchema,
  CostChangesSchema,
  CostCoverageJobsSchema,
  CostCoverageSchema,
  CostMachineSchema,
  CostScopeSchema,
  CostSeriesSchema,
  CostSignalSchema,
  CostTrendSchema,
  RunnerHoursRowSchema,
  RunnerHoursSchema,
  ScopeChildInfoSchema,
  ScopePieceSchema,
  ScopeSideSchema,
  UnprobedLabelSchema,
  WorkflowPresetSchema,
} from "lib/api/tests/cost/types";

const INVALID =
  "A missing, malformed or unsupported parameter (invalid_parameters).";

// The errors of an endpoint that runs a heavy query (app/api/README.md,
// Heavy queries): the database's queue for them can refuse it.
function heavyErrorResponses(ref: SchemaRef) {
  return {
    ...errorResponses(ref, INVALID),
    "429": errorResponse(
      ref,
      "The database's queue for heavy queries is full; retry after the Retry-After seconds (overloaded)."
    ),
  };
}

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
    CostScope: CostScopeSchema,
    ScopeSide: ScopeSideSchema,
    ScopePiece: ScopePieceSchema,
    ScopeChildInfo: ScopeChildInfoSchema,
    CostSeries: CostSeriesSchema,
    CostCases: CostCasesSchema,
    CasesLane: CasesLaneSchema,
    CostCoverage: CostCoverageSchema,
    CostCoverageJobs: CostCoverageJobsSchema,
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
    "/api/tests/cost/scope": {
      get: {
        operationId: "getTestsCostScope",
        tags: ["tests"],
        summary:
          "The children of a drill scope of a repository's CI runner-hours in two periods",
        description:
          "Returns the runner-hours of a repository's test jobs in two periods of whole UTC days, A and B, read from the test_cost rollup as GET /api/tests/cost/trend reads them (each day as last computed, owners from ci.owners split evenly, the buckets unattributed:no_owner and unattributed:no_test_reports), inside a drill scope (trail: an owner, a machine and a test file, each optional) and split by its children (by): owners, machines, test files, lanes (environment and workflow) or runner label and workflow. A machine is the environment's when the jobs have test reports, else the machine the runner label's reporting jobs ran on most in that ISO week, else Unknown machine; GET /api/tests/cost/series names machines the same way. Cells are [side, piece, child, label, runner_hours, main_runner_hours]: a piece is one side's days inside one ISO week and one calendar month, so a caller prices them by runner label with weekly or monthly rates. sides gives each side's days with data (what per-day figures divide by), their pushes to main and the days still filling. With by=f or lane, tests gives each child's executed and skipped test hours. The answer echoes the request (trail canonical, workflows sorted). The API holds no prices.",
        parameters: costScopeQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The scope's children in A and B.",
            ref(CostScopeSchema)
          ),
          ...errorResponses(ref, INVALID),
        },
      },
    },
    "/api/tests/cost/series": {
      get: {
        operationId: "getTestsCostSeries",
        tags: ["tests"],
        summary:
          "A drill scope's CI runner-hours by day, child and runner label",
        description:
          "Returns a drill scope's runner-hours (trail and by as GET /api/tests/cost/scope takes them, machines named the same way) for each day from from to to, at most 400 days, by child and runner label, all of them and those of pushes to main: the bars of the cost page below the owner root. days, pushes and filling are the trend's for the same days. For files, lanes and labels the 30 children with the most hours are kept and the rest summed into a last child '' (rest). The answer echoes the request. The API holds no prices.",
        parameters: costSeriesQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The scope's runner-hours by day.",
            ref(CostSeriesSchema)
          ),
          ...errorResponses(ref, INVALID),
        },
      },
    },
    "/api/tests/cost/cases": {
      get: {
        operationId: "getTestsCostCases",
        tags: ["tests"],
        summary:
          "A test file's configurations and test cases on one machine in two periods",
        description:
          "Returns a test file's runs on one machine (as GET /api/tests/cost/scope names it) in two periods, A and B, read from the runs table, which keeps 14 days: each side is clipped to the whole days still held (covered_from, covered_days). Every configuration (environment and env var set) is exact: distinct tests, attempts, skipped, failed, reruns and test milliseconds; of the test × configuration cells, the 200 that moved most in test time a day and B's 50 largest are returned (ranked_of counts them all). Workflows and triggers are not distinguished. A cheap gate first predicts the scan from the file's test count and the days covered: when it predicts more than 45 seconds the answer is status too_big and nothing is scanned. The runs are sorted by test, so one environment costs as much as all of them; fewer days cost less. A heavy query: the database may refuse it (429).",
        parameters: costCasesQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The file's configurations and largest moves.",
            ref(CostCasesSchema)
          ),
          ...heavyErrorResponses(ref),
        },
      },
    },
    "/api/tests/cost/coverage": {
      get: {
        operationId: "getTestsCostCoverage",
        tags: ["tests"],
        summary:
          "What a repository's test-job runner-hours are made of, by day and runner label",
        description:
          "Returns a repository's test-job runner-hours from the test_cost rollup for each day from from to to (at most 400), by segment and runner label: running (the time test files ran, held_milliseconds), setup_idle (the rest of jobs with reports), no_reports (test jobs without test reports) and out_of_scope (test jobs outside the workflows asked for). with_reports_h and owned_h give the scope's hours with reports and, of them, those of files with an owner. The blue part of the cost page's coverage banner.",
        parameters: costCoverageQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The test-job segments by day and label.",
            ref(CostCoverageSchema)
          ),
          ...errorResponses(ref, INVALID),
        },
      },
    },
    "/api/tests/cost/coverage/jobs": {
      get: {
        operationId: "getTestsCostCoverageJobs",
        tags: ["tests"],
        summary:
          "An organization's CI job runner-hours by day, repository segment and runner label",
        description:
          "Returns the job wall time (start to finish) of the repository's organization's completed jobs on a runner, any job kind, GitHub-hosted runners included, by the day they started, from from to to (at most 28 days), as test_cost's job rules pick jobs: repo_all is the repository's every job, other_repos the organization's other repositories. Subtracting GET /api/tests/cost/coverage from repo_all gives the repository's builds, lint and other jobs. A heavy query of the jobs table: the database may refuse it (429).",
        parameters: costCoverageJobsQueryParameters(),
        responses: {
          "200": jsonResponse(
            "The organization's job hours by day, segment and label.",
            ref(CostCoverageJobsSchema)
          ),
          ...heavyErrorResponses(ref),
        },
      },
    },
  }),
};
