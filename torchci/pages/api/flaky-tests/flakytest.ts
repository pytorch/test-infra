import type { NextApiRequest, NextApiResponse } from "next";
import fetchFlakyTests from "lib/fetchFlakyTests";
import { FlakyTestData, JobData } from "lib/types";
import fetchFailureSamples from "lib/fetchFailureSamples";

interface Data {}

export function getFlakyTestCapture(flakyTest: FlakyTestData): string {
  return `${flakyTest.name}, ${flakyTest.suite}`;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const name = req.query.name;
  const suite = req.query.suite;
  const file = req.query.file;

  let numHours = 30 * 24 + "";

  const flakyTests: FlakyTestData[] = await fetchFlakyTests(
    numHours,
    name as string,
    suite as string,
    file as string
  );

  // capture looks like: testName, testSuite
  const flakySamples: {
    [capture: string]: JobData[];
  } = {};

  // only get log view for at most 5 flaky tests (to not spam query calls)
  console.debug(`Retrieved ${flakyTests.length} flaky tests`);
  if (flakyTests.length <= 5) {
    const unfulfilledPromises = flakyTests.map(function (flakyTest) {
      return fetchFailureSamples(getFlakyTestCapture(flakyTest));
    });

    const results = await Promise.all(unfulfilledPromises);
    results.forEach((samples, index) => {
      flakySamples[getFlakyTestCapture(flakyTests[index])] = samples;
    });
  }

  res.status(200).json({ flakyTests, flakySamples });
}
