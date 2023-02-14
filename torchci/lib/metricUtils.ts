import { JobsPerCommitData, JobAnnotation } from "lib/types";

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

function updateBrokenInfraCount(
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

function updateFailureCount(
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
  // The data from Rockset is sorted by time DESC, so newer commits come first
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
        // Start the count
        successesByJobName[success] = 0;
      }

      successesByJobName[success] += 1;
    });
  });

  return successesByJobName;
}

export function approximateFailureByType(
  // The data from Rockset is sorted by time DESC, so newer commits come first
  data?: JobsPerCommitData[],
  broken_trunk_threshold: number = BROKEN_TRUNK_THRESHOLD,
  outage_threshold: number = OUTAGE_THRESHOLD
) {
  const failuresByTypes: { [failure: string]: { [t: string]: number } } = {};

  if (data === undefined || data === null) {
    return failuresByTypes;
  }

  const failuresCount: { [failure: string]: number } = {};
  data.forEach((commit: JobsPerCommitData) => {
    const failures = new Set(
      commit.failures.filter(
        (n) => n !== null && n !== undefined && n.length > 0
      )
    );

    // Iterate though all the failures in the commit and aggregate them by name
    failures.forEach((failure: string) => {
      if (!(failure in failuresCount)) {
        // Start the count
        failuresCount[failure] = 0;
      }

      failuresCount[failure] += 1;
    });

    // Check if the job still fail in this commit
    Object.keys(failuresCount).forEach((failure: string) => {
      if (failures.has(failure)) {
        // Count the commit as part of an outage
        if (failures.size >= outage_threshold) {
          updateBrokenInfraCount(failure, 1, failuresByTypes);
        }

        // Still failing, its counter has already been updated
        return;
      }

      const count = failuresCount[failure];
      // Reaching here means that the job starts to fail on the commit after this
      updateFailureCount(
        failure,
        count,
        failuresByTypes,
        count >= broken_trunk_threshold
      );

      // Reset the count
      failuresCount[failure] = 0;
    });
  });

  Object.keys(failuresCount).forEach((failure: string) => {
    const count = failuresCount[failure];
    // Aggregate all remaining jobs
    updateFailureCount(
      failure,
      count,
      failuresByTypes,
      count >= broken_trunk_threshold
    );
  });

  return failuresByTypes;
}

export function approximateFailureByTypePercent(
  // The data from Rockset is sorted by time DESC, so newer commits come first
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

  // Get the number of times the job successes too, so we can calculate the %
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
