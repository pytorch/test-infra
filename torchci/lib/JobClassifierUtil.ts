import { GroupData, RowData } from "./types";

const groups = [
  {
    regex: /Lint/,
    name: "Lint Jobs",
  },
  {
    regex: /(\(periodic-pytorch)|(ci\/circleci: periodic_pytorch)|(^periodic-)/,
    name: "Periodic Jobs",
  },
  {
    regex: /(Linux CI \(pytorch-linux-)|(^linux-)/,
    name: "Linux GitHub Actions",
  },
  {
    regex:
      /(Add annotations )|(Close stale pull requests)|(Label PRs & Issues)|(Triage )|(Update S3 HTML indices)|(codecov\/project)|(Facebook CLA Check)|(auto-label-rocm)/,
    name: "Annotations and labeling",
  },
  {
    regex:
      /(ci\/circleci: docker-pytorch-)|(ci\/circleci: ecr_gc_job_)|(ci\/circleci: docker_for_ecr_gc_build_job)|(Garbage Collect ECR Images)/,
    name: "Docker",
  },
  {
    regex: /(Windows CI \(pytorch-)|(^win-)/,
    name: "Windows GitHub Actions",
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
    regex: /^ios-/,
    name: "iOS Github Actions",
  },
  {
    regex: /^macos-/,
    name: "macOS Github Actions",
  },
  {
    regex:
      /(ci\/circleci: pytorch_parallelnative_)|(ci\/circleci: pytorch_paralleltbb_)|(paralleltbb-linux-)|(parallelnative-linux-)/,
    name: "Parallel",
  },
  {
    regex:
      /(ci\/circleci: pytorch_cpp_doc_build)|(ci\/circleci: pytorch_cpp_doc_test)|(pytorch_python_doc_build)|(pytorch_doc_test)/,
    name: "Docs",
  },
  {
    regex: /ci\/circleci: pytorch_linux_bionic_cuda10_2_cudnn7_py3_9_gcc7_/,
    name: "ci/circleci: pytorch_linux_bionic_cuda10_2_cudnn7_py3_9_gcc7",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_cuda10_2_cudnn7_py3_/,
    name: "ci/circleci: pytorch_linux_xenial_cuda10_2_cudnn7_py3",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_cuda11_1_cudnn8_py3_gcc7_/,
    name: "ci/circleci: pytorch_linux_xenial_cuda11_1_cudnn8_py3_gcc7",
  },
  {
    regex:
      /(ci\/circleci: pytorch_linux_xenial_py3_clang5_android_ndk_r19c_)|(ci\/circleci: pytorch-linux-xenial-py3-clang5-android-ndk-r19c-)/,
    name: "ci/circleci: pytorch_linux_xenial_py3_clang5_android_ndk",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_6_gcc7_build/,
    name: "ci/circleci: pytorch_linux_xenial_py3_clang5_asan_build",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_clang5_mobile_/,
    name: "ci/circleci: pytorch_linux_xenial_py3_clang5_mobile",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_clang7_onnx_/,
    name: "ci/circleci: pytorch_linux_xenial_py3_clang7_onnx",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_clang5_asan_/,
    name: "ci/circleci: pytorch_linux_xenial_py3_clang5_asan",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_6_gcc7_/,
    name: "ci/circleci: pytorch_linux_xenial_py3_6_gcc7",
  },
  {
    regex: /ci\/circleci: pytorch_macos_10_13_py3_/,
    name: "ci/circleci: pytorch_macos_10_13_py3",
  },
  {
    regex: /ci\/circleci: pytorch_linux_xenial_py3_6_gcc5_4_/,
    name: "ci/circleci: pytorch_linux_xenial_py3_6_gcc5_4",
  },
  {
    regex: /ci\/circleci: binary_linux_/,
    name: "ci/circleci: binary_linux",
  },
  {
    regex: /ci\/circleci: binary_macos_/,
    name: "ci/circleci: binary_macos",
  },
  {
    regex: /ci\/circleci: binary_windows_/,
    name: "ci/circleci: binary_windows",
  },
  {
    regex: /(pytorch-linux-bionic-rocm)|(pytorch_linux_bionic_rocm)/,
    name: "ROCm",
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

export function getConclusionChar(conclusion?: string): string {
  let conclusionChar;
  switch (conclusion) {
    case "success":
      conclusionChar = "O";
      break;
    case "failure":
      conclusionChar = "X";
      break;
    case "neutral":
      conclusionChar = "N";
      break;
    case "cancelled":
      conclusionChar = "C";
      break;
    case "timed_out":
      conclusionChar = "T";
      break;
    case "skipped":
      conclusionChar = "S";
      break;
    case "pending":
      conclusionChar = "?";
      break;
    case undefined:
      conclusionChar = "O";
      break;
    default:
      // shouldn't happen
      conclusionChar = "U";
  }
  return conclusionChar;
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
    const groupDataRow: GroupData[] = [];
    for (const groupName of groupNamesArray) {
      groupDataRow.push(groupedJobs.get(groupName)!);
    }
    row.groupedJobs = groupDataRow;
  }
  return { shaGrid, groupNameMapping };
}
