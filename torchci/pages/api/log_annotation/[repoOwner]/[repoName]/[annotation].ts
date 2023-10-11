import { NextApiRequest, NextApiResponse } from "next";
import { getDynamoClient } from "lib/dynamo";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";
import { getOctokit } from "lib/github";
// import { hasWritePermissionsUsingOctokit } from "lib/bot/utils";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(504).end();
  }
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (session === undefined || session === null || session.user === undefined) {
    return res.status(401).end();
  }

  const { repoOwner, repoName, annotation, log_metadata } = req.query;
  const octokit = await getOctokit(repoOwner, repoName);
  // const hasPermission = hasWritePermissionsUsingOctokit(
  //   octokit,
  //   session.user.login,
  //   repoOwner,
  //   repoName,
  // );
  // if (!hasPermission) {
  //   return res.status(401).end();
  // }

  const client = getDynamoClient();
  // The request body contains an optional list of similar failures. If the list
  // exists, the API will annotate all failures in the list with the same annotation
  const jobIds = JSON.parse(req.body) ?? [];

  const queries = jobIds.map((jobId: any) => {
    const dynamoKey = `${repoOwner}/${repoName}/${jobId}`;

    const item: any = {
      dynamoKey,
      repo: `${repoOwner}/${repoName}`,
      jobID: parseInt(jobId as string),
    };

    // TODO: we encode annotations as a string, but probably we want to just
    // serialize a JSON object instead to avoid this silly special case.
    if (annotation !== "null") {
      item["annotationDecision"] = annotation;
      item["annotationTime"] = new Date().toISOString();
      item["annotationAuthor"] = session.user.login;
      item["annotationLogMetadata"] = log_metadata;
      item["metricType"] = "log_annotation";
    }

    return client.put({
      TableName: "torchci-job-annotation",
      Item: item,
    });
  });

  if (queries.length > 0) {
    await Promise.all(queries);
  }

  return res.status(200).end();
}
