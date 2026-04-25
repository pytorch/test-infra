import {
  AdvisorVerdictRow,
  deduplicateVerdicts,
} from "lib/advisorVerdictUtils";
import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

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
    const rows = (await queryClickhouseSaved("advisor_verdicts_for_pr", {
      repo: `${repoOwner}/${repoName}`,
      prNumber: parseInt(prNumber as string, 10),
    })) as AdvisorVerdictRow[];

    res.status(200).json(deduplicateVerdicts(rows));
  } catch (error: any) {
    res.status(500).json({
      error: "Internal server error",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
}
