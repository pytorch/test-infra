import nock from "nock";

// This file contains utils and mock data for flaky bot tests. I think if you
// import from one test file to another, it will also run the tests from the
// imported file, so instead we put reused things here.

export const flakyTestA = {
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
};

export const flakyTestB = {
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
};

export const flakyTestE = {
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
};

export const flakyTestAcrossJobA = {
  name: "test_conv1d_vs_scipy_mode_same_cuda_complex64",
  suite: "TestConvolutionNNDeviceTypeCUDA",
  file: "nn/test_convolution.py",
  invoking_file: "nn.test_convolution",
  jobNames: [
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
    "linux-focal-rocm5.2-py3.8 / test (default, 1, 2, linux.rocm.gpu)",
  ],
  jobIds: [9489898216, 9486287115],
  workflowIds: ["3466924095", "3465587581"],
  workflowNames: ["trunk", "trunk"],
  runAttempts: [1, 1],
  eventTimes: ["2022-11-15T02:52:20.311000Z", "2022-11-14T22:30:34.492000Z"],
  branches: ["master", "master"],
};

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
