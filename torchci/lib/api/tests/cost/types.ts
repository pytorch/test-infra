import { z } from "zod/v4";

export const OWNER_BUCKETS = [
  "shared:build",
  "shared:other",
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
    workflow: z.string().describe("The workflow's name, lowercase."),
    machine: z
      .string()
      .describe(
        "The machine, as machines names it; empty for hours on runner labels no sampled test job probed (Not probed)."
      ),
    runner_hours: z.number().describe("Runner-hours of the cell."),
  })
  .describe("Runner-hours of one owner on one machine in one workflow.");

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
        "The runner labels a job asked for, comma-separated, as workflow_job records them."
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
    days: z
      .number()
      .int()
      .describe("Days in the window: the last whole UTC days."),
    start: z.string().describe("Window start, ISO 8601 UTC, inclusive."),
    end: z.string().describe("Window end, ISO 8601 UTC, exclusive."),
    rows: z
      .array(RunnerHoursRowSchema)
      .describe(
        "Every owner, workflow and machine with runner-hours, largest first; they sum to the window's runner-hours."
      ),
    machines: z
      .array(CostMachineSchema)
      .describe("Every machine in rows, largest over the window first."),
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

export type RunnerHoursRow = z.infer<typeof RunnerHoursRowSchema>;
export type CostMachine = z.infer<typeof CostMachineSchema>;
export type CostSignal = z.infer<typeof CostSignalSchema>;
export type WorkflowPreset = z.infer<typeof WorkflowPresetSchema>;
export type RunnerHours = z.infer<typeof RunnerHoursSchema>;
