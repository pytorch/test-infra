import { extractCiFlowPrNumber } from "../src/github-utils";

import { expect, test } from "@jest/globals";

test("[tag] with ciflow tag", async () => {
  const prNumber = extractCiFlowPrNumber("refs/tags/ciflow/all/12345");
  expect(prNumber).toBe(12345);
});

test("[tag] no ciflow tag", async () => {
  const prNumber = extractCiFlowPrNumber("refs/tags/v1.11.0");
  expect(prNumber).toBe(NaN);
});

test("[branch] no ciflow tag", async () => {
  const prNumber = extractCiFlowPrNumber("refs/branch/master");
  expect(prNumber).toBe(NaN);
});

test("[branch] no ciflow tag, but named ciflow", async () => {
  const prNumber = extractCiFlowPrNumber("refs/branch/ciflow_fix");
  expect(prNumber).toBe(NaN);
});

test("garbage reference", async () => {
  const prNumber = extractCiFlowPrNumber(
    "748392174890157sfghalyr7083qovszlkghvlav"
  );
  expect(prNumber).toBe(NaN);
});
