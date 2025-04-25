import { GroupedJobStatus, JobStatus } from "components/GroupJobConclusion";
import { getOpenUnstableIssues } from "lib/jobUtils";
import { IssueData, RowData } from "./types";

const GROUP_MEMORY_LEAK_CHECK = "Memory Leak Check";
const GROUP_RERUN_DISABLED_TESTS = "Rerun Disabled Tests";
const GROUP_UNSTABLE = "Unstable";
const GROUP_PERIODIC = "Periodic";
const GROUP_INDUCTOR_PERIODIC = "Inductor Periodic";
const GROUP_SLOW = "Slow";
const GROUP_LINT = "Lint";
const GROUP_INDUCTOR = "Inductor";
const GROUP_ANDROID = "Android";
const GROUP_ROCM = "ROCm";
const GROUP_XLA = "XLA";
const GROUP_LINUX = "Linux";
const GROUP_BINARY_LINUX = "Binary Linux";
const GROUP_BINARY_WINDOWS = "Binary Windows";
const GROUP_ANNOTATIONS_AND_LABELING = "Annotations and labeling";
const GROUP_DOCKER = "Docker";
const GROUP_WINDOWS = "Windows";
const GROUP_CALC_DOCKER_IMAGE = "GitHub calculate-docker-image";
const GROUP_CI_DOCKER_IMAGE_BUILDS = "CI Docker Image Builds";
const GROUP_CI_CIRCLECI_PYTORCH_IOS = "ci/circleci: pytorch_ios";
const GROUP_IOS = "iOS";
const GROUP_MAC = "Mac";
const GROUP_PARALLEL = "Parallel";
const GROUP_DOCS = "Docs";
const GROUP_LIBTORCH = "Libtorch";
const GROUP_OTHER = "other";

// Jobs will be grouped with the first regex they match in this list
export const groups = [
  {
    // Weird regex because some names are too long and getting cut off
    // TODO: figure out a better way to name the job or filter them
    regex: /, mem_leak/,
    name: GROUP_MEMORY_LEAK_CHECK,
    persistent: true,
  },
  {
    regex: /, rerun_/,
    name: GROUP_RERUN_DISABLED_TESTS,
    persistent: true,
  },
  {
    regex: /unstable/,
    name: GROUP_UNSTABLE,
  },
  {
    regex: /inductor-periodic/,
    name: GROUP_INDUCTOR_PERIODIC,
  },
  {
    regex: /periodic/,
    name: GROUP_PERIODIC,
  },
  {
    regex: /slow/,
    name: GROUP_SLOW,
  },
  {
    regex: /Lint/,
    name: GROUP_LINT,
  },
  {
    regex: /inductor/,
    name: GROUP_INDUCTOR,
  },
  {
    regex: /android/,
    name: GROUP_ANDROID,
  },
  {
    regex: /rocm/,
    name: GROUP_ROCM,
  },
  {
    regex: /-xla/,
    name: GROUP_XLA,
  },
  {
    regex: /(\slinux-|sm86)/,
    name: GROUP_LINUX,
  },
  {
    regex: /linux-binary/,
    name: GROUP_BINARY_LINUX,
  },
  {
    regex: /windows-binary/,
    name: GROUP_BINARY_WINDOWS,
  },
  {
    regex:
      /(Add annotations )|(Close stale pull requests)|(Label PRs & Issues)|(Triage )|(Update S3 HTML indices)|(is-properly-labeled)|(Facebook CLA Check)|(auto-label-rocm)/,
    name: GROUP_ANNOTATIONS_AND_LABELING,
  },
  {
    regex:
      /(ci\/circleci: docker-pytorch-)|(ci\/circleci: ecr_gc_job_)|(ci\/circleci: docker_for_ecr_gc_build_job)|(Garbage Collect ECR Images)/,
    name: GROUP_DOCKER,
  },
  {
    regex: /\swin-/,
    name: GROUP_WINDOWS,
  },
  {
    regex: / \/ calculate-docker-image/,
    name: GROUP_CALC_DOCKER_IMAGE,
  },
  {
    regex: /docker-builds/,
    name: GROUP_CI_DOCKER_IMAGE_BUILDS,
  },
  {
    regex: /ci\/circleci: pytorch_ios_/,
    name: GROUP_CI_CIRCLECI_PYTORCH_IOS,
  },
  {
    regex: /ios-/,
    name: GROUP_IOS,
  },
  {
    regex: /\smacos-/,
    name: GROUP_MAC,
  },
  {
    regex:
      /(ci\/circleci: pytorch_parallelnative_)|(ci\/circleci: pytorch_paralleltbb_)|(paralleltbb-linux-)|(parallelnative-linux-)/,
    name: GROUP_PARALLEL,
  },
  {
    regex: /(docs push)|(docs build)/,
    name: GROUP_DOCS,
  },
  {
    regex: /libtorch/,
    name: GROUP_LIBTORCH,
  },
];

// Jobs on HUD home page will be sorted according to this list, with anything left off at the end
// Reorder elements in this list to reorder the groups on the HUD
const HUD_GROUP_SORTING = [
  GROUP_LINT,
  GROUP_LINUX,
  GROUP_WINDOWS,
  GROUP_IOS,
  GROUP_MAC,
  GROUP_ROCM,
  GROUP_XLA,
  GROUP_PARALLEL,
  GROUP_LIBTORCH,
  GROUP_ANDROID,
  GROUP_BINARY_LINUX,
  GROUP_DOCKER,
  GROUP_CALC_DOCKER_IMAGE,
  GROUP_CI_DOCKER_IMAGE_BUILDS,
  GROUP_CI_CIRCLECI_PYTORCH_IOS,
  GROUP_PERIODIC,
  GROUP_SLOW,
  GROUP_DOCS,
  GROUP_INDUCTOR,
  GROUP_INDUCTOR_PERIODIC,
  GROUP_ANNOTATIONS_AND_LABELING,
  GROUP_OTHER,
  GROUP_BINARY_WINDOWS,
  GROUP_MEMORY_LEAK_CHECK,
  GROUP_RERUN_DISABLED_TESTS,
  GROUP_UNSTABLE,
];

// Accepts a list of group names and returns that list sorted according to
// the order defined in HUD_GROUP_SORTING
export function sortGroupNamesForHUD(groupNames: string[]): string[] {
  let result: string[] = [];
  for (const group of HUD_GROUP_SORTING) {
    if (groupNames.includes(group)) {
      result.push(group);
    }
  }

  // Be flexible in case against any groups were left out of HUD_GROUP_SORTING
  let remaining = groupNames.filter((x) => !result.includes(x));

  result = result.concat(remaining);
  return result;
}

export function classifyGroup(
  jobName: string,
  showUnstableGroup: boolean,
  unstableIssues?: IssueData[]
): string {
  const openUnstableIssues = getOpenUnstableIssues(jobName, unstableIssues);
  let assignedGroup = undefined;
  for (const group of groups) {
    if (jobName.match(group.regex)) {
      assignedGroup = group;
      break;
    }
  }

  // Check if the job has been marked as unstable but doesn't include the
  // unstable keyword.
  if (!showUnstableGroup && assignedGroup?.persistent) {
    // If the unstable group is not being shown, then persistent groups (mem
    // leak check, rerun disabled tests) should not be overwritten
    return assignedGroup.name;
  }

  if (openUnstableIssues !== undefined && openUnstableIssues.length !== 0) {
    return GROUP_UNSTABLE;
  }

  return assignedGroup === undefined ? GROUP_OTHER : assignedGroup.name;
}

export function getGroupConclusionChar(conclusion?: GroupedJobStatus): string {
  switch (conclusion) {
    case GroupedJobStatus.Success:
      return "O";
    case GroupedJobStatus.Failure:
      return "X";
    case GroupedJobStatus.Queued:
      return "Q";
    case GroupedJobStatus.Pending:
      return "?";
    case GroupedJobStatus.AllNull:
      return "~";
    case GroupedJobStatus.Classified:
      return "X";
    case GroupedJobStatus.Flaky:
      return "F";
    case GroupedJobStatus.WarningOnly:
      return "W";
    default:
      return "U";
  }
}

export function isFailure(conclusion?: string): boolean {
  switch (conclusion) {
    case JobStatus.Failure:
    case JobStatus.Cancelled:
    case JobStatus.Timed_out:
      return true;
    case JobStatus.Success:
    case JobStatus.Neutral:
    case JobStatus.Skipped:
    case JobStatus.Queued:
    case JobStatus.Pending:
    case undefined:
    default:
      return false;
  }
}

export function IsJobInProgress(conclusion?: string): boolean {
  switch (conclusion) {
    case JobStatus.Queued:
    case JobStatus.Pending:
      return true;
    case JobStatus.Success:
    case JobStatus.Neutral:
    case JobStatus.Skipped:
    case JobStatus.Failure:
    case JobStatus.Cancelled:
    case JobStatus.Timed_out:
    case undefined:
    default:
      return false;
  }
}

export function getConclusionChar(
  conclusion?: string,
  failedPreviousRun?: boolean
): string {
  switch (conclusion) {
    case JobStatus.Success:
      if (failedPreviousRun) {
        return "F";
      }
      return "O";
    case JobStatus.Failure:
      return "X";
    case JobStatus.Neutral:
      return "N";
    case JobStatus.Cancelled:
      return "C";
    case JobStatus.Timed_out:
      return "T";
    case JobStatus.Skipped:
      return "S";
    case JobStatus.Queued:
      return "Q";
    case JobStatus.Pending:
      return "?";
    case undefined:
      return "~";
    default:
      return "U";
  }
}

export function getConclusionSeverityForSorting(conclusion?: string): number {
  // Returns a severity level for the conclusion.
  // Used to sort jobs by severity
  switch (conclusion) {
    case JobStatus.Success:
      return 0;
    case JobStatus.Skipped:
      return 1;
    case JobStatus.Neutral:
      return 2;
    case JobStatus.Cancelled:
      return 3;
    case JobStatus.Queued:
      return 4;
    case JobStatus.Pending:
      return 5;
    case undefined:
      return 6;
    case JobStatus.Failure:
      return 7;
    default:
      return 8;
  }
}

export function getGroupingData(
  shaGrid: RowData[],
  jobNames: Set<string>,
  showUnstableGroup: boolean,
  unstableIssues?: IssueData[]
) {
  // Construct Job Groupping Mapping
  const groupNameMapping = new Map<string, Array<string>>(); // group -> [job names]

  // Track which jobs have failures
  const jobsWithFailures = new Set<string>();

  // First pass: check failures for each job across all commits
  for (const name of jobNames) {
    // Check if this job has failures in any commit
    const hasFailure = shaGrid.some((row) => {
      const job = row.nameToJobs.get(name);
      return job && isFailure(job.conclusion);
    });

    if (hasFailure) {
      jobsWithFailures.add(name);
    }
  }

  // Second pass: group jobs
  for (const name of jobNames) {
    const groupName = classifyGroup(name, showUnstableGroup, unstableIssues);
    const jobsInGroup = groupNameMapping.get(groupName) ?? [];
    jobsInGroup.push(name);
    groupNameMapping.set(groupName, jobsInGroup);
  }

  // Calculate which groups have failures
  const groupsWithFailures = new Set<string>();
  for (const [groupName, jobs] of groupNameMapping.entries()) {
    if (jobs.some((jobName) => jobsWithFailures.has(jobName))) {
      groupsWithFailures.add(groupName);
    }
  }

  return {
    shaGrid,
    groupNameMapping,
    jobsWithFailures,
    groupsWithFailures,
  };
}

export function isPersistentGroup(name: string) {
  return (
    groups.filter((group) => group.name == name && group.persistent).length !==
    0
  );
}

export function isUnstableGroup(name: string, unstableIssues?: IssueData[]) {
  const openUnstableIssues = getOpenUnstableIssues(name, unstableIssues);
  return (
    name.toLocaleLowerCase().includes("unstable") ||
    (openUnstableIssues !== undefined && openUnstableIssues.length !== 0)
  );
}

export function getNameWithoutLF(name: string) {
  const lfRegex = /, lf\.(ephemeral|linux|windows)/g;
  name = name.replace(lfRegex, ", $1");
  const ephemeralRegex = /, ephemeral\.(linux|windows)/g;
  return name.replace(ephemeralRegex, ", $1");
}
