import { GroupedJobStatus, JobStatus } from "components/GroupJobConclusion";
import { GroupData, RowData } from "./types";

export const groups = [
  {
    regex: /mem_leak_check/,
    name: "Memory Leak Check",
    persistent: true,
  },
  {
    regex: /rerun_disabled_tests/,
    name: "Rerun Disabled Tests",
    persistent: true,
  },
  {
    regex: /Lint/,
    name: "Lint Jobs",
  },
  {
    regex: /inductor/,
    name: "Inductor",
  },
  {
    regex: /android/,
    name: "Android",
  },
  {
    regex: /rocm/,
    name: "ROCm",
  },
  {
    regex: /-xla/,
    name: "XLA",
  },
  {
    regex: /(\slinux-|sm86)/,
    name: "Linux",
  },
  {
    regex: /linux-binary/,
    name: "Binary Linux",
  },
  {
    regex: /windows-binary/,
    name: "Binary Windows",
  },
  {
    regex:
      /(Add annotations )|(Close stale pull requests)|(Label PRs & Issues)|(Triage )|(Update S3 HTML indices)|(is-properly-labeled)|(Facebook CLA Check)|(auto-label-rocm)/,
    name: "Annotations and labeling",
  },
  {
    regex:
      /(ci\/circleci: docker-pytorch-)|(ci\/circleci: ecr_gc_job_)|(ci\/circleci: docker_for_ecr_gc_build_job)|(Garbage Collect ECR Images)/,
    name: "Docker",
  },
  {
    regex: /\swin-/,
    name: "Windows",
  },
  {
    regex: / \/ calculate-docker-image/,
    name: "GitHub calculate-docker-image",
  },
  {
    regex: /docker-builds/,
    name: "CI Docker Image Builds",
  },
  {
    regex: /ci\/circleci: pytorch_ios_/,
    name: "ci/circleci: pytorch_ios",
  },
  {
    regex: /ios-/,
    name: "iOS",
  },
  {
    regex: /\smacos-/,
    name: "Mac",
  },
  {
    regex:
      /(ci\/circleci: pytorch_parallelnative_)|(ci\/circleci: pytorch_paralleltbb_)|(paralleltbb-linux-)|(parallelnative-linux-)/,
    name: "Parallel",
  },
  {
    regex: /(docs push)|(docs build)/,
    name: "Docs",
  },
  {
    regex: /libtorch/,
    name: "libtorch",
  },
];

export function classifyGroup(jobName: string): string {
  for (const group of groups) {
    if (jobName.match(group.regex)) {
      return group.name;
    }
  }
  return "other";
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
      return "O";
    case GroupedJobStatus.Classified:
      return "X";
    case GroupedJobStatus.Flaky:
      return "F";
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
export function getConclusionChar(conclusion?: string, failedPreviousRun?: boolean): string {
  switch (conclusion) {
    case JobStatus.Success:
      if (failedPreviousRun) {
        return "F"
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
      return "O";
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
