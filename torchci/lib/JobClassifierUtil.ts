import { GroupedJobStatus, JobStatus } from "components/GroupJobConclusion";
import { GroupData, RowData } from "./types";

const GROUP_MEMORY_LEAK_CHECK = "Memory Leak Check";
const GROUP_RERUN_DISABLED_TESTS = "Rerun Disabled Tests";
const GROUP_UNSTABLE = "Unstable";
const GROUP_PERIODIC = "Periodic";
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
    regex: /mem_leak_check/,
    name: GROUP_MEMORY_LEAK_CHECK,
    persistent: true,
  },
  {
    regex: /rerun_disabled_tests/,
    name: GROUP_RERUN_DISABLED_TESTS,
    persistent: true,
  },
  {
    regex: /unstable/,
    name: GROUP_UNSTABLE,
    persistent: true,
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
  GROUP_MEMORY_LEAK_CHECK,
  GROUP_CALC_DOCKER_IMAGE,
  GROUP_CI_DOCKER_IMAGE_BUILDS,
  GROUP_CI_CIRCLECI_PYTORCH_IOS,
  GROUP_PERIODIC,
  GROUP_SLOW,
  GROUP_DOCS,
  GROUP_RERUN_DISABLED_TESTS,
  GROUP_INDUCTOR,
  GROUP_ANNOTATIONS_AND_LABELING,
  GROUP_OTHER,
  GROUP_BINARY_WINDOWS,
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

export function classifyGroup(jobName: string): string {
  for (const group of groups) {
    if (jobName.match(group.regex)) {
      return group.name;
    }
  }
  return GROUP_OTHER;
}

export function getGroupConclusionChar(conclusion?: GroupedJobStatus): string {
  switch (conclusion) {
    case GroupedJobStatus.Success:
      return "O";
    case GroupedJobStatus.Failure:
      return "X";
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
    case JobStatus.Pending:
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
    case JobStatus.Pending:
      return 4;
    case undefined:
      return 5;
    case JobStatus.Failure:
      return 6;
    default:
      return 7;
  }
}

export function getGroupingData(shaGrid: RowData[], jobNames: string[]) {
  // Construct Job Groupping Mapping
  const groupNameMapping = new Map<string, Array<string>>(); // group -> [jobs]
  const jobToGroupName = new Map<string, string>(); // job -> group
  for (const name of jobNames) {
    const groupName = classifyGroup(name);
    const jobsInGroup = groupNameMapping.get(groupName) ?? [];
    jobsInGroup.push(name);
    groupNameMapping.set(groupName, jobsInGroup);
    jobToGroupName.set(name, groupName);
  }
  const groupNamesArray = Array.from(groupNameMapping.keys());

  // Group Jobs per Row
  for (const row of shaGrid) {
    const groupedJobs = new Map<string, GroupData>();
    for (const groupName of groupNamesArray) {
      groupedJobs.set(groupName, { groupName, jobs: [] });
    }
    for (const job of row.jobs) {
      const groupName = jobToGroupName.get(job.name!)!;
      groupedJobs.get(groupName)!.jobs.push(job);
    }
    row.groupedJobs = groupedJobs;
  }
  return { shaGrid, groupNameMapping };
}

export function isPersistentGroup(name: string) {
  return (
    groups.filter((group) => group.name == name && group.persistent).length !==
    0
  );
}

export function isUnstableGroup(name: string) {
  return (
    name.toLocaleLowerCase().includes("unstable") ||
    name === GROUP_BINARY_WINDOWS
  );
}
