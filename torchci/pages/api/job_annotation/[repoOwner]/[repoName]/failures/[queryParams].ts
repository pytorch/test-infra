import { queryClickhouseSaved } from "lib/clickhouse";
import { getDynamoClient } from "lib/dynamo";
import { JobData } from "lib/types";
import { NextApiRequest, NextApiResponse } from "next";

async function fetchFailureJobs(queryParams: {
  [key: string]: any;
}): Promise<JobData[]> {
  return await queryClickhouseSaved("failed_workflow_jobs", queryParams);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const client = getDynamoClient();
  const { queryParams, repoOwner, repoName } = req.query;

  if (queryParams === undefined) {
    return res.status(200).json({});
  }

  // When querying all failed jobs here, we have already included all jobs
  // that have been annotated
  const failedJobs = await fetchFailureJobs(JSON.parse(queryParams as string));
  const queries = failedJobs.map((failedJob: JobData) => {
    return client.get({
      TableName: "torchci-job-annotation",
      Key: { dynamoKey: `${repoOwner}/${repoName}/${failedJob.id}` },
    });
  });

  if (queries.length > 0) {
    const results = await Promise.all(queries);
    const annotations = results
      .map((annotation) => annotation.Item)
      .filter((item) => item != null);
    const annotationsMap: any = {};

    for (const annotation of annotations) {
      annotationsMap[annotation!.jobID] = annotation;
    }

    // For this API, return both the list of failed jobs and their annotations
    return res.status(200).json({
      failedJobs: failedJobs,
      annotationsMap: annotationsMap,
    });
  } else {
    return res.status(200).json({});
  }
}
