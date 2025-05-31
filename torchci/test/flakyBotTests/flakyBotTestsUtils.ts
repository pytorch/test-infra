import dayjs from "dayjs";
import { __forTesting__ as aggregateDisableIssue } from "lib/flakyBot/aggregateDisableIssue";
import { getPlatformsAffected } from "lib/flakyBot/utils";
import { FlakyTestData, IssueData } from "lib/types";
import nock from "nock";

// This file contains utils and mock data for flaky bot tests. I think if you
// import from one test file to another, it will also run the tests from the
// imported file, so instead we put reused things here.

export function genValidFlakyTest(
  input: Partial<FlakyTestData>
): FlakyTestData {
  return {
    name: "test_name",
    suite: "test_suite",
    file: "test_file.py",
    invoking_file: "test_folder.test_file",
    jobNames: ["linux1", "linux2", "linux3"],
    jobIds: [111, 222, 333],
    workflowIds: ["11", "22", "33"],
    workflowNames: ["workflow_name1", "workflow_name2", "workflow_name3"],
    eventTimes: [
      dayjs().subtract(1, "hour").toISOString(),
      dayjs().subtract(2, "hour").toISOString(),
      dayjs().subtract(3, "hour").toISOString(),
    ],
    branches: ["master", "master", "master"],
    ...input,
  };
}

export const flakyTestA = genValidFlakyTest({
  file: "file_a.py",
  invoking_file: "file_a",
  suite: "suite_a",
  name: "test_a",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647"],
  workflowNames: ["trunk", "periodic", "periodic"],
  jobIds: [55443322, 55667788, 56789876],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
  ],
  branches: ["master", "master", "master"],
});

export const flakyTestB = genValidFlakyTest({
  file: "file_b.py",
  invoking_file: "file_b",
  suite: "suite_b",
  name: "test_b",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647"],
  workflowNames: [
    "win-cpu-vs-2019",
    "periodic-win-cuda11.3-vs-2019",
    "periodic-win-cuda11.3-vs-2019",
  ],
  jobIds: [55443322, 55667788, 56789876],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
    "win-cuda11.3-vs-2019 / test",
  ],
  branches: ["main", "main", "main"],
});

export const flakyTestE = genValidFlakyTest({
  file: "file_e.py",
  invoking_file: "file_e",
  suite: "suite_e",
  name: "test_e",
  numGreen: 4,
  numRed: 2,
  workflowIds: ["12345678", "13456789", "14253647", "15949539"],
  workflowNames: ["pull", "periodic", "trunk", "pull"],
  jobIds: [55443322, 55667788, 56789876, 56677889],
  jobNames: [
    "win-cpu-vs-2019 / test",
    "linux-xenial-cuda11.5-py3 / test",
    "macos-11-x86 / test",
    "win-cpu-vs-2019 / test",
  ],
  branches: ["pr-fix", "master", "master", "another-pr-fx"],
});

export const flakyTestAcrossJobA: FlakyTestData = genValidFlakyTest({
  name: "test_conv1d_vs_scipy_mode_same_cuda_complex64",
  suite: "TestConvolutionNNDeviceTypeCUDA",
  file: "nn/test_convolution.py",
  invoking_file: "nn.test_convolution",
  jobNames: [
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
  ],
  jobIds: [9489898216, 9486287115, 9486287114],
  workflowIds: ["3466924095", "3465587581", "3465587582"],
  workflowNames: ["trunk", "trunk", "trunk"],
  branches: ["master", "master", "master"],
});

export const nonFlakyTestA = {
  name: "test_a",
  classname: "suite_a",
  filename: "file_a.py",
  flaky: false,
  num_green: 50,
  num_red: 0,
};

export const nonFlakyTestZ = {
  name: "test_z",
  classname: "suite_z",
  filename: "file_z.py",
  flaky: false,
  num_green: 50,
  num_red: 0,
};

export function mockGetRawTestFile(file: string, content: string) {
  return nock("https://raw.githubusercontent.com")
    .get(`/pytorch/pytorch/main/test/${file}`)
    .reply(200, Buffer.from(content));
}

export function genSingleIssueFor(
  test: FlakyTestData,
  input: Partial<IssueData>
): IssueData {
  return {
    number: 1,
    title: `DISABLED ${test.name} (__main__.${test.suite})`,
    html_url: "test url",
    state: "open" as "open" | "closed",
    body: `Platforms: ${getPlatformsAffected(test.jobNames)}`,
    updated_at: dayjs().subtract(4, "hour").toString(),
    author_association: "MEMBER",
    labels: [],
    ...input,
  };
}

export function genAggTests(test: FlakyTestData) {
  return Array.from({ length: 11 }, (_, i) =>
    genValidFlakyTest({
      ...test,

      name: `test_${i}`,
      suite: `suite_${i}`,
    })
  );
}

export function genAggIssueFor(
  tests: FlakyTestData[],
  input: Partial<IssueData>
): IssueData {
  return {
    number: 1,
    title: aggregateDisableIssue.getTitle(tests[0]),
    html_url: "test url",
    state: "open" as "open" | "closed",
    body: aggregateDisableIssue.getBody(tests),
    updated_at: dayjs().subtract(4, "hour").toString(),
    author_association: "MEMBER",
    labels: [],
    ...input,
  };
}
