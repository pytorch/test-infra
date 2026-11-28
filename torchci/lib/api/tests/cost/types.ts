import { COST_WINDOWS, TREND_ROLLUPS } from "lib/api/tests/cost/windows";
import {
  EnvironmentRecordSchema,
  EnvVarsRecordSchema,
} from "lib/api/tests/types";
import { z } from "zod/v4";

// Where a row's machine came from: its jobs' test reports, their runner
// label (an estimate, for test jobs without reports), or nowhere.
export const MACHINE_SOURCES = ["environment", "runner_label", "none"] as const;

export const OWNER_BUCKETS = [
  "unattributed:no_test_reports",
  "unattributed:no_owner",
] as const;

export const RunnerHoursRowSchema = z
  .object({
    owner: z
      .string()
      .describe(
        `A test file owner, or a bucket of the hours no owner is given: ${OWNER_BUCKETS.join(
          ", "
        )}.`
      ),
    workflow: z
      .string()
      .describe(
        "The workflow's file name without its directory and .yml: pull for .github/workflows/pull.yml."
      ),
    machine: z
      .string()
      .describe(
        "The machine, as machines names it; empty when no machine is known (Unknown machine)."
      ),
    machine_source: z
      .enum(MACHINE_SOURCES)
      .describe(
        "Where the machine came from: environment, the jobs' test reports; runner_label, an estimate from the runner label of test jobs without reports; none, no machine."
      ),
    label: z
      .string()
      .describe(
        "The runner labels the jobs asked for, sorted and comma-separated: what a rates file prices."
      ),
    runner_hours: z.number().describe("Runner-hours of the cell."),
  })
  .describe(
    "Runner-hours of one owner on one machine and runner label in one workflow."
  );

export const ContributorSchema = z
  .object({
    bucket: z.enum(OWNER_BUCKETS).describe("The bucket the hours are in."),
    workflow: z.string().describe("The workflow, as rows name it."),
    machine: z
      .string()
      .describe("The machine, as rows name it; empty when unknown."),
    kind: z
      .enum(["label", "file"])
      .describe(
        "label: a runner label of test jobs without reports; file: a test file without owners."
      ),
    key: z.string().describe("The runner label or the test file."),
    runner_hours: z.number().describe("Runner-hours of the contributor."),
  })
  .describe(
    "What one unattributed bucket's hours are made of: runner labels of test jobs without reports, test files without owners."
  );

export const CostMachineSchema = z
  .object({
    machine: z
      .string()
      .describe(
        "The machine as the tests catalog names a device, or a CPU's OS, architecture and capability."
      ),
    family: z
      .string()
      .describe(
        "The machine's family, for grouping: its accelerator when it has a device (CUDA, ROCm, XPU, MPS, or a new accelerator under its own name), otherwise its OS's CPUs (Linux CPU, Windows CPU, macOS CPU)."
      ),
    short: z
      .string()
      .describe(
        "A name for narrow columns: a device without the leading words it shares with other devices of its family (L4, MI350X VF), or a CPU's architecture and capability (x86_64 avx512)."
      ),
    labels: z
      .array(z.string())
      .describe(
        "The runner labels mapped to the machine in the window, most runner-hours first."
      ),
  })
  .describe("A machine that ran jobs in the window.");

export const UnprobedLabelSchema = z
  .object({
    label: z
      .string()
      .describe(
        "The runner labels a job asked for, sorted and comma-separated."
      ),
    runner_hours: z.number().describe("Runner-hours of the jobs on it."),
  })
  .describe("Runner-hours on no known machine, by runner label.");

export const WorkflowPresetSchema = z
  .object({
    value: z.string().describe("The preset's identity."),
    label: z.string().describe("The preset's name on a key: PR Critical Path."),
    description: z.string().describe("What the workflows have in common."),
    workflows: z.array(z.string()).describe("The workflows' names, lowercase."),
  })
  .describe("A named scope of workflows, picked in one click.");

export const CostSignalSchema = z
  .object({
    value: z.string().describe("The signal's identity: pr_update, pr_merge."),
    label: z
      .string()
      .describe("Its name: PR update signals, PR merge signals."),
    description: z.string().describe("The workflow that gives it, and why."),
    workflow: z
      .string()
      .describe("The workflow measured, lowercase: pull, trunk."),
    runs: z
      .number()
      .int()
      .describe("Successful first attempts of pushes to main counted."),
    p50_seconds: z
      .number()
      .nullable()
      .describe(
        "Median seconds from a run's creation to its last update; null without runs."
      ),
    p90_seconds: z
      .number()
      .nullable()
      .describe("90th percentile of the same; null without runs."),
  })
  .describe(
    "How long one signal takes, as HUD's time to signal measures its workflow on pushes to main: a stand-in for a pull request's wait."
  );

export const RunnerHoursSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    window: z
      .enum(COST_WINDOWS)
      .describe("The window asked for: the last whole UTC days."),
    days: z
      .number()
      .int()
      .describe(
        "Days of the window the rollup holds, what a daily average divides by: fewer than the window's where the rollup starts later."
      ),
    start: z
      .string()
      .describe(
        "The first day with data in the window, ISO 8601 UTC, inclusive."
      ),
    end: z.string().describe("Window end, ISO 8601 UTC, exclusive."),
    rows: z
      .array(RunnerHoursRowSchema)
      .describe(
        "Every owner, workflow, machine and runner label with runner-hours, largest first; they sum to the window's runner-hours."
      ),
    machines: z
      .array(CostMachineSchema)
      .describe("Every machine in rows, largest over the window first."),
    contributors: z
      .array(ContributorSchema)
      .describe(
        "The unattributed buckets' hours by runner label or test file, workflow and machine."
      ),
    unprobed_labels: z
      .array(UnprobedLabelSchema)
      .describe(
        "The runner labels of the hours on no known machine, largest first."
      ),
    time_to_signal: z
      .array(CostSignalSchema)
      .describe("The PR update and merge signals, in that order."),
    workflow_presets: z
      .array(WorkflowPresetSchema)
      .describe("Named scopes of workflows for summing rows."),
    method: z.string().describe("How the runner-hours were split, in words."),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A repository's runner-hours over its last whole days by owner, workflow and machine, with time to signal on main."
  );

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const INDEX = z.number().int().min(0);
// Runner-hours, never negative.
const HOURS = z.number().min(0);

export const TrendDailySchema = z
  .object({
    start: DAY.describe(
      "The first day read, YYYY-MM-DD: January 1 of yesterday's year, or the first period's start if earlier."
    ),
    days: z
      .array(DAY)
      .describe("The days test_cost holds, ascending, YYYY-MM-DD."),
    filling: z
      .array(DAY)
      .describe(
        "The days of days still filling, ascending: last computed less than 27 hours after they began, while jobs that started on them were still running, so they read low by up to a few percent."
      ),
    pushes: z
      .array(z.number().int().min(0))
      .describe(
        "Each day's pushes to main, in days' order: distinct head commits pushed to main or master, by their day. Cost per commit divides push:main runner-hours by them."
      ),
    cells: z
      .array(z.tuple([INDEX, INDEX, HOURS, HOURS]))
      .describe(
        "[day, label, runner_hours, main_runner_hours]: an index into days, an index into the answer's labels, that day's runner-hours on the label, and those of pushes to main (trigger push:main)."
      ),
  })
  .describe(
    "Each day's runner-hours by runner label from January 1, for the year to date and the days each period has data."
  );

export const CostTrendSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    rollup: z.enum(TREND_ROLLUPS).describe("Each period's length."),
    workflows: z
      .array(z.string())
      .describe("The workflows counted, lowercase; empty for every workflow."),
    start: DAY.describe("The first period's first day, YYYY-MM-DD."),
    end: DAY.describe(
      "Today (UTC), YYYY-MM-DD, exclusive: the last period runs through yesterday."
    ),
    periods: z
      .array(DAY)
      .describe(
        "Every period's first day from start, ascending, with data or not; the last one runs through yesterday and may be partial."
      ),
    owners: z
      .array(z.string())
      .describe(
        `Test file owners and the buckets of hours no owner is given (${OWNER_BUCKETS.join(
          ", "
        )}), most runner-hours first.`
      ),
    labels: z
      .array(z.string())
      .describe(
        "Runner labels as the jobs asked for them, sorted and comma-separated, most runner-hours first: what a rates file prices."
      ),
    cells: z
      .array(z.tuple([INDEX, INDEX, INDEX, HOURS, HOURS]))
      .describe(
        "[period, owner, label, runner_hours, main_runner_hours]: indexes into periods, owners and labels, the cell's runner-hours, and those of pushes to main (trigger push:main), part of them. Cells without hours are left out."
      ),
    daily: TrendDailySchema,
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A repository's test-job runner-hours by period, owner and runner label, compact: names once each, cells as index tuples."
  );

const DAY_RANGE = z
  .object({
    from: DAY.describe("The first day, YYYY-MM-DD."),
    to: DAY.describe("The last day, YYYY-MM-DD, included."),
  })
  .describe("A period of whole UTC days.");

export type RunnerHoursRow = z.infer<typeof RunnerHoursRowSchema>;
export type Contributor = z.infer<typeof ContributorSchema>;
export type MachineSource = (typeof MACHINE_SOURCES)[number];
export type CostMachine = z.infer<typeof CostMachineSchema>;
export type CostSignal = z.infer<typeof CostSignalSchema>;
export type WorkflowPreset = z.infer<typeof WorkflowPresetSchema>;
export type RunnerHours = z.infer<typeof RunnerHoursSchema>;
export type CostTrend = z.infer<typeof CostTrendSchema>;

// ── Drill, bars, banner and cases answers: each infers exactly its
// interface in contracts.ts (test/api/tests/cost/contracts.test.ts) and
// echoes its request. ──

const PILL = z
  .object({
    dim: z
      .enum(["o", "m", "f"])
      .describe("o owner (or bucket), m machine, f test file."),
    value: z.string().describe("The owner, machine or test file."),
  })
  .describe("One pill of a drill trail: a filter on one dimension.");

const TRAIL = z
  .array(PILL)
  .describe(
    "The trail asked for, canonical, in drill order; empty for the root."
  );

const SCOPE_BY = z
  .enum(["o", "m", "f", "lane", "label"])
  .describe(
    "What the children are: owners, machines, test files, lanes or labels."
  );

const SIDE_INDEX = z.number().int().min(0).max(1);
const WORKFLOWS = z
  .array(z.string())
  .describe(
    "The workflows counted, lowercase, sorted; empty for every workflow."
  );

export const ScopeSideSchema = z
  .object({
    days: z
      .array(DAY)
      .describe(
        "The side's days the rollup holds, ascending: what its per-day figures divide by."
      ),
    pushes: z
      .array(z.number().int().min(0))
      .describe(
        "Each day's pushes to main, in days' order: distinct head commits pushed to main or master, by their day."
      ),
    filling: z
      .array(DAY)
      .describe(
        "The side's days still filling: last computed less than 27 hours after they began, so they read low by up to a few percent."
      ),
  })
  .describe("One side's days, pushes to main and days still filling.");

export const ScopePieceSchema = z
  .object({
    side: z.union([z.literal(0), z.literal(1)]).describe("0 for A, 1 for B."),
    from: DAY.describe("The piece's first day."),
    to: DAY.describe("The piece's last day, included."),
  })
  .describe(
    "One side's run of days inside one ISO week and one calendar month: from the latest of the week's Monday, the month's first and the side's first day, to the earliest of the week's Sunday, the month's last and the side's last day. A rate set by week or month prices each piece whole. With piece day, one day."
  );

export const ScopeChildInfoSchema = z
  .object({
    family: z
      .string()
      .optional()
      .describe("by=m: the machine's family (CUDA, ROCm, Linux CPU, …)."),
    short: z
      .string()
      .optional()
      .describe("by=m: a short name for narrow columns (L4, x86_64 avx512)."),
    device: z.string().optional().describe("by=m: the device name, if any."),
    cpu: z
      .string()
      .optional()
      .describe("by=m: the CPU's architecture and capability."),
    coOwners: z
      .array(z.string())
      .optional()
      .describe("by=f: the file's owners, when it has more than one."),
    environment: EnvironmentRecordSchema.optional().describe(
      "by=lane: the lane's environment, from the environments catalog."
    ),
    workflow: z
      .string()
      .optional()
      .describe("by=lane or label: the workflow, by its file name."),
    label: z.string().optional().describe("by=label: the runner labels."),
  })
  .describe("What the page shows of one child beside its name.");

export const CostScopeSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    workflows: WORKFLOWS,
    trail: TRAIL,
    by: SCOPE_BY,
    a: DAY_RANGE.describe("A, as asked."),
    b: DAY_RANGE.describe("B, as asked."),
    piece: z
      .enum(["week", "day"])
      .describe("What a piece is, as asked: week or day."),
    sides: z
      .tuple([ScopeSideSchema, ScopeSideSchema])
      .describe("A's and B's days with data, pushes and days still filling."),
    pieces: z
      .array(ScopePieceSchema)
      .describe("The pieces cells are in, by side and first day."),
    children: z
      .array(z.string())
      .describe(
        "The scope's children, most runner-hours over both sides first: owners and buckets (unattributed:no_test_reports, unattributed:no_owner), machines (Unknown machine), test files, lanes (environment id|workflow) or labels (runner labels|workflow)."
      ),
    info: z
      .array(ScopeChildInfoSchema)
      .describe("Each child's details, in children's order."),
    labels: z
      .array(z.string())
      .describe(
        "Runner labels as the jobs asked for them, sorted and comma-separated, most runner-hours first: what a rates file prices."
      ),
    cells: z
      .array(z.tuple([SIDE_INDEX, INDEX, INDEX, INDEX, HOURS, HOURS]))
      .describe(
        "[side, piece, child, label, runner_hours, main_runner_hours]: 0 for A or 1 for B, indexes into pieces, children and labels, the runner-hours, and those of pushes to main, part of them. A side's cells sum to the scope's hours on its days."
      ),
    tests: z
      .array(z.tuple([SIDE_INDEX, INDEX, HOURS, HOURS]))
      .describe(
        "by=f or lane: [side, child, executed_hours, skipped_hours], the test time of executed and of skipped tests, in the owners' share as the runner-hours are; empty otherwise."
      ),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "The children of a drill scope in two periods, by runner label and piece: the cost page's drill rows."
  );

export const CostSeriesSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    workflows: WORKFLOWS,
    trail: TRAIL,
    by: SCOPE_BY,
    from: DAY.describe("The first day, as asked."),
    to: DAY.describe("The last day, as asked, included."),
    days: z
      .array(DAY)
      .describe("The range's days the rollup holds, ascending."),
    pushes: z
      .array(z.number().int().min(0))
      .describe("Each day's pushes to main, in days' order."),
    filling: z.array(DAY).describe("The days still filling."),
    children: z
      .array(z.string())
      .describe(
        "The children, most runner-hours first, named as GET /api/tests/cost/scope names them; with rest, the last is '' for every child past the 30 largest."
      ),
    rest: z
      .boolean()
      .describe(
        "Whether the last child ('') folds the children past the 30 largest (by=f, lane or label only)."
      ),
    labels: z
      .array(z.string())
      .describe(
        "Runner labels as the jobs asked for them, most runner-hours first."
      ),
    cells: z
      .array(z.tuple([INDEX, INDEX, INDEX, HOURS, HOURS]))
      .describe(
        "[day, child, label, runner_hours, main_runner_hours]: indexes into days, children and labels, the runner-hours and those of pushes to main."
      ),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A drill scope's runner-hours by day, child and runner label: the cost page's bars below the owner root."
  );

const CASES_SIDE = z
  .object({
    from: DAY.describe("The first day asked."),
    to: DAY.describe("The last day asked, included."),
    covered_from: DAY.nullable().describe(
      "The first day the runs table still holds in full (14 days), or null when none of the side is held."
    ),
    covered_days: z
      .number()
      .int()
      .min(0)
      .describe(
        "How many of the side's days were read: from covered_from to the side's last day, at most yesterday. Per-day figures divide by it."
      ),
  })
  .describe("One side as asked, with the days the runs table still holds.");

export const CasesLaneSchema = z
  .object({
    environment: z
      .string()
      .regex(/^\d{1,20}$/)
      .describe("The environment's id, a UInt64 as a decimal string."),
    estimate: z
      .number()
      .min(0)
      .describe(
        "The predicted scan time of this environment alone, in seconds at 4 threads."
      ),
    tooBig: z
      .boolean()
      .describe("Whether that prediction is over the 45 second limit."),
  })
  .describe("The gate's prediction for one environment of the machine.");

const COUNT = z.number().int().min(0);

export const CostCasesSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    file: z.string().describe("The test file, as asked."),
    machine: z.string().describe("The machine, as asked."),
    environment: z
      .string()
      .nullable()
      .describe("The one environment asked for, or null for every one."),
    a: CASES_SIDE,
    b: CASES_SIDE,
    status: z
      .enum(["ok", "too_big"])
      .describe(
        "ok: scanned. too_big: the gate predicted more than 45 seconds at 4 threads; nothing was scanned and configs and cells are empty."
      ),
    lanes: z
      .array(CasesLaneSchema)
      .describe(
        "Each environment the file ran on on that machine in the covered days, largest first, with the gate's prediction: what Try one environment offers."
      ),
    environments: z
      .array(EnvironmentRecordSchema)
      .describe("The environments configs and cells index."),
    env_vars: z
      .array(EnvVarsRecordSchema)
      .describe("The env var sets configs and cells index."),
    tests: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^\d{1,20}$/)
            .describe("The test's id."),
          suite: z.string().describe("The test's suite (class)."),
          name: z
            .string()
            .describe("The test's name, as the runner selects it."),
        })
      )
      .describe("The tests cells index."),
    configs: z
      .array(
        z.tuple([
          SIDE_INDEX,
          INDEX,
          INDEX,
          COUNT,
          COUNT,
          COUNT,
          COUNT,
          COUNT,
          HOURS,
        ])
      )
      .describe(
        "[side, environment, env_vars, tests, runs, skipped, failed, reruns, test_ms]: every configuration of the file on the machine, exact: distinct tests, attempts (rows), skipped attempts, failed attempts (failed, error, crashed or timed out), reruns (rerun_number > 0) and test milliseconds."
      ),
    cells: z
      .array(
        z.tuple([
          SIDE_INDEX,
          INDEX,
          INDEX,
          INDEX,
          COUNT,
          COUNT,
          COUNT,
          COUNT,
          HOURS,
        ])
      )
      .describe(
        "[side, test, environment, env_vars, runs, skipped, failed, reruns, test_ms]: the 200 test × configuration cells that moved most in test time a day, plus B's 50 largest; the rest of a side is its configs less its cells."
      ),
    ranked_of: COUNT.describe("Test × configuration cells in all."),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A test file's configurations and test cases on one machine in two periods, from the runs table (last 14 days): what the cost page's file level lists."
  );

export const CostCoverageSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    workflows: WORKFLOWS,
    from: DAY.describe("The first day, as asked."),
    to: DAY.describe("The last day, as asked, included."),
    days: z.array(DAY).describe("The range's days the rollup holds."),
    labels: z.array(z.string()).describe("Runner labels, most hours first."),
    cells: z
      .array(z.tuple([INDEX, z.number().int().min(0).max(3), INDEX, HOURS]))
      .describe(
        "[day, segment, label, runner_hours]: segment 0 running (test files running: held time), 1 setup_idle (test-job time with no file running), 2 no_reports (test jobs without test reports), 3 out_of_scope (test jobs outside the workflows asked for)."
      ),
    with_reports_h: HOURS.describe(
      "Runner-hours of the scope's test jobs with reports."
    ),
    owned_h: HOURS.describe(
      "Of them, those of test files with an owner (ci.owners, read now)."
    ),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A repository's test-job runner-hours by day, segment and runner label: the blue part of the cost page's coverage banner."
  );

export const CostCoverageJobsSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    org: z.string().describe("Its organization: every repository counted."),
    from: DAY.describe("The first day, as asked."),
    to: DAY.describe("The last day, as asked, included."),
    repos: COUNT.describe("Repositories of the organization with jobs."),
    labels: z.array(z.string()).describe("Runner labels, most hours first."),
    cells: z
      .array(z.tuple([INDEX, z.number().int().min(0).max(1), INDEX, HOURS]))
      .describe(
        "[day, segment, label, runner_hours]: day indexes the range's days from from; segment 0 other_repos (the organization's other repositories), 1 repo_all (every job of the repository). Job wall time, start to finish, of completed jobs on a runner, by the day they started."
      ),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "An organization's CI runner-hours by day, repository segment and runner label: the grey part of the cost page's coverage banner."
  );

export const CostOwnersSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    workflows: WORKFLOWS,
    from: DAY.describe("The first day, as asked."),
    to: DAY.describe("The last day, as asked, included."),
    piece: z
      .enum(["day"])
      .nullable()
      .describe(
        "day when the rows' runner-hours are split by day (cells), as asked; null otherwise."
      ),
    days: z
      .array(DAY)
      .describe(
        "The range's days the rollup holds, ascending: what a daily average divides by."
      ),
    filling: z
      .array(DAY)
      .describe(
        "The days still filling: last computed less than 27 hours after they began, so they read low by up to a few percent."
      ),
    rows: z
      .array(RunnerHoursRowSchema)
      .describe(
        "Every owner, workflow, machine and runner label with runner-hours on the range's days, largest first, as GET /api/tests/cost's rows."
      ),
    machines: z
      .array(CostMachineSchema)
      .describe("Every machine in rows, largest first."),
    unprobed_labels: z
      .array(UnprobedLabelSchema)
      .describe(
        "The runner labels of the hours on no known machine, largest first."
      ),
    cells: z
      .array(z.tuple([INDEX, INDEX, HOURS]))
      .describe(
        "[day, row, runner_hours]: indexes into days and rows, and the row's runner-hours on that day, rounded to 0.0001 h, so a row's cells sum to its runner-hours within that rounding; empty without piece=day."
      ),
    method: z.string().describe("How the runner-hours were split, in words."),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "A repository's test-job runner-hours over a range of days and a workflow scope by owner, workflow, machine and runner label: the cost page's owner bars."
  );

export type CostScopeAnswer = z.infer<typeof CostScopeSchema>;
export type CostSeriesAnswer = z.infer<typeof CostSeriesSchema>;
export type CostCasesAnswer = z.infer<typeof CostCasesSchema>;
export type CostCoverageAnswer = z.infer<typeof CostCoverageSchema>;
export type CostCoverageJobsAnswer = z.infer<typeof CostCoverageJobsSchema>;
export type CostOwnersAnswer = z.infer<typeof CostOwnersSchema>;
