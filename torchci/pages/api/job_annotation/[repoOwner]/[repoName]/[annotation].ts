import { NextApiRequest, NextApiResponse } from "next";
import { getDynamoClient } from "lib/dynamo";
import { getServerSession } from "next-auth";
import { authOptions } from "pages/api/auth/[...nextauth]";
import { getOctokit } from "lib/github";

// Team ID query from https://api.github.com/orgs/pytorch/teams/pytorch-dev-infra
export const pytorchDevInfra = "pytorch-dev-infra";

async function isPyTorchDevInfraMember(
  repoOwner: string,
  repoName: string,
  userId: string
) {
  if (
    repoOwner === undefined ||
    repoName === undefined ||
    userId === undefined
  ) {
    return false;
  }

  const octokit = await getOctokit(repoOwner, repoName);
  // NB: For an unfathomable reason, the session only returns user ID and there is no call
  // atm to map GitHub user ID to username in Octokit. So there is no way to directly check
  // the team membership by user ID. The work around here is to get the list of all members
  // then check if the ID is there
  const pytorchDevInfraMembers = await octokit.rest.teams.listMembersInOrg({
    org: repoOwner,
    team_slug: pytorchDevInfra,
  });

  return (
    pytorchDevInfraMembers.data.filter((member) => {
      const memberId = member.id.toString();
      return memberId === userId;
    }).length === 1
  );
}

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

  const { repoOwner, repoName, annotation } = req.query;
  const hasPermission = await isPyTorchDevInfraMember(
    repoOwner as string,
    repoName as string,
    // @ts-ignore
    session.user.id
  );
  if (!hasPermission) {
    return res.status(401).end();
  }

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
      item["annotation"] = annotation;
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
