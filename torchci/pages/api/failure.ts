import type { NextApiRequest, NextApiResponse } from "next";
import fetchFailureSamples from "lib/fetchFailureSamples";
import { querySimilarFailures } from "lib/drciUtils";
import { NEWEST_FIRST } from "lib/searchUtils";
import dayjs from "dayjs";
import { RecentWorkflowsData } from "lib/types";
import _ from "lodash";
import { isEqual } from "lodash";

interface Data {}

// The maximum number of records to be returned by `more like this` failure search
const MAX_SIZE = 1000;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  const name = req.query.name as string;
  const jobName = req.query.jobName as string;
  const failureCaptures = JSON.parse(req.query.failureCaptures as string);
  const useFuzzySearch = req.query.useFuzzySearch as string;

  // Create a mock record to use as the input for querySimilarFailures.
  const failure: RecentWorkflowsData = {
    jobName: jobName,
    name: name,
    completed_at: dayjs().toString(),
    failure_captures: failureCaptures,
    failure_lines: failureCaptures,
    // Anything goes here, it doesn't matter in this use case
    id: "1",
    html_url: "",
    head_sha: "",
  };

  // The current HUD page shows the last 14 days. Newer results are preferred
  // here, thus NEWEST_FIRST
  const lookbackPeriodInHours = 14 * 24;
  const samples = await querySimilarFailures(
    failure,
    "",
    lookbackPeriodInHours,
    MAX_SIZE,
    NEWEST_FIRST
  );

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
