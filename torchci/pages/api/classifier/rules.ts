import type { NextApiRequest, NextApiResponse } from "next";

// Guidelines for writing rules:
// - Start with ^ if you can, it makes filtering out non-matching lines faster.
// - Try to make sure the produced "captures" field is useful:
//   - It should have enough information to identify the failure.
//   - It should be groupable; e.g. there should be no random noise in the capture group.
// - If no capture groups are specified, the "captures" field is the whole match.
//
// - Try to match against as much information as possible, so that captures are interesting.
//     For example, instead of 'error: ', do 'error: .*'
// - You can use capture groups to filter out line noise, so that we can aggregate on captures.
//     For example, for the failure 'FAIL [10.2s]: test_foo', 'test_foo' is a
//     good capture group, as it filters out test timings which might be
//     variable.
interface Rule {
  name: string;
  pattern: string;
  priority: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Array<Rule>>
) {
  const r = String.raw;
  res
    .status(200)
    .setHeader("Cache-Control", "s-maxage=60")
    .json([
      {
        name: "Operator backwards compatibility",
        pattern: r`^The PR is introducing backward incompatible changes to the operator library.`,
        priority: 1006,
      },
      {
        name: "Lintrunner failure",
        pattern: r`^>>> Lint for.*`,
        priority: 1005,
      },
      {
        name: "GHA timeout",
        pattern: r`^##\[error\]The action has timed out.`,
        priority: 1004,
      },
      {
        name: "GHA cancellation",
        pattern:
          "The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.",
        priority: 1003,
      },
      {
        name: "bazel build failure",
        pattern: r`^Target \/\/:\w+ failed to build`,
        priority: 1002,
      },
      {
        name: "gtest failure",
        pattern: r`(^\[  FAILED  \].*) \(\d+`,
        priority: 1001,
      },
      {
        name: "No trailing spaces",
        pattern: r`^The above lines have trailing spaces; please remove them`,
        priority: 1000,
      },
      {
        name: "GitHub workflows weren't regenerated",
        pattern: r`^As shown by the above diff, the committed \.github\/workflows`,
        priority: 1000,
      },
      {
        name: "Docker image push failure",
        pattern: r`^name unknown: The repository with name '.*' does not exist in the registry`,
        priority: 1001,
      },
      {
        name: "Windows PyLong API usage check",
        pattern: r`^Usage of PyLong_{From,As}{Unsigned}Long API may lead to overflow errors on Windows`,
        priority: 1001,
      },
      {
        name: "npm error",
        pattern: r`^npm ERR! code .*`,
        priority: 1001,
      },
      {
        name: "NVIDIA installation failure",
        pattern: r`^ERROR: Installation has failed.*?nvidia`,
        priority: 1000,
      },
      {
        name: "Bazel build failure",
        pattern: r`^FAILED: Build did NOT complete successfully`,
        priority: 999,
      },
      {
        name: "Python unittest failure",
        pattern: r`FAIL \[.*\]: (test.*) \((?:__main__\.)?(.*)\)`,
        priority: 998,
      },
      {
        name: "Python unittest error",
        pattern: r`ERROR \[.*\]: (test.*) \((?:__main__\.)?(.*)\)`,
        priority: 997,
      },
      {
        name: "failed to download github artifacts",
        pattern: r`List Artifacts failed:.*`,
        priority: 997,
      },
      {
        name: "MSVC out of memory",
        pattern: r`Catastrophic error: .*`,
        priority: 996,
      },
      {
        name: "MSVC compiler error",
        pattern: r`^.*\(\d+\): error C\d+:.*`,
        priority: 995,
      },
      {
        name: "MSVC compiler fatal",
        pattern: r`^.*\(\d+\): fatal error C\d+:.*`,
        priority: 995,
      },
      {
        name: "Compile error",
        pattern: r`^.*\d+:\d+: error: .*`,
        priority: 994,
      },
      {
        name: "MSVC mt.exe manifest error",
        pattern: r`^mt.exe : general error c101008d: Failed to write the updated manifest to the resource of file`,
        priority: 994,
      },
      {
        name: "Curl error",
        pattern: r`curl: .* error:`,
        priority: 993,
      },
      {
        name: "Dirty checkout",
        pattern: r`^Build left local git repository checkout dirty`,
        priority: 992,
      },
      {
        name: "Docker manifest error",
        pattern: r`^ERROR: Something has gone wrong and the previous image isn't available for the merge-base of your branch`,
        priority: 991,
      },
      {
        name: "flake8 error",
        pattern: r`^.*:\d+:\d: [EBFW]\d+ .*`,
        priority: 800,
      },
      {
        name: "apt-get update failure",
        pattern: r`^E: Failed to fetch.*`,
        priority: 799,
      },
      {
        name: "Dependency fetch error",
        pattern: r`^Error downloading packages:`,
        priority: 700,
      },
      {
        name: "ASAN failure",
        pattern: r`^AddressSanitizer:DEADLYSIGNAL`,
        priority: 699,
      },
      {
        name: "undefined reference linker error",
        pattern: r`undefined reference to .*`,
        priority: 200,
      },
      {
        name: "Python AttributeError",
        pattern: r`^AttributeError: .*`,
        priority: 100,
      },
      {
        name: "CUDA out of memory error",
        pattern: r`^RuntimeError: CUDA out of memory.`,
        priority: 100,
      },
      {
        name: "Python RuntimeError",
        pattern: r`^RuntimeError: .*`,
        priority: 99,
      },
      {
        name: "Python ModuleNotFoundError",
        pattern: r`^ModuleNotFoundError: .*`,
        priority: 98,
      },
      {
        name: "Python ImportError",
        pattern: r`^ImportError: .*`,
        priority: 97,
      },
      {
        name: "Docker login failure",
        pattern: r`Docker login for '.*' failed.*`,
        priority: 96,
      },
      {
        name: "conda failure",
        pattern: r`An unexpected error has occurred. Conda has prepared the above report.`,
        priority: 95,
      },
      {
        name: "GHA error",
        pattern: r`^##\[error\](.*)`,
        priority: 94,
      },
    ]);
}
