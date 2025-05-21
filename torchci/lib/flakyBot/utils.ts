import { retryRequest } from "lib/bot/utils";
import { FlakyTestData } from "lib/types";
import _ from "lodash";

export const NUM_HOURS_NOT_UPDATED_BEFORE_CLOSING = 24 * 14; // 2 weeks
export const supportedPlatforms = new Map([
  ["asan", []],
  ["linux", []],
  ["mac", ["module: macos"]],
  ["macos", ["module: macos"]],
  ["rocm", ["module: rocm"]],
  ["slow", []],
  ["win", ["module: windows"]],
  ["windows", ["module: windows"]],
  ["dynamo", ["oncall: pt2"]],
  ["inductor", ["oncall: pt2"]],
]);

export function getPlatformsAffected(workflowJobNames: string[]): string[] {
  const platformsToSkip: string[] = [];
  Array.from(supportedPlatforms.keys()).forEach((platform: string) =>
    workflowJobNames.forEach((workflowJobNames) => {
      if (
        workflowJobNames.includes(platform) &&
        (platform == "rocm" || !workflowJobNames.includes("rocm")) &&
        !workflowJobNames.includes("dynamo") &&
        !workflowJobNames.includes("inductor") &&
        !platformsToSkip.includes(platform)
      ) {
        platformsToSkip.push(platform);
      }
    })
  );

  // dynamo and inductor are subsets of linux, so only include them if linux is
  // not present as a disable platform
  if (!platformsToSkip.includes("linux")) {
    if (workflowJobNames.some((name) => name.includes("dynamo"))) {
      platformsToSkip.push("dynamo");
    }
    if (workflowJobNames.some((name) => name.includes("inductor"))) {
      platformsToSkip.push("inductor");
    }
  }

  return platformsToSkip;
}

export function getPlatformLabels(platforms: string[]): string[] {
  let labels = undefined;
  for (const platform of platforms) {
    if (labels === undefined) {
      labels = supportedPlatforms.get(platform);
    } else if (!_.isEqual(supportedPlatforms.get(platform), labels)) {
      return [];
    }
  }
  return labels ?? [];
}

export async function getTestOwnerLabels(
  test: FlakyTestData
): Promise<{ labels: string[]; additionalErrMessage?: string }> {
  const urlkey = "https://raw.githubusercontent.com/pytorch/pytorch/main/test/";

  let labels: string[] = [];
  let additionalErrMessage = undefined;

  try {
    let result = await retryRequest(`${urlkey}${test.file}`);
    let statusCode = result.res.statusCode;
    if (statusCode !== 200) {
      result = await retryRequest(`${urlkey}${test.invoking_file}.py`);
      if (result.res.statusCode !== 200) {
        throw new Error(
          `Error retrieving ${test.file}: ${statusCode}, ${test.invoking_file}: ${result.res.statusCode}`
        );
      }
    }
    const fileContents = result.data.toString(); // data is a Buffer
    const lines = fileContents.split(/[\r\n]+/);
    const prefix = "# Owner(s): ";
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        labels = labels.concat(JSON.parse(line.substring(prefix.length)));
        break;
      }
    }
    console.log(labels);
  } catch (err) {
    console.warn(err);
    additionalErrMessage = `${err}`;
  }

  labels.push(
    ...getPlatformLabels(getPlatformsAffected(getWorkflowJobNames(test)))
  );

  if (labels.length === 0) {
    labels.push("module: unknown");
  }

  if (
    labels.some((x) => x.startsWith("module: ") && x !== "module: unknown") &&
    !labels.includes("oncall: pt2")
  ) {
    // Add triaged if there is a module label and none of labels are oncall: pt2
    // (see https://github.com/pytorch/pytorch/issues/117846)
    labels.push("triaged");
  }
  return { labels, additionalErrMessage };
}

export function getLatestTrunkJobURL(test: FlakyTestData): string {
  let index = test.branches.lastIndexOf("master");
  if (index < 0) {
    index = test.branches.lastIndexOf("main");
    if (index < 0) {
      console.warn(
        `Flaky test ${test.name} has no trunk failures. Disabling anyway, but this may be unintended.`
      );
      index = test.workflowIds.length - 1;
    }
  }
  return `https://github.com/pytorch/pytorch/runs/${test.jobIds[index]}`;
}

export function getWorkflowJobNames(test: FlakyTestData): string[] {
  return test.workflowNames.map(
    (value, index) => `${value} / ${test.jobNames[index]}`
  );
}
