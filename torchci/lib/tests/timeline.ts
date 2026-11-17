import type {
  CommitJob,
  CommitJobTests,
  JobTests,
} from "lib/api/tests/commit/jobs/types";
import type { JobDetail } from "lib/api/tests/job/types";
import type { RunRecord } from "lib/api/tests/test/runs/types";
import { FAILING_OUTCOMES } from "lib/runOutcomes";
import { BUNDLE_STATUSES, bundleStatus, BundleStatus } from "lib/tests/bundle";
import { durationLabel, integerLabel } from "lib/tests/table";

// The commit page's timeline: every job of the commit on the clock, folded
// by workflow and by build, and inside a job its steps, its test files and
// their tests. This is its model, free of React: the jobs' times, the tree
// the rows are drawn from and its totals, and what a pick in it stands for.
// Times are Unix seconds.

export type StatusCounts = Record<BundleStatus, number>;

export function noCounts(): StatusCounts {
  return Object.fromEntries(
    BUNDLE_STATUSES.map((status) => [status, 0])
  ) as StatusCounts;
}

function addCounts(into: StatusCounts, from: StatusCounts) {
  for (const status of BUNDLE_STATUSES) into[status] += from[status];
}

export function countsTotal(counts: StatusCounts): number {
  return BUNDLE_STATUSES.reduce((sum, status) => sum + counts[status], 0);
}

// What starts a workflow for the commit's own code. A run started by
// anything else answers something else, a finished run, a comment, an issue,
// and its jobs are kept apart as bots and uploads. A run HUD has no record
// of counts as the commit's own.
const OWN_EVENTS = new Set([
  "push",
  "pull_request",
  "schedule",
  "workflow_dispatch",
  "merge_group",
]);

export interface Stretch {
  start: number;
  end: number;
}

// A job on the clock, and what it spent its time on. Queued is the wait for
// a runner and then for the job's container (GitHub's Initialize containers
// step); running time is the rest: recorded tests (time when at least one
// was running), unaccounted (time in the Test step with none running) and
// other steps.
export interface TimelineJob {
  job: CommitJob;
  // The workflow, by its path, and what the job is called under it: its
  // build (what its name shares with the build's other jobs), whether it is
  // the build itself or a test of it, and the test's config and shard.
  workflowKey: string;
  workflowName: string;
  bot: boolean;
  build: string;
  role: "build" | "test" | null;
  config: string | null;
  shard: { index: number; total: number } | null;
  // A job that did not run; one no runner took, which waits still or waited
  // until it ended; else by what it ran: recorded tests, a Test step that
  // recorded none, or no Test step.
  kind: "skipped" | "waiting" | "tests" | "untested" | "other";
  created: number;
  // When a runner took it and when it ended: now, for a job that has not. A
  // job that ended with no runner started when it ended.
  started: number;
  ended: number;
  // Its container step, and when its own work began: that step's end, else
  // the job's start.
  container: Stretch | null;
  workStart: number;
  queue: number;
  run: number;
  covered: number;
  unaccounted: number;
  other: number;
  test: Stretch | null;
  // The stretches of recorded tests, within the Test step.
  stretches: Stretch[];
  // How many times an attempt failed, of a test that ended failed or timed
  // out or of one that passed on a rerun.
  failing: number;
  counts: StatusCounts | null;
  // What a reader must look at: a job that failed or whose tests failed, or
  // one whose tests needed a rerun.
  bad: "failed" | "flaky" | null;
}

const seconds = (iso: string) => Date.parse(iso) / 1000;
const MATRIX = /^(test|build)(?:-osdc)? \((.*)\)$/;
const PLAIN_ROLE = /^(test|build)(?:-osdc)?$/;
// Jobs of one kind started once per workflow run, "Upload test stats for
// 43579122301, attempt 1", share a name.
const PER_RUN_SUFFIX = /\s+for \d{6,}, attempt \d+$/;

// A job's name taken apart, as lib/tests/jobName.ts takes a test job's:
// "linux-jammy-py3.11-gcc11 / test (default, 2, 7, runner)" is the second of
// seven shards of the default config of that build, and "… / build" the
// build itself. Any other job is its own build.
function nameParts(
  name: string
): Pick<TimelineJob, "build" | "role" | "config" | "shard"> {
  const segments = name.split(" / ");
  const last = segments[segments.length - 1];
  const build = segments.slice(0, -1).join(" / ");
  const matrix = segments.length > 1 ? MATRIX.exec(last) : null;
  if (matrix !== null) {
    const [config, index, total] = matrix[2]
      .split(",")
      .map((part) => part.trim());
    const shard =
      /^[1-9]\d*$/.test(index ?? "") && /^[1-9]\d*$/.test(total ?? "")
        ? { index: Number(index), total: Number(total) }
        : null;
    return {
      build,
      role: matrix[1] as "test" | "build",
      config: config || null,
      shard,
    };
  }
  const plain = segments.length > 1 ? PLAIN_ROLE.exec(last) : null;
  if (plain !== null) {
    return {
      build,
      role: plain[1] as "test" | "build",
      config: null,
      shard: null,
    };
  }
  return {
    build: name.replace(PER_RUN_SUFFIX, ""),
    role: null,
    config: null,
    shard: null,
  };
}

function clip(stretch: Stretch, within: Stretch): Stretch | null {
  const start = Math.max(stretch.start, within.start);
  const end = Math.min(stretch.end, within.end);
  return end > start ? { start, end } : null;
}

// A job with what its recorded tests did: null for a job with no retained
// test run, and for every job while the tests are on their way.
export function timelineJob(
  job: CommitJob,
  tests: JobTests | null,
  now: number
): TimelineJob {
  const created = seconds(job.created_at);
  const skipped = job.conclusion === "skipped";
  const waiting = !skipped && job.started_at === null;
  const startedAt = job.started_at ?? job.completed_at;
  const started = startedAt === null ? now : seconds(startedAt);
  const ended =
    job.completed_at === null
      ? Math.max(now, started)
      : Math.max(seconds(job.completed_at), started);
  const window = (step: CommitJob["test_step"]): Stretch | null =>
    step === null
      ? null
      : clip(
          {
            start: seconds(step.started_at),
            end:
              step.completed_at === null ? ended : seconds(step.completed_at),
          },
          { start: started, end: ended }
        );
  const container = skipped || waiting ? null : window(job.container_step);
  const test = skipped || waiting ? null : window(job.test_step);
  const containerTime =
    container === null ? 0 : container.end - container.start;
  const run =
    skipped || waiting ? 0 : Math.max(0, ended - started - containerTime);
  const stretches =
    tests === null || skipped || waiting
      ? []
      : tests.running.flatMap((stretch) => {
          const clipped = clip(
            {
              start: seconds(stretch.started_at),
              end: seconds(stretch.ended_at),
            },
            test ?? { start: started, end: ended }
          );
          return clipped === null ? [] : [clipped];
        });
  const covered = stretches.reduce(
    (sum, stretch) => sum + stretch.end - stretch.start,
    0
  );
  const testTime = test === null ? covered : test.end - test.start;
  const counts = tests?.by_status ?? null;
  const testsFailed = counts !== null && counts.failed + counts.timed_out > 0;
  const name = nameParts(job.name);
  return {
    job,
    workflowKey: job.workflow.path ?? job.workflow.name ?? job.workflow.run_id,
    workflowName:
      job.workflow.name ??
      job.workflow.path?.replace(/^.*\//, "") ??
      "Unknown workflow",
    bot: job.workflow.event !== null && !OWN_EVENTS.has(job.workflow.event),
    ...name,
    kind: skipped
      ? "skipped"
      : waiting
      ? "waiting"
      : counts !== null
      ? "tests"
      : test !== null
      ? "untested"
      : "other",
    created: Math.min(created, started),
    started,
    ended,
    container,
    workStart: container === null ? started : container.end,
    queue: skipped ? 0 : Math.max(0, started - created) + containerTime,
    run,
    covered,
    unaccounted: Math.max(0, testTime - covered),
    other: Math.max(0, run - testTime),
    test,
    stretches,
    failing:
      tests === null
        ? 0
        : tests.failing_attempts.failed + tests.failing_attempts.flaky,
    counts,
    bad:
      job.conclusion === "failure" || testsFailed
        ? "failed"
        : counts !== null && counts.flaky > 0
        ? "flaky"
        : null,
  };
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface Totals {
  jobs: number;
  ran: number;
  skipped: number;
  run: number;
  queue: number;
  covered: number;
  unaccounted: number;
  other: number;
  // Jobs that failed or had a failed test, and jobs whose tests needed a
  // rerun.
  failed: number;
  flaky: number;
  counts: StatusCounts;
  kinds: { tests: number; untested: number; other: number };
  start: number;
  end: number;
}

function noTotals(): Totals {
  return {
    jobs: 0,
    ran: 0,
    skipped: 0,
    run: 0,
    queue: 0,
    covered: 0,
    unaccounted: 0,
    other: 0,
    failed: 0,
    flaky: 0,
    counts: noCounts(),
    kinds: { tests: 0, untested: 0, other: 0 },
    start: Infinity,
    end: 0,
  };
}

function addJob(totals: Totals, job: TimelineJob) {
  totals.jobs += 1;
  // Whatever GitHub says of the job: its recorded tests are the commit's.
  if (job.counts !== null) addCounts(totals.counts, job.counts);
  if (job.kind === "skipped") {
    totals.skipped += 1;
    return;
  }
  totals.start = Math.min(totals.start, job.created);
  totals.end = Math.max(totals.end, job.ended);
  totals.queue += job.queue;
  if (job.bad === "failed") totals.failed += 1;
  else if (job.bad === "flaky") totals.flaky += 1;
  if (job.kind === "waiting") return;
  totals.ran += 1;
  totals.run += job.run;
  totals.covered += job.covered;
  totals.unaccounted += job.unaccounted;
  totals.other += job.other;
  totals.kinds[job.kind] += 1;
}

// A row of the timeline above a job's insides: every job, a workflow, a
// build, a job; the workflows too small for a row of their own, folded into
// one; and the bots and uploads, with their workflows under them.
export interface TimelineNode {
  id: string;
  type: "root" | "workflow" | "build" | "job" | "small" | "bots";
  name: string;
  parent: TimelineNode | null;
  children: TimelineNode[];
  jobs: TimelineJob[];
  totals: Totals;
  // Drawn muted: the bots and uploads and everything under them.
  quiet: boolean;
  // A job's own.
  job?: TimelineJob;
  // A workflow's own, where the commit ran it more than once: its run where
  // the workflow has another, its attempt where the run has another, and on
  // a row after the workflow's first what its badge says, "run 2",
  // "attempt 2".
  runId?: string;
  attempt?: number;
  mark?: string;
}

export interface Timeline {
  root: TimelineNode;
  nodes: Map<string, TimelineNode>;
  // The clock: from the first of the commit's own jobs queued to the last
  // one done.
  start: number;
  end: number;
  // What the jobs' tests did is still on its way: the jobs are here as jobs
  // that recorded none, and nothing may be said from that. What a Test step
  // held, a job's tests by status and the flaky jobs wait.
  testsPending: boolean;
}

export const ROOT_NAME = "All jobs";
// A workflow with this share of the running time, or a failed job, has
// rows of its own; the rest share one.
const OWN_ROW_SHARE = 0.03;

const BOTS_ID = "bots";
const workflowId = (key: string) => `workflow:${key}`;
const buildId = (key: string, build: string) => `build:${key}:${build}`;
export const jobNodeId = (jobId: string) => `job:${jobId}`;

// Jobs within a build: the build first, then the tests by config and shard.
function byPlaceInBuild(left: TimelineJob, right: TimelineJob): number {
  const rank = (job: TimelineJob) =>
    job.role === "build" ? 0 : job.role === "test" ? 1 : 2;
  return (
    rank(left) - rank(right) ||
    (left.config ?? "").localeCompare(right.config ?? "") ||
    (left.shard?.index ?? 0) - (right.shard?.index ?? 0) ||
    left.created - right.created
  );
}

// Rows in the order things began, to two minutes, the longer first.
function byStart(left: TimelineNode, right: TimelineNode): number {
  return (
    Math.round(left.totals.start / 120) -
      Math.round(right.totals.start / 120) || right.totals.run - left.totals.run
  );
}

// One of the commit's own workflows has a row for each attempt of each of
// its runs: a rerun's jobs, and a second run's, are apart from the jobs they
// repeat, so a row lists a job once. A workflow with more of them than this
// keeps one row, as a bot's does: a workflow dispatched again and again on
// the head of main has had 162 runs on one commit.
const MAX_WORKFLOW_ROWS = 8;
const attemptOf = ({ job }: TimelineJob) =>
  `${job.workflow.run_id}#${job.workflow.run_attempt}`;

// The tree of the commit's jobs, with what their tests did: undefined while
// that is on its way.
export function buildTimeline(
  commitJobs: readonly CommitJob[],
  commitTests: readonly CommitJobTests[] | undefined,
  now: number
): Timeline {
  const nodes = new Map<string, TimelineNode>();
  const make = (
    id: string,
    type: TimelineNode["type"],
    name: string,
    parent: TimelineNode | null,
    quiet = false
  ): TimelineNode => {
    const node: TimelineNode = {
      id,
      type,
      name,
      parent,
      children: [],
      jobs: [],
      totals: noTotals(),
      quiet,
    };
    nodes.set(id, node);
    parent?.children.push(node);
    return node;
  };
  const root = make("root", "root", ROOT_NAME, null);
  const bots = make(BOTS_ID, "bots", "Bots and uploads", null, true);
  const testsOf = new Map(
    (commitTests ?? []).map((tests) => [tests.job_id, tests])
  );
  const jobs = commitJobs
    .map((job) => timelineJob(job, testsOf.get(job.id) ?? null, now))
    .sort(byPlaceInBuild);
  const attempts = new Map<string, Set<string>>();
  for (const job of jobs) {
    if (job.bot) continue;
    const seen = attempts.get(job.workflowKey) ?? new Set<string>();
    attempts.set(job.workflowKey, seen.add(attemptOf(job)));
  }
  for (const job of jobs) {
    const top = job.bot ? bots : root;
    const split =
      !job.bot && attempts.get(job.workflowKey)!.size <= MAX_WORKFLOW_ROWS;
    const key = split
      ? `${job.workflowKey}@${attemptOf(job)}`
      : job.workflowKey;
    const workflow =
      nodes.get(workflowId(key)) ??
      make(workflowId(key), "workflow", job.workflowName, top, job.bot);
    // A bot's jobs sit under its workflow; the commit's under their build.
    const parent = job.bot
      ? workflow
      : nodes.get(buildId(key, job.build)) ??
        make(buildId(key, job.build), "build", job.build, workflow);
    const node = make(
      jobNodeId(job.job.id),
      "job",
      job.job.name,
      parent,
      job.bot
    );
    node.job = job;
    for (
      let above: TimelineNode | null = node;
      above !== null;
      above = above.parent
    ) {
      above.jobs.push(job);
      addJob(above.totals, job);
    }
  }
  for (const node of nodes.values()) {
    if (node.type === "workflow") node.children.sort(byStart);
  }
  // A workflow's rows stand together: its runs in the order they began,
  // each run's attempts in order, and a badge on every row after the first.
  const byRun = new Map<string, Map<string, TimelineNode[]>>();
  for (const row of root.children) {
    const { workflowKey, job } = row.jobs[0];
    const runs = byRun.get(workflowKey) ?? new Map<string, TimelineNode[]>();
    byRun.set(workflowKey, runs);
    const rows = runs.get(job.workflow.run_id) ?? [];
    runs.set(job.workflow.run_id, [...rows, row]);
  }
  const numberOf = (row: TimelineNode) => row.jobs[0].job.workflow.run_attempt;
  const workflows = [...byRun.values()].map((ofWorkflow) => {
    const runs = [...ofWorkflow.values()]
      .map((rows) =>
        rows.sort((left, right) => numberOf(left) - numberOf(right))
      )
      .sort(([left], [right]) => byStart(left, right));
    runs.forEach((rows, earlierRuns) =>
      rows.forEach((row, earlierAttempts) => {
        if (runs.length > 1) row.runId = row.jobs[0].job.workflow.run_id;
        if (rows.length > 1) row.attempt = numberOf(row);
        const marks = [
          ...(earlierRuns > 0 ? [`run ${earlierRuns + 1}`] : []),
          ...(earlierAttempts > 0 ? [`attempt ${numberOf(row)}`] : []),
        ];
        if (marks.length > 0) row.mark = marks.join(" · ");
      })
    );
    return runs.flat();
  });
  // The workflows with rows of their own, then the rest under one row, then
  // the bots.
  workflows.sort(([left], [right]) => byStart(left, right));
  const whole = root.totals.run || 1;
  const main = workflows.filter(
    (rows) =>
      rows.reduce((run, { totals }) => run + totals.run, 0) / whole >=
        OWN_ROW_SHARE || rows.some(({ totals }) => totals.failed > 0)
  );
  const rest = workflows.filter((rows) => !main.includes(rows));
  root.children = main.flat();
  if (rest.length > 0) {
    const small = make(
      "small",
      "small",
      `${integerLabel(rest.length)} smaller ${
        rest.length === 1 ? "workflow" : "workflows"
      }`,
      root
    );
    for (const node of rest.flat()) {
      node.parent = small;
      small.children.push(node);
      for (const job of node.jobs) {
        small.jobs.push(job);
        addJob(small.totals, job);
      }
    }
  }
  if (bots.jobs.length > 0) {
    bots.children.sort(byStart);
    bots.parent = root;
    root.children.push(bots);
  }
  const span = root.jobs.length > 0 ? root.totals : bots.totals;
  return {
    root,
    nodes,
    start: Number.isFinite(span.start) ? span.start : now,
    end: Math.max(span.end, Number.isFinite(span.start) ? span.start : now),
    testsPending: commitTests === undefined,
  };
}

// A build with one job is that job: the timeline draws the job in its place.
export function onlyJob(node: TimelineNode): TimelineNode | null {
  return node.type === "build" &&
    node.children.length === 1 &&
    node.children[0].type === "job"
    ? node.children[0]
    : null;
}

// The rows under a row, a lone job standing in for its build.
export function rowsUnder(node: TimelineNode): TimelineNode[] {
  return node.children.map((child) => onlyJob(child) ?? child);
}

// The row a row sits under, as the timeline draws them.
export function rowAbove(node: TimelineNode): TimelineNode | null {
  const parent = node.parent;
  if (parent === null) return null;
  return onlyJob(parent) === node ? parent.parent : parent;
}

function jobSubName(job: TimelineJob): string {
  if (job.role === "build") return "build";
  if (job.role === null) return "";
  const shard =
    job.shard !== null && job.shard.total > 1
      ? ` · shard ${job.shard.index} of ${job.shard.total}`
      : "";
  return `${job.config ?? "test"}${shard}`;
}

// What a row is called: the table's heading says the same. A workflow's row
// with a badge is called by both, "trunk · attempt 2". A job is called by
// its place in its build, "default · shard 2 of 7", with the build's name
// before it when it stands for the build.
export function nodeLabel(node: TimelineNode): string {
  const job = node.job;
  if (job === undefined) {
    return node.mark === undefined ? node.name : `${node.name} · ${node.mark}`;
  }
  const sub = jobSubName(job);
  const alone = node.parent !== null && onlyJob(node.parent) === node;
  if (sub === "") return alone && job.build !== "" ? job.build : job.job.name;
  return alone ? `${job.build} · ${sub}` : sub;
}

// What a job's conclusion reads as.
export function jobVerdict(job: TimelineJob): {
  text: string;
  tone: "failed" | "flaky" | null;
} {
  const { conclusion, failed_step: failedStep } = job.job;
  if (job.kind === "skipped") return { text: "Skipped", tone: null };
  const waiting = job.kind === "waiting";
  if (conclusion === null) {
    return { text: waiting ? "Waiting for a runner" : "Running", tone: null };
  }
  // A job that ended waiting has no step it ended in.
  const where = waiting
    ? " while queued"
    : failedStep === null
    ? ""
    : ` in ${failedStep}`;
  if (conclusion === "failure") {
    return { text: `Failed${where}`, tone: "failed" };
  }
  if (conclusion === "cancelled") {
    return { text: `Cancelled${where}`, tone: null };
  }
  if (job.bad === "failed") {
    return { text: "Passed, with failed tests", tone: "failed" };
  }
  if (job.bad === "flaky") {
    return { text: "Passed, with flaky tests", tone: "flaky" };
  }
  return { text: "Passed", tone: null };
}

// ---------------------------------------------------------------------------
// The pick
// ---------------------------------------------------------------------------

// What is picked in the timeline, as the page's URL says it: a workflow by
// its path, with its run and its attempt where the commit has several, a
// build of it, a job, a test file of the job, or one test of that file. The
// table lists the pick's tests.
type WorkflowRow = { workflow: string; runId?: string; attempt?: number };
export type TimelinePick =
  | ({ kind: "workflow" } & WorkflowRow)
  | ({ kind: "build"; build: string } & WorkflowRow)
  | { kind: "job"; jobId: string }
  | { kind: "file"; jobId: string; file: string }
  | {
      kind: "test";
      jobId: string;
      file: string;
      suite: string;
      caseName: string;
    };

// A pick as one string, the same for the same pick however it was made.
export function pickKey(pick: TimelinePick | null): string {
  if (pick === null) return "";
  const parts: Partial<Record<string, string | number>> = pick;
  return JSON.stringify(
    [
      "kind",
      "workflow",
      "runId",
      "attempt",
      "build",
      "jobId",
      "file",
      "suite",
      "caseName",
    ].map((part) => parts[part] ?? null)
  );
}

const workflowsUnder = (node: TimelineNode): TimelineNode[] =>
  node.children.flatMap((child) =>
    child.type === "workflow" ? [child] : workflowsUnder(child)
  );

// The tests of every job of the commit by status: the root's, with the
// bots' and uploads', which the root's totals leave out.
export function commitCounts(timeline: Timeline): StatusCounts {
  const counts = noCounts();
  addCounts(counts, timeline.root.totals.counts);
  const bots = timeline.nodes.get(BOTS_ID);
  if (bots !== undefined) addCounts(counts, bots.totals.counts);
  return counts;
}

// The row of a pick, the job's for a file or a test; null for a pick the
// commit does not have.
export function nodeOfPick(
  timeline: Timeline,
  pick: TimelinePick | null
): TimelineNode | null {
  if (pick === null) return null;
  if (pick.kind === "job" || pick.kind === "file" || pick.kind === "test") {
    return timeline.nodes.get(jobNodeId(pick.jobId)) ?? null;
  }
  // A pick that names no run is of the workflow's first, and one that names
  // no attempt of the run's first.
  const rows = workflowsUnder(timeline.root).filter(
    (row) => row.jobs[0].workflowKey === pick.workflow
  );
  const runId = pick.runId ?? rows[0]?.jobs[0].job.workflow.run_id;
  const row = rows.find(
    ({ jobs: [{ job }] }) =>
      job.workflow.run_id === runId &&
      (pick.attempt === undefined || job.workflow.run_attempt === pick.attempt)
  );
  if (row === undefined || pick.kind === "workflow") return row ?? null;
  const build = row.children.find(
    (child) => child.type === "build" && child.name === pick.build
  );
  return build === undefined ? null : onlyJob(build) ?? build;
}

// What tells a workflow's row from its others, as a pick says it.
const rowOf = ({ runId, attempt }: TimelineNode) => ({
  ...(runId !== undefined && { runId }),
  ...(attempt !== undefined && { attempt }),
});

// The pick a row stands for; null for the rows that are not picks: every
// job, the smaller workflows and the bots.
export function pickOfNode(node: TimelineNode): TimelinePick | null {
  if (node.type === "job" && node.job !== undefined) {
    return { kind: "job", jobId: node.job.job.id };
  }
  if (node.type === "workflow" && node.jobs.length > 0) {
    return {
      kind: "workflow",
      workflow: node.jobs[0].workflowKey,
      ...rowOf(node),
    };
  }
  if (node.type === "build" && node.jobs.length > 0 && node.parent !== null) {
    return {
      kind: "build",
      workflow: node.jobs[0].workflowKey,
      ...rowOf(node.parent),
      build: node.jobs[0].build,
    };
  }
  return null;
}

// The rows from the first down to a row, in order.
export function pathTo(node: TimelineNode): TimelineNode[] {
  const path: TimelineNode[] = [];
  for (let row: TimelineNode | null = node; row !== null; row = rowAbove(row)) {
    path.unshift(row);
  }
  return path;
}

// One step back from a pick: a test's file, a file's job, and from a job or
// a build the row it sits under; null from a workflow, the whole commit.
export function pickAbove(
  timeline: Timeline | undefined,
  pick: TimelinePick
): TimelinePick | null {
  if (pick.kind === "test") {
    return { kind: "file", jobId: pick.jobId, file: pick.file };
  }
  if (pick.kind === "file") return { kind: "job", jobId: pick.jobId };
  const node = timeline === undefined ? null : nodeOfPick(timeline, pick);
  const above = node === null ? null : rowAbove(node);
  return above === null ? null : pickOfNode(above);
}

// A pick as the table's title names it: a pill for each row from its
// workflow down, called what the timeline calls the row; a file's and a
// test's names are set as code.
export interface TrailLevel {
  label: string;
  code: boolean;
  pick: TimelinePick;
}

export function trailOf(
  timeline: Timeline,
  pick: TimelinePick | null
): TrailLevel[] {
  if (pick === null) return [];
  const levels: TrailLevel[] = [];
  const node = nodeOfPick(timeline, pick);
  if (node !== null) {
    for (const row of pathTo(node)) {
      const rowPick = pickOfNode(row);
      if (rowPick !== null) {
        levels.push({ label: nodeLabel(row), code: false, pick: rowPick });
      }
    }
  } else if (pick.kind === "workflow" || pick.kind === "build") {
    // A row the commit does not have, by the URL's own words.
    levels.push({
      label: pick.kind === "build" ? pick.build : pick.workflow,
      code: false,
      pick,
    });
  } else {
    levels.push({
      label: `Job ${pick.jobId}`,
      code: false,
      pick: { kind: "job", jobId: pick.jobId },
    });
  }
  if (pick.kind === "file" || pick.kind === "test") {
    levels.push({
      label: shortFileName(pick.file),
      code: true,
      pick: { kind: "file", jobId: pick.jobId, file: pick.file },
    });
  }
  if (pick.kind === "test") {
    levels.push({ label: pick.caseName, code: true, pick });
  }
  return levels;
}

// A pick as the table's Job header holds it, the header's filter being the
// pick: the jobs that recorded tests, a section a workflow in the timeline's
// order and each job by its build and its place in it; the pick's jobs
// among them, the chosen ones; and what the filter's key says, the pick by
// the timeline's names down to its job. Before the jobs arrive it offers
// none and says only that something is picked; before their tests arrive
// it offers none, since no job is known to have recorded any.
export interface JobFilter {
  sections: {
    facet: string;
    title: string;
    options: { value: string; label: string }[];
  }[];
  value: Record<string, string[]>;
  summary: string;
}

const jobsUnder = (node: TimelineNode): TimelineJob[] =>
  node.job !== undefined ? [node.job] : node.children.flatMap(jobsUnder);

export function jobFilterOf(
  timeline: Timeline | undefined,
  pick: TimelinePick | null
): JobFilter {
  if (timeline === undefined) {
    return {
      sections: [],
      value: {},
      summary: pick === null ? "" : "the timeline's pick",
    };
  }
  const picked = new Set(
    (nodeOfPick(timeline, pick)?.jobs ?? []).map(({ job }) => job.id)
  );
  const sections = workflowsUnder(timeline.root)
    .map((workflow) => ({
      facet: workflow.id,
      title: nodeLabel(workflow),
      options: jobsUnder(workflow)
        .filter((job) => job.counts !== null)
        .map((job) => {
          const place = jobSubName(job);
          return {
            value: job.job.id,
            label:
              place === "" || job.build === ""
                ? job.job.name
                : `${job.build} · ${place}`,
          };
        }),
    }))
    .filter((section) => section.options.length > 0);
  return {
    sections,
    value: Object.fromEntries(
      sections.map((section) => [
        section.facet,
        section.options
          .map((option) => option.value)
          .filter((jobId) => picked.has(jobId)),
      ])
    ),
    summary: trailOf(timeline, pick)
      .filter((level) => !level.code)
      .map((level) => level.label)
      .join(" › "),
  };
}

// What the table says of a pick that recorded no test; null for one that
// recorded some, for a file or a test, and while the jobs' tests are on
// their way for all but a job that did not run.
export function noTestsWords(
  timeline: Timeline,
  pick: TimelinePick | null
): string | null {
  const node = nodeOfPick(timeline, pick);
  if (node === null || pick?.kind === "file" || pick?.kind === "test") {
    return null;
  }
  const job = node.job;
  if (job === undefined) {
    return !timeline.testsPending && countsTotal(node.totals.counts) === 0
      ? "These jobs recorded no tests."
      : null;
  }
  if (job.counts !== null) return null;
  if (job.kind === "skipped")
    return "This job was skipped, so it ran no tests.";
  if (job.kind === "waiting") {
    return job.job.conclusion === null
      ? "This job is waiting for a runner."
      : "This job ended before a runner took it, so it ran no tests.";
  }
  if (timeline.testsPending) return null;
  if (job.job.conclusion === null) {
    return "This job is still running and has recorded no test yet.";
  }
  return job.test === null
    ? "This job has no Test step, so it recorded no tests."
    : `This job's Test step ran for ${spanLabel(
        job.test.end - job.test.start
      )} and recorded no test.`;
}

// ---------------------------------------------------------------------------
// A job's insides
// ---------------------------------------------------------------------------

// A step of a job that ran, on the clock.
export type TimelineStep = JobDetail["steps"][number] & Stretch;

// A job's steps that ran, each to its end or, still running, to the job's.
export function timelineSteps(
  steps: JobDetail["steps"],
  job: TimelineJob
): TimelineStep[] {
  return steps.flatMap((step) => {
    if (step.conclusion === "skipped" || step.started_at === null) return [];
    const start = seconds(step.started_at);
    const end =
      step.completed_at === null
        ? job.ended
        : Math.max(start, seconds(step.completed_at));
    return [{ ...step, start, end }];
  });
}

// A step shows in its job's bar when it took over this share of the job's
// time on the clock.
const STEP_SHARE = 0.004;

// Where an open job's bar is cut, so that its grey reads as the steps it
// is: at the end of each step that shows, inside the bar. The Test step's
// two ends need no cut: the bar changes colour there.
export function stepCuts(steps: TimelineStep[], job: TimelineJob): number[] {
  const life = Math.max(1, job.ended - job.created);
  return steps
    .filter(
      (step) =>
        (step.end - step.start) / life > STEP_SHARE &&
        step.end > job.workStart &&
        step.end < job.ended &&
        step.end !== job.test?.start &&
        step.end !== job.test?.end
    )
    .map((step) => step.end);
}

// The step a time falls in, the later of two that touch, by its place in
// the list; -1 for none. A step under a second long answers for a second.
export function stepAt(steps: TimelineStep[], time: number): number {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index];
    if (time >= step.start && time <= Math.max(step.end, step.start + 1)) {
      return index;
    }
  }
  return -1;
}

export type FileRunStatus =
  JobDetail["files"][number]["runs"][number]["status"];

// A test file of a job: its runs on the clock and its tests by status.
export interface TimelineFile {
  // The file's path; "" for tests missing from the catalog.
  path: string;
  name: string;
  runs: (Stretch & { status: FileRunStatus })[];
  failing: number;
  counts: StatusCounts;
  tests: number;
  // The time its runs took, summed, and their span.
  duration: number;
  start: number;
  end: number;
  status: FileRunStatus;
}

// A file takes its worst run's status.
const RUN_RANK: Record<FileRunStatus, number> = {
  failed: 0,
  flaky: 1,
  passed: 2,
  skipped: 3,
};

export function shortFileName(path: string): string {
  return path === "" ? "Unknown file" : path.replace(/^test\//, "");
}

export function timelineFiles(detail: JobDetail): TimelineFile[] {
  return detail.files
    .map((file) => {
      const runs = file.runs.map((run) => ({
        start: seconds(run.started_at),
        end: Math.max(seconds(run.ended_at), seconds(run.started_at)),
        status: run.status,
      }));
      return {
        path: file.file ?? "",
        name: shortFileName(file.file ?? ""),
        runs,
        failing: file.failing_attempts.failed + file.failing_attempts.flaky,
        counts: file.tests_by_status,
        tests: countsTotal(file.tests_by_status),
        duration: runs.reduce((sum, run) => sum + run.end - run.start, 0),
        start: Math.min(...runs.map((run) => run.start)),
        end: Math.max(...runs.map((run) => run.end)),
        status: runs.reduce<FileRunStatus>(
          (worst, run) =>
            RUN_RANK[run.status] < RUN_RANK[worst] ? run.status : worst,
          "skipped"
        ),
      };
    })
    .sort((left, right) => left.start - right.start);
}

// A job names its failed and flaky files and those with this share of its
// test time; the rest share one row when there are more than two of them.
const NAMED_FILE_SHARE = 0.03;

export function namedFiles(files: TimelineFile[]): {
  named: TimelineFile[];
  rest: TimelineFile[];
} {
  const whole = files.reduce((sum, file) => sum + file.duration, 0) || 1;
  const named = files.filter(
    (file) =>
      file.status === "failed" ||
      file.status === "flaky" ||
      file.duration / whole >= NAMED_FILE_SHARE
  );
  const rest = files.filter((file) => !named.includes(file));
  return rest.length > 2 ? { named, rest } : { named: files, rest: [] };
}

// The tests a file names: the failed and flaky first, then the slowest.
export const LISTED_TESTS = 12;

export type AttemptTone = "passed" | "failing" | "skipped" | "other";

// A test of a file as the timeline draws it: its attempts on the clock.
export interface TimelineTest {
  run: RunRecord;
  name: string;
  suite: string;
  status: BundleStatus;
  attempts: (Stretch & { tone: AttemptTone })[];
}

export function timelineTest(run: RunRecord): TimelineTest {
  return {
    run,
    name: run.test?.case_name ?? "Unknown test",
    suite: run.test?.suite ?? "",
    status: bundleStatus(run.attempts.map((attempt) => attempt.outcome)),
    attempts: run.attempts.map((attempt) => ({
      start: seconds(attempt.started_at),
      end: Math.max(seconds(attempt.ended_at), seconds(attempt.started_at)),
      tone:
        attempt.outcome === "passed"
          ? "passed"
          : FAILING_OUTCOMES.has(attempt.outcome)
          ? "failing"
          : attempt.outcome === "skipped"
          ? "skipped"
          : "other",
    })),
  };
}

// ---------------------------------------------------------------------------
// The way to an open job
// ---------------------------------------------------------------------------

// While a job is open the timeline lists only the way down to the pick: of
// the rows under a row on the way, the one that leads on stays and the
// others fold into one line, which counts them and says how many of them
// failed or were flaky.
export interface OtherRows<Row> {
  // The line's row ID.
  id: string;
  name: string;
  rows: Row[];
  failed: number;
  flaky: number;
}

export const otherRowsId = (rowId: string) => `others:${rowId}`;

// The rows under a row on the way: the one that leads on, and the line for
// the others, null when it has none. Null for a row that is not on the way.
export function rowsOnWay(
  parent: TimelineNode,
  onPath: ReadonlySet<string>
): { kept: TimelineNode; others: OtherRows<TimelineNode> | null } | null {
  const rows = rowsUnder(parent);
  const kept = rows.find((row) => onPath.has(row.id));
  if (kept === undefined) return null;
  const others = rows.filter((row) => row !== kept);
  if (others.length === 0) return { kept, others: null };
  // The first row's rows are workflows, the smaller workflows' row and the
  // bots': not a number of one thing. A bot's workflow holds its jobs.
  const name =
    parent.type === "root"
      ? "Other workflows"
      : countLabel(
          others.length,
          parent.type === "small" || parent.type === "bots"
            ? "other workflow"
            : parent.children.some((child) => child.type === "build")
            ? "other build"
            : "other job"
        );
  return {
    kept,
    others: {
      id: otherRowsId(parent.id),
      name,
      rows: others,
      failed: others.reduce((sum, row) => sum + row.totals.failed, 0),
      flaky: others.reduce((sum, row) => sum + row.totals.flaky, 0),
    },
  };
}

// The line for the files folded away around an open file, under the row
// they sit under; null for none.
export function otherFiles(
  rowId: string,
  files: TimelineFile[]
): OtherRows<TimelineFile> | null {
  if (files.length === 0) return null;
  const count = (status: FileRunStatus) =>
    files.filter((file) => file.status === status).length;
  return {
    id: otherRowsId(rowId),
    name: countLabel(files.length, "other file"),
    rows: files,
    failed: count("failed"),
    flaky: count("flaky"),
  };
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

// A folded row's ribbon: how many of its jobs were running in each slice of
// the clock, by what they were doing.
export interface Ribbon {
  tests: Float32Array;
  unaccounted: Float32Array;
  other: Float32Array;
  peak: number;
  slices: number;
  sliceSeconds: number;
}

// A minute a slice, wider on a clock too long for 1,500 of them.
const SLICE_SECONDS = 60;
const MAX_SLICES = 1500;

export function ribbonOf(
  jobs: readonly TimelineJob[],
  start: number,
  end: number
): Ribbon {
  const sliceSeconds = Math.max(
    SLICE_SECONDS,
    Math.ceil((end - start) / MAX_SLICES)
  );
  const slices = Math.max(1, Math.ceil((end - start) / sliceSeconds));
  const tests = new Float32Array(slices);
  const unaccounted = new Float32Array(slices);
  const other = new Float32Array(slices);
  const add = (into: Float32Array, stretch: Stretch, sign = 1) => {
    const from = stretch.start - start;
    const to = stretch.end - start;
    if (to <= from) return;
    const first = Math.max(0, Math.floor(from / sliceSeconds));
    const last = Math.min(slices - 1, Math.floor((to - 1e-6) / sliceSeconds));
    for (let slice = first; slice <= last; slice++) {
      const overlap =
        Math.min(to, (slice + 1) * sliceSeconds) -
        Math.max(from, slice * sliceSeconds);
      into[slice] += (sign * overlap) / sliceSeconds;
    }
  };
  for (const job of jobs) {
    if (job.kind === "skipped" || job.kind === "waiting") continue;
    // The job on its runner, less its container step and its Test step, is
    // other steps; the Test step is unaccounted but for the stretches of
    // recorded tests.
    add(other, { start: job.started, end: job.ended });
    if (job.container !== null) add(other, job.container, -1);
    if (job.test !== null) {
      add(other, job.test, -1);
      add(unaccounted, job.test);
    }
    for (const stretch of job.stretches) {
      add(tests, stretch);
      add(job.test === null ? other : unaccounted, stretch, -1);
    }
  }
  let peak = 0;
  for (let slice = 0; slice < slices; slice++) {
    unaccounted[slice] = Math.max(0, unaccounted[slice]);
    other[slice] = Math.max(0, other[slice]);
    peak = Math.max(peak, tests[slice] + unaccounted[slice] + other[slice]);
  }
  return { tests, unaccounted, other, peak, slices, sliceSeconds };
}

// A ribbon stands on a base this tall, in px, wherever a job is running: to
// the scale of a busy row one job is a fraction of a pixel, and the tail of
// a ribbon was too thin to see.
const RIBBON_BASE_PX = 2;

// A layer of a ribbon as a CSS polygon: the band between two step lines;
// null for a layer with nothing in it. Above the base the track is to the
// scale of the busiest slice, and a slice's layers share the base as they
// share the slice.
export function bandPath(
  lower: (_slice: number) => number,
  upper: (_slice: number) => number,
  ribbon: Ribbon
): string | null {
  const { tests, unaccounted, other, peak, slices } = ribbon;
  let any = false;
  for (let slice = 0; slice < slices && !any; slice++) {
    any = upper(slice) - lower(slice) > 1e-4;
  }
  if (!any || peak <= 0) return null;
  const height = (value: number, slice: number) => {
    const running = tests[slice] + unaccounted[slice] + other[slice];
    const percent = (100 - (100 * value) / peak).toFixed(2);
    const base =
      running > 1e-4 ? RIBBON_BASE_PX * (value / running - value / peak) : 0;
    return base < 0.005
      ? `${percent}%`
      : `calc(${percent}% - ${base.toFixed(2)}px)`;
  };
  const line = (values: (_slice: number) => number) => {
    const points: string[] = [];
    let previous: string | null = null;
    for (let slice = 0; slice < slices; slice++) {
      const at = height(values(slice), slice);
      if (at !== previous) {
        const left = ((100 * slice) / slices).toFixed(3);
        if (previous !== null) points.push(`${left}% ${previous}`);
        points.push(`${left}% ${at}`);
        previous = at;
      }
    }
    points.push(`100% ${previous ?? "100%"}`);
    return points;
  };
  return `polygon(${[...line(upper), ...line(lower).reverse()].join(",")})`;
}

// The part of the clock in view: the whole commit until a job is open, then
// the job, and inside it the file that is open, with a little air around.
export function viewOf(
  timeline: Pick<Timeline, "start" | "end">,
  job: TimelineJob | null,
  file: Stretch | null
): Stretch {
  if (job === null || job.kind === "skipped") {
    return { start: timeline.start, end: timeline.end };
  }
  let { start, end } = file ?? { start: job.created, end: job.ended };
  const air = Math.max((end - start) * 0.04, 1);
  start -= air;
  end += air;
  if (end - start < 20) {
    const middle = (start + end) / 2;
    start = middle - 10;
    end = middle + 10;
  }
  return { start, end };
}

// A round step of time that puts at most nine ticks on a stretch.
export function tickStep(length: number): number {
  for (const step of [
    1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 28800,
    43200,
  ]) {
    if (length / step <= 9) return step;
  }
  return 86400;
}

// The first time at or after `from` that is a round multiple of `step` on
// the viewer's clock.
export function firstRoundTime(step: number, from: number): number {
  const offset = new Date(from * 1000).getTimezoneOffset() * 60;
  const local = from - offset;
  return from + ((step - (local % step)) % step);
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

export const spanLabel = (length: number) =>
  durationLabel(Math.max(0, length) * 1000);

// Running time summed over jobs reads in hours.
export function hoursLabel(length: number): string {
  const hours = length / 3600;
  if (hours >= 100) return `${integerLabel(Math.round(hours))} h`;
  if (hours >= 1) return `${hours.toFixed(1)} h`;
  return spanLabel(length);
}

export function percentLabel(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  const share = (100 * part) / whole;
  if (share > 0 && share < 1) return "under 1%";
  if (share > 99 && share < 100) return "over 99%";
  return `${Math.round(share)}%`;
}

export function countLabel(count: number, one: string, many = `${one}s`) {
  return `${integerLabel(count)} ${count === 1 ? one : many}`;
}
