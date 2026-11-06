import { COST_WINDOWS, TREND_ROLLUPS } from "lib/api/tests/cost/windows";
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

export const CostChangesSchema = z
  .object({
    repo: z.string().describe("Repository as owner/name."),
    workflows: z
      .array(z.string())
      .describe("The workflows counted, lowercase; empty for every workflow."),
    owners: z
      .array(z.string())
      .describe(
        "The owners whose share is counted, sorted; empty for every owner."
      ),
    a: DAY_RANGE.describe("The period compared against."),
    b: DAY_RANGE.describe("The period compared."),
    days: z
      .array(z.tuple([DAY, z.number().int().min(0)]))
      .describe(
        "[day, pushes]: each day of A and B the rollup holds, ascending, what their per-day figures divide by, with its pushes to main: distinct head commits pushed to main, by their day."
      ),
    labels: z
      .array(z.string())
      .describe(
        "Runner labels as the jobs asked for them, sorted and comma-separated, most runner-hours first: what a rates file prices."
      ),
    cells: z
      .array(z.tuple([z.number().int().min(0).max(1), INDEX, HOURS, HOURS]))
      .describe(
        "[side, label, runner_hours, main_runner_hours]: 0 for A or 1 for B, an index into labels, the runner-hours, and those of pushes to main (trigger push:main), part of them. Each side's cells sum to its whole; cells without hours are left out."
      ),
    query_duration_ms: z
      .number()
      .int()
      .describe("Time spent in the database requests, rounded."),
  })
  .describe(
    "Two periods' test-job runner-hours, of some owners or every owner, by runner label, all and those of pushes to main, with each day's pushes to main: what changed between them, per day or per commit."
  );

export type RunnerHoursRow = z.infer<typeof RunnerHoursRowSchema>;
export type Contributor = z.infer<typeof ContributorSchema>;
export type MachineSource = (typeof MACHINE_SOURCES)[number];
export type CostMachine = z.infer<typeof CostMachineSchema>;
export type CostSignal = z.infer<typeof CostSignalSchema>;
export type WorkflowPreset = z.infer<typeof WorkflowPresetSchema>;
export type RunnerHours = z.infer<typeof RunnerHoursSchema>;
export type CostTrend = z.infer<typeof CostTrendSchema>;
export type CostChanges = z.infer<typeof CostChangesSchema>;
