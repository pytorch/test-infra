import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const { repoOwner, repoName, sha } = req.query;

  if (!repoOwner || !repoName || !sha) {
    res.status(400).json({ error: "Missing required parameters" });
    return;
  }

  try {
    const results = await queryClickhouseSaved("autorevert_details", {
      repo: `${repoOwner}/${repoName}`,
      sha: sha as string,
    });

    if (results && results.length > 0) {
      // Combine data from all rows (in case there are multiple events)
      const allWorkflows: string[] = [];
      const allSignalKeys: string[] = [];

      results.forEach((row: any) => {
        if (row.workflows) allWorkflows.push(...row.workflows);
        if (row.source_signal_keys) allSignalKeys.push(...row.source_signal_keys);
      });

      const response = {
        commit_sha: results[0].commit_sha,
        workflows: allWorkflows,
        source_signal_keys: allSignalKeys,
        // These fields don't exist in the table, so we'll use empty arrays
        job_ids: [],
        job_base_names: [],
        wf_run_ids: [],
      };

      res.status(200).json(response);
    } else {
      res.status(404).json({ error: "No autorevert data found" });
    }
  } catch (error: any) {
    res.status(500).json({
      error: "Internal server error",
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}