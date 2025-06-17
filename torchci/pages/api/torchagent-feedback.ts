import dayjs from "dayjs";
import { NextApiRequest, NextApiResponse } from "next";
import { getServerSession } from "next-auth";
import { getClickhouseClientWritable } from "../../lib/clickhouse";
import { hasWritePermissionsUsingOctokit } from "../../lib/GeneralUtils";
import { getOctokitWithUserToken } from "../../lib/github";
import { authOptions } from "./auth/[...nextauth]";

export async function insertFeedback(
  user: string,
  sessionId: string,
  feedback: number
) {
  await getClickhouseClientWritable().insert({
    table: "fortesting.torchagent_feedback",
    values: [
      [user, sessionId, feedback, dayjs().utc().format("YYYY-MM-DD HH:mm:ss")],
    ],
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // @ts-ignore
  const session = await getServerSession(req, res, authOptions);
  if (!session?.user || !session?.accessToken) {
    return res.status(401).json({ error: "Authentication required" });
  }

  const { sessionId, feedback } = req.body ?? {};
  if (
    !sessionId ||
    typeof sessionId !== "string" ||
    (feedback !== 1 && feedback !== -1)
  ) {
    return res.status(400).json({ error: "Invalid parameters" });
  }

  const repoOwner = "pytorch";
  const repoName = "pytorch";

  try {
    const octokit = await getOctokitWithUserToken(
      session.accessToken as string
    );
    const user = await octokit.rest.users.getAuthenticated();
    if (!user?.data?.login) {
      return res.status(401).json({ error: "GitHub authentication failed" });
    }
    const hasWrite = await hasWritePermissionsUsingOctokit(
      octokit,
      user.data.login,
      repoOwner,
      repoName
    );
    if (!hasWrite) {
      return res.status(403).json({ error: "Write permissions required" });
    }

    await insertFeedback(user.data.login, sessionId, feedback);
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Failed to record feedback", error);
    res.status(500).json({ error: "Failed to record feedback" });
  }
}

export const __forTesting__ = { insertFeedback };
