import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export interface AdvisorVerdict {
  suspectCommit: string;
  signalKey: string;
  signalSource: string;
  workflowName: string;
  verdict: "revert" | "unsure" | "not_related" | "garbage";
  confidence: number;
  summary: string;
  causalReasoning: string;
  runId: number;
  timestamp: string;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { repoOwner, repoName, prNumber } = req.query;

  if (!repoOwner || !repoName || !prNumber) {
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  try {
    const results = await queryClickhouseSaved("advisor_verdicts_for_pr", {
      repo: `${repoOwner}/${repoName}`,
      prNumber: parseInt(prNumber as string, 10),
    });

    res.status(200).json(results as AdvisorVerdict[]);
  } catch (error: any) {
    res.status(500).json({
      error: "Internal server error",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
