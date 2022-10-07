import { getDynamoClient } from "lib/dynamo";
import { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const client = getDynamoClient();
  const { jobIds, repoOwner, repoName } = req.query;
  const jobIdsArr = JSON.parse(jobIds as string);
  const queries = jobIdsArr.map((jobId: any) => {
    return client.get({
      TableName: "torchci-job-annotation",
      Key: { dynamoKey: `${repoOwner}/${repoName}/${jobId}` },
    });
  });

  if (queries.length > 0) {
    let annotations = await Promise.all(queries);
    annotations = annotations
      .map((annotation) => annotation.Item)
      .filter((item) => item != null);
    const annotationsMap: any = {};

    for (const annotation of annotations) {
      annotationsMap[annotation.jobID] = annotation;
    }
    return res.status(200).json(annotationsMap);
  } else {
    return res.status(200).json({});
  }
}
