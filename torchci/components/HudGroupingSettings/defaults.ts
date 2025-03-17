import { Group } from "components/HudGroupingSettings/mainPageSettingsUtils";

const GROUP_MEMORY_LEAK_CHECK = "Memory Leak Check";
const GROUP_RERUN_DISABLED_TESTS = "Rerun Disabled Tests";
export const GROUP_UNSTABLE = "Unstable";
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
export const GROUP_OTHER = "other";

// Jobs will be grouped with the first regex they match in this list
const groups = [
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
  GROUP_ANNOTATIONS_AND_LABELING,
  GROUP_OTHER,
  GROUP_BINARY_WINDOWS,
  GROUP_MEMORY_LEAK_CHECK,
  GROUP_RERUN_DISABLED_TESTS,
  GROUP_UNSTABLE,
];

export function getDefaultGroupSettings(): Group[] {
  return groups.map((g, i) => {
    return {
      name: g.name,
      regex: g.regex,
      filterPriority: i,
      displayPriority: HUD_GROUP_SORTING.indexOf(g.name),
      persistent: g.persistent ?? false,
    };
  });
}
