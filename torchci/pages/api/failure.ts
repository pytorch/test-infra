import dayjs from "dayjs";
import { NEWEST_FIRST, querySimilarFailures } from "lib/searchUtils";
import _, { isEqual } from "lodash";
import type { NextApiRequest, NextApiResponse } from "next";

interface Data {}

// The maximum number of records to be returned by `more like this` failure search
const MAX_SIZE = 1000;
const LOOKBACK_PERIOD_IN_HOURS = 14 * 24;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const name = req.query.name as string;
  const jobName = req.query.jobName as string;
  const failureCaptures = JSON.parse(
    req.query.failureCaptures as string
  ) as string[];
  const useFuzzySearch = req.query.useFuzzySearch as string;

  // The current HUD page shows the last 14 days. Newer results are preferred
  // here, thus NEWEST_FIRST
  const samples = await querySimilarFailures({
    name,
    jobName,
    failure_captures: failureCaptures,
    startDate: dayjs().subtract(LOOKBACK_PERIOD_IN_HOURS, "hour"),
    endDate: dayjs(),
    maxSize: MAX_SIZE,
    sortByTimeStamp: NEWEST_FIRST,
  });

  // NB: This filter step keeps only exact matchs of the failure, this is the current
  // behavior. However, we could consider remove this so that "slightly" different
  // failures could be included too, like a normal search engine
  const filteredSamples =
    useFuzzySearch === "true"
      ? samples
      : _.filter(samples, (sample) =>
          isEqual(sample.failureCaptures, failureCaptures)
        );

  const jobCount: {
    [jobName: string]: number;
  } = {};

  for (const result of filteredSamples) {
    if (result.name !== undefined) {
      jobCount[result.name] = (jobCount[result.name] || 0) + 1;
    }
  }
  res.status(200).json({
    jobCount,
    totalCount: filteredSamples.length,
    samples: filteredSamples,
  });
}
