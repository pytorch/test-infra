import {
  catalogRecords,
  configurationKey,
  lookupRunCatalog,
} from "lib/api/tests/test/runs/catalog";
import {
  buildRunGridQuery,
  windowStart,
} from "lib/api/tests/test/runs/grid-query";
import type { RunsGridQuery } from "lib/api/tests/test/runs/parameters";
import type {
  RunGrid,
  RunGridCell,
  RunGridLane,
  RunOutcome,
} from "lib/api/tests/test/runs/types";
import { queryClickhouse } from "lib/clickhouse";
import { FAILING_OUTCOMES } from "lib/runOutcomes";

// One row of the grouped read (grid-query.ts): one job's chain of attempts
// of the test, in one configuration and calling workflow, on one commit.
export interface RunGridRow {
  commit_sha: string;
  workflow_path: string | null;
  environments_id_string: string;
  env_vars_id_string: string;
  job_id_string: string;
  job_url: string;
  job_name: string;
  started_at: string;
  outcome: RunOutcome;
  attempt_outcomes: RunOutcome[];
  duration_milliseconds: number;
  passed_duration_milliseconds: number;
}

function laneKey(
  row: Pick<
    RunGridRow,
    "workflow_path" | "environments_id_string" | "env_vars_id_string"
  >
) {
  return JSON.stringify([
    row.workflow_path,
    row.environments_id_string,
    row.env_vars_id_string,
  ]);
}

// Decimal integer strings in numeric order, signs included, so lanes keep
// the catalogs' order and a cell's jobs their ids'.
function compareIds(left: string, right: string) {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

// Text in code unit order, as the query's ORDER BY sorts it: not the
// locale's, which would put "Trunk.yml" after "inductor.yml". The
// timestamps are ISO strings of one width, so their text order is their
// time order.
function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Chains in the order their jobs started, ids breaking a tie.
function compareChains(left: RunGridRow, right: RunGridRow) {
  return (
    compareText(left.started_at, right.started_at) ||
    compareIds(left.job_id_string, right.job_id_string)
  );
}

// Jobs with the same name are one retry sequence: a job and its re-run, in
// time order, whether GitHub re-ran the job in its workflow run or the same
// workflow ran again on the commit, a scheduled one on an unchanged head
// (kept over siblings per workflow run, which would match
// the health table's count of each job on its own). A job without a name is
// a sequence of its own.
function sequenceKey(chain: RunGridRow): string {
  return !chain.job_name
    ? `job:${chain.job_id_string}`
    : `name:${chain.job_name}`;
}

interface RetrySequence {
  chains: RunGridRow[];
  // The bundle rule over the sequence's attempts: the recorded outcome of
  // the last executed attempt, or skipped when nothing in it executed. A
  // chain's own outcome is skipped only when every attempt in it was, so
  // the last chain that is not skipped holds the last executed attempt.
  outcome: RunOutcome;
  // How bad the sequence is, for choosing among siblings, worst first: a
  // failure that stood, a pass after a failing attempt, an expected
  // failure, an unexpected pass or an unknown, a pass, nothing executed.
  rank: number;
}

// The job of a sequence's deciding attempt: its last job that executed
// anything, or its last job when none did. A skipped re-run decides
// nothing, so the cell's click opens the job where the failure or the
// recovery happened.
function decidingChain(chains: readonly RunGridRow[]): RunGridRow {
  return (
    [...chains].reverse().find((chain) => chain.outcome !== "skipped") ??
    chains[chains.length - 1]
  );
}

function sequenceOf(chains: RunGridRow[]): RetrySequence {
  const outcome = decidingChain(chains).outcome;
  let rank: number;
  if (FAILING_OUTCOMES.has(outcome)) rank = 0;
  else if (outcome === "passed") {
    rank = chains.some((chain) =>
      chain.attempt_outcomes.some((attempt) => FAILING_OUTCOMES.has(attempt))
    )
      ? 1
      : 3;
  } else if (outcome === "skipped") rank = 4;
  else rank = 2;
  return { chains, outcome, rank };
}

// The cell of one configuration and calling workflow on one commit, from
// its jobs' chains. Jobs with the same
// name are one retry sequence, a job and its re-run, judged as the commit
// statistics judge a bundle, so a re-run that passed is a pass after a
// failure; jobs with different names are siblings, shards that each ran the
// test, and the worst sibling decides the cell, the one whose last job
// started last among equals, then the one with the greater job id. The
// cell's passed time is one run's time: the mean over the sequences that
// ended passing, each counting the mean over its jobs that passed of their
// passed attempts' time, so two shards that each passed, or a job and its
// re-run that both passed, count as one run of the test, and a recovery
// counts its pass alone; its duration is the whole spend. The decisive job
// is the job of the deciding sequence's deciding attempt; the jobs are
// listed in the order they started.
export function foldCell(rows: readonly RunGridRow[]): RunGridCell {
  if (rows.length === 0) throw new Error("A cell needs at least one job");
  const chains = [...rows].sort(compareChains);
  const sequences = new Map<string, RunGridRow[]>();
  for (const chain of chains) {
    const key = sequenceKey(chain);
    const sequence = sequences.get(key);
    if (sequence === undefined) sequences.set(key, [chain]);
    else sequence.push(chain);
  }
  let decisive: RetrySequence | null = null;
  const passedTimes: number[] = [];
  for (const chainsOfName of sequences.values()) {
    const sequence = sequenceOf(chainsOfName);
    if (sequence.outcome === "passed") {
      passedTimes.push(
        mean(
          sequence.chains
            .filter((chain) => chain.outcome === "passed")
            .map((chain) => chain.passed_duration_milliseconds)
        )
      );
    }
    const last = sequence.chains[sequence.chains.length - 1];
    if (
      decisive === null ||
      sequence.rank < decisive.rank ||
      (sequence.rank === decisive.rank &&
        compareChains(last, decisive.chains[decisive.chains.length - 1]) > 0)
    ) {
      decisive = sequence;
    }
  }
  const deciding = decisive as RetrySequence;
  const decisiveChain = decidingChain(deciding.chains);
  return {
    commit_sha: chains[0].commit_sha,
    outcome: deciding.outcome,
    started_at: chains[0].started_at,
    duration_milliseconds: chains.reduce(
      (sum, chain) => sum + chain.duration_milliseconds,
      0
    ),
    passed_duration_milliseconds:
      passedTimes.length === 0 ? 0 : Math.round(mean(passedTimes)),
    jobs: chains.map((chain) => ({
      job_id: chain.job_id_string,
      job_url: chain.job_url || null,
      job_name: chain.job_name || null,
      outcome: chain.outcome,
      attempts: chain.attempt_outcomes,
      started_at: chain.started_at,
      duration_milliseconds: chain.duration_milliseconds,
      passed_duration_milliseconds: chain.passed_duration_milliseconds,
      decisive: chain === decisiveChain,
    })),
  };
}

// The grid of one test's runs: the jobs' chains from one grouped read of
// the runs and their jobs' metadata, folded into cells, then the lanes'
// environment and env var records from the catalogs, read once per distinct
// configuration as the bundle pages read theirs.
export async function queryRunGrid(
  query: RunsGridQuery,
  now = new Date()
): Promise<RunGrid> {
  const grid = buildRunGridQuery(query, windowStart(query.window, now));
  const startedAt = performance.now();
  const rows: RunGridRow[] = await queryClickhouse(
    grid.sql,
    grid.params,
    "api_test_runs_grid"
  );
  let queryDurationMs = Math.round(performance.now() - startedAt);

  const lanes = new Map<
    string,
    Pick<
      RunGridRow,
      "workflow_path" | "environments_id_string" | "env_vars_id_string"
    > & { chains: Map<string, RunGridRow[]> }
  >();
  const commits = new Map<string, string>();
  for (const row of rows) {
    const key = laneKey(row);
    let lane = lanes.get(key);
    if (lane === undefined) {
      lane = {
        workflow_path: row.workflow_path,
        environments_id_string: row.environments_id_string,
        env_vars_id_string: row.env_vars_id_string,
        chains: new Map(),
      };
      lanes.set(key, lane);
    }
    const chains = lane.chains.get(row.commit_sha);
    if (chains === undefined) lane.chains.set(row.commit_sha, [row]);
    else chains.push(row);
    const first = commits.get(row.commit_sha);
    if (first === undefined || row.started_at < first) {
      commits.set(row.commit_sha, row.started_at);
    }
  }

  const configurationOf = (
    lane: Pick<RunGridRow, "environments_id_string" | "env_vars_id_string">
  ) => ({
    tests_id: query.test_id,
    environments_id: lane.environments_id_string,
    env_vars_id: lane.env_vars_id_string,
  });
  const catalog = await lookupRunCatalog(
    Array.from(lanes.values(), configurationOf)
  );
  queryDurationMs += catalog.query_duration_ms;

  const sortedLanes = Array.from(lanes.values()).sort(
    (left, right) =>
      compareText(left.workflow_path ?? "", right.workflow_path ?? "") ||
      compareIds(left.environments_id_string, right.environments_id_string) ||
      compareIds(left.env_vars_id_string, right.env_vars_id_string)
  );
  return {
    commits: Array.from(commits, ([sha, started_at]) => ({
      sha,
      started_at,
    })).sort(
      (left, right) =>
        compareText(left.started_at, right.started_at) ||
        compareText(left.sha, right.sha)
    ),
    lanes: sortedLanes.map(
      (lane): RunGridLane => ({
        workflow_path: lane.workflow_path,
        ...catalogRecords(
          catalog.byConfiguration.get(configurationKey(configurationOf(lane)))
        ),
        cells: Array.from(lane.chains.values(), foldCell).sort(
          (left, right) =>
            compareText(left.started_at, right.started_at) ||
            compareText(left.commit_sha, right.commit_sha)
        ),
      })
    ),
    query_duration_ms: queryDurationMs,
  };
}
