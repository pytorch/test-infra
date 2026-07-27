import { JobAnnotation, JobsPerCommitData } from "lib/types";

// When N consecutive failures of the same type happen, the failures are counted as
// broken trunk failures (approximately)
export const BROKEN_TRUNK_THRESHOLD = 3;

// When more than N failures happening in the same commit, the failures are counted
// as part of an outage or broken infra (approximately)
export const OUTAGE_THRESHOLD = 10;

function getFailureByJobName(
  jobName: string,
  failures: { [jobName: string]: { [t: string]: number } }
) {
  if (!(jobName in failures)) {
    failures[jobName] = {
      [JobAnnotation.BROKEN_TRUNK]: 0,
      [JobAnnotation.INFRA_BROKEN]: 0,
      [JobAnnotation.TEST_FLAKE]: 0,
    };
  }

  return failures[jobName];
}

function increaseBrokenInfraCount(
  jobName: string,
  count: number,
  failures: { [jobName: string]: { [t: string]: number } }
) {
  if (count === 0) {
    return;
  }

  const failure = getFailureByJobName(jobName, failures);
  failure[JobAnnotation.INFRA_BROKEN] += count;
}

function increaseFailureCount(
  jobName: string,
  count: number,
  failures: { [jobName: string]: { [t: string]: number } },
  is_broken_trunk: boolean
) {
  if (count === 0) {
    return;
  }

  const failure = getFailureByJobName(jobName, failures);
  failure[
    is_broken_trunk ? JobAnnotation.BROKEN_TRUNK : JobAnnotation.TEST_FLAKE
  ] += count;
}

export function approximateSuccessByJobName(
  // The data is sorted by time DESC, so newer commits come first
  data?: JobsPerCommitData[]
) {
  const successesByJobName: { [success: string]: number } = {};

  if (data === undefined || data === null) {
    return successesByJobName;
  }

  data.forEach((commit: JobsPerCommitData) => {
    const successes = new Set(
      commit.successes.filter(
        (n) => n !== null && n !== undefined && n.length > 0
      )
    );

    // Iterate though all the successes in the commit and aggregate them by name
    successes.forEach((success: string) => {
      if (!(success in successesByJobName)) {
        // Make sure the dict is initialized
        successesByJobName[success] = 0;
      }

      successesByJobName[success] += 1;
    });
  });

  return successesByJobName;
}

export function approximateFailureByType(
  // The data is sorted by time DESC, so newer commits come first
  data?: JobsPerCommitData[],
  broken_trunk_threshold: number = BROKEN_TRUNK_THRESHOLD,
  outage_threshold: number = OUTAGE_THRESHOLD
) {
  const failuresByTypes: { [failure: string]: { [t: string]: number } } = {};

  if (!data) {
    return failuresByTypes;
  }

  // Keeps track of failure streaks, where multiple commits failed the same job
  // The key is the failing job's name, and the value is the length of the current streak we're seeing
  const sequentialFailuresCount: { [failure: string]: number } = {};
  data.forEach((commit: JobsPerCommitData) => {
    const failuresInThisCommit = new Set(
      commit.failures.filter((n) => n && n.length > 0)
    );

    // Iterate though all the failures in the commit and aggregate them by name
    failuresInThisCommit.forEach((failure: string) => {
      if (!(failure in sequentialFailuresCount)) {
        // Make sure the dict is initialized
        sequentialFailuresCount[failure] = 0;
      }

      sequentialFailuresCount[failure] += 1;
    });

    // Check if the job still fail in this commit
    Object.keys(sequentialFailuresCount).forEach((failure: string) => {
      if (failuresInThisCommit.has(failure)) {
        // Count the commit as part of an outage
        if (failuresInThisCommit.size >= outage_threshold) {
          increaseBrokenInfraCount(failure, 1, failuresByTypes);
        }

        // Still failing, its counter has already been updated
        return;
      }

      const count = sequentialFailuresCount[failure];
      // Reaching here means that the job starts to fail on the commit after this
      increaseFailureCount(
        failure,
        count,
        failuresByTypes,
        count >= broken_trunk_threshold
      );

      // Reset the count
      sequentialFailuresCount[failure] = 0;
    });
  });

  Object.keys(sequentialFailuresCount).forEach((failure: string) => {
    const count = sequentialFailuresCount[failure];
    // Aggregate all remaining jobs
    increaseFailureCount(
      failure,
      count,
      failuresByTypes,
      count >= broken_trunk_threshold
    );
  });

  return failuresByTypes;
}

// A commit's viable/strict gating state: the list of gating jobs (folded to
// config granularity, shards collapsed) that are blocking it. Produced by the
// viable_strict_sole_blocker ClickHouse query.
export interface SoleBlockerCommit {
  time: string;
  sha: string;
  // first line of the commit message (for the commit-range caption)
  title?: string;
  blocking: string[];
}

// The span of commits the sole-blocker table was computed over, for
// debuggability ("Last 1 day = commit A .. commit B").
export interface SoleBlockerRange {
  count: number;
  oldest?: { sha: string; title: string; time: string };
  newest?: { sha: string; title: string; time: string };
}

export function soleBlockerCommitRange(
  data?: SoleBlockerCommit[]
): SoleBlockerRange {
  if (!data || data.length === 0) {
    return { count: 0 };
  }

  // ISO timestamps sort lexicographically, so scan for min/max without
  // assuming the input is ordered.
  let oldest = data[0];
  let newest = data[0];
  data.forEach((commit) => {
    if (commit.time < oldest.time) oldest = commit;
    if (commit.time > newest.time) newest = commit;
  });

  const pick = (c: SoleBlockerCommit) => ({
    sha: c.sha,
    title: c.title ?? "",
    time: c.time,
  });
  return { count: data.length, oldest: pick(oldest), newest: pick(newest) };
}

export interface SoleBlockerRow {
  name: string;
  // % of evaluated commits where this exact job (config) is the only blocker
  sole: number;
  // % of evaluated commits where only this job's job type is blocking (possibly
  // via several of its configs at once)
  soleJobType: number;
}

// The job type is the workflow + base job name, dropping the test config, e.g.
// "trunk / linux-jammy-rocm-py3.10-mi350 / test (default)" ->
// "trunk / linux-jammy-rocm-py3.10-mi350".
export function jobTypeOf(name: string): string {
  return name.split(" / ").slice(0, 2).join(" / ");
}

// For each gating job, compute how often it is the *only* thing blocking
// viable/strict, both at config granularity and folded up to the job type.
// The denominator is every fully-evaluated commit in the range, so the value
// reads as "this job alone blocks X% of all main commits".
//
// Rows are pruned to the ones that carry signal: a config is shown if it was
// ever individually the sole blocker (sole > 0). Configs that are never
// individually sole but belong to a sole-blocking job type are suppressed as
// redundant, UNLESS no sibling config of that job type is individually sole --
// i.e. the job type only ever blocks via several of its configs failing
// together. In that combo-only case the 0-config rows are kept so the job-type
// signal is never hidden.
export function computeSoleBlockers(
  data?: SoleBlockerCommit[]
): SoleBlockerRow[] {
  if (!data) {
    return [];
  }

  const total = data.length;
  const soleConfigCount: { [name: string]: number } = {};
  const soleJobTypeCount: { [jobType: string]: number } = {};
  const seenConfigs = new Set<string>();

  data.forEach((commit) => {
    const blocking = (commit.blocking ?? []).filter((n) => n && n.length > 0);
    blocking.forEach((n) => seenConfigs.add(n));

    // Sole at config granularity: exactly one folded job is blocking
    const configs = new Set(blocking);
    if (configs.size === 1) {
      const only = configs.values().next().value as string;
      soleConfigCount[only] = (soleConfigCount[only] ?? 0) + 1;
    }

    // Sole at job-type granularity: all blocking jobs belong to one job type
    // (there may be several configs of the same job type)
    const jobTypes = new Set(blocking.map(jobTypeOf));
    if (blocking.length >= 1 && jobTypes.size === 1) {
      const only = jobTypes.values().next().value as string;
      soleJobTypeCount[only] = (soleJobTypeCount[only] ?? 0) + 1;
    }
  });

  const candidates = Array.from(seenConfigs)
    .map((name) => ({
      name,
      sole: total ? ((soleConfigCount[name] ?? 0) / total) * 100 : 0,
      soleJobType: total
        ? ((soleJobTypeCount[jobTypeOf(name)] ?? 0) / total) * 100
        : 0,
    }))
    .filter((row) => row.sole > 0 || row.soleJobType > 0);

  // Job types that already have an individually-sole config, i.e. an actionable
  // row. Their non-sole sibling configs are redundant and get dropped.
  const jobTypesWithSoleConfig = new Set(
    candidates.filter((row) => row.sole > 0).map((row) => jobTypeOf(row.name))
  );

  return candidates
    .filter(
      (row) => row.sole > 0 || !jobTypesWithSoleConfig.has(jobTypeOf(row.name))
    )
    .sort(
      (a, b) =>
        b.soleJobType - a.soleJobType ||
        b.sole - a.sole ||
        a.name.localeCompare(b.name)
    );
}

export function approximateFailureByTypePercent(
  // The data is sorted by time DESC, so newer commits come first
  data?: JobsPerCommitData[],
  broken_trunk_threshold: number = BROKEN_TRUNK_THRESHOLD,
  outage_threshold: number = OUTAGE_THRESHOLD
) {
  const failuresByTypes = approximateFailureByType(
    data,
    broken_trunk_threshold,
    outage_threshold
  );
  if (data === undefined || data === null || data.length === 0) {
    return failuresByTypes;
  }

  // Get the number of times the job succeeds too, so we can calculate the %
  const successesByJobName = approximateSuccessByJobName(data);

  Object.keys(failuresByTypes).forEach((jobName: string) => {
    const successCount = successesByJobName[jobName] ?? 0;
    const failureCount = Object.entries(failuresByTypes[jobName])
      .filter(
        (item) =>
          item[0] === JobAnnotation.BROKEN_TRUNK ||
          item[0] === JobAnnotation.TEST_FLAKE
      )
      .map((item) => item[1])
      .reduce((a, b) => a + b, 0);
    const totalCount = successCount + failureCount;

    Object.keys(failuresByTypes[jobName]).forEach((failure: string) => {
      failuresByTypes[jobName][failure] =
        (failuresByTypes[jobName][failure] / totalCount) * 100;
    });
  });

  return failuresByTypes;
}
