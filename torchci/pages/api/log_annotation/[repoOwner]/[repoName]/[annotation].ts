import { getDynamoClient } from "lib/dynamo";
import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { getOctokit } from "lib/github";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    res.status(504).end();
    return;
  }
  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (session === undefined || session === null || session.user === undefined) {
    res.status(401).end();
    return;
  }

  const { repoOwner, repoName, annotation } = req.query;
  const repoOwnerStr = Array.isArray(repoOwner) ? repoOwner[0] : repoOwner!;
  const repoNameStr = Array.isArray(repoName) ? repoName[0] : repoName!;
  const octokit = await getOctokit(repoOwnerStr, repoNameStr);
  const user = await octokit.rest.users.getAuthenticated();
  const hasPermission = hasWritePermissionsUsingOctokit(
    octokit,
    user.data.login,
    repoOwnerStr,
    repoNameStr
  );
  if (!hasPermission) {
    res.status(401).end();
    return;
  }
  const log_metadata = JSON.parse(req.body) ?? [];
  const client = getDynamoClient();
  const jobId = log_metadata[0].job_id;
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
    item["annotationAuthor"] = user.data.login;
    item["annotationLogMetadata"] = log_metadata;
    item["metricType"] = "log_annotation";
  }

  await client.put({
    TableName: "torchci-job-annotation",
    Item: item,
  });
  return;
}
