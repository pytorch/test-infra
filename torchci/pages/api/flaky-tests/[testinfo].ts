import type { NextApiRequest, NextApiResponse } from "next";
import fetchFlakyTests from "lib/fetchFlakyTests";
import { FlakyTestData } from "lib/types";

interface Data {}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  // Expect testinfo to be /testName%20testSuite%20testFile
  const testinfo = req.query.testinfo;

  let numHours = "336";  // representing 14 days = 14x24 hours
  let testName = "%";
  let testSuite = "%";
  let testFile = "%";

  if (testinfo !== undefined && testinfo.length > 0) {
    if (typeof testinfo === 'string') {
        const testInfo = testinfo.split(/\s+/);
        testName = testInfo.length >= 1 ? testInfo[0] : "%";
        testSuite = testInfo.length >= 2 ? testInfo[1] : "%";
        testFile = testInfo.length >= 3 ? testInfo[2] : "%";
    }
  }

  const flakyTests: FlakyTestData[] = await fetchFlakyTests(numHours, testName, testSuite, testFile);

  res.status(200).json({
      flakyTests: flakyTests
    });
}
