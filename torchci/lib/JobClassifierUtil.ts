import { GroupedJobStatus, JobStatus } from "components/job/GroupJobConclusion";
import { getOpenUnstableIssues } from "lib/jobUtils";
import { IssueData, RowData } from "./types";
import { Group } from "components/HudGroupingSettings/mainPageSettingsUtils";

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
const GROUP_OTHER_VIABLE_STRICT_BLOCKING = "Other viable/strict blocking";
const GROUP_XPU = "XPU";
const GROUP_VLLM = "vLLM";
const GROUP_OTHER = "other";

// Jobs will be grouped with the first regex they match in this list
export const groups = [
  {
    regex: /vllm/,
    name: GROUP_VLLM,
  },
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
    regex: /^xpu/,
    name: GROUP_XPU,
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
  {
    // This is a catch-all for jobs that are viable but strict blocking
    // Excluding linux-binary-* jobs because they are already grouped further up
    regex: /(pull)|(trunk)/,
    name: GROUP_OTHER_VIABLE_STRICT_BLOCKING,
  },
];


// Accepts a list of group names and returns that list sorted according to
// the order defined in HUD_GROUP_SORTING
export function sortGroupNamesForHUD(
  groupNames: string[],
  groupSettings: Group[]
): string[] {
  let result: string[] = [];
  for (const group of groupSettings.sort(
    (a, b) => a.displayPriority - b.displayPriority
  )) {
    if (groupNames.includes(group.name)) {
      result.push(group.name);
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

export function isPersistentGroup(groups: Group[], name: string) {
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
