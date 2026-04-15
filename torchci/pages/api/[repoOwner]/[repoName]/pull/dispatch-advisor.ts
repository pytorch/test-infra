import { hasWritePermissionsUsingOctokit } from "lib/GeneralUtils";
import { queryClickhouse } from "lib/clickhouse";
import { getOctokit, getOctokitWithUserToken } from "lib/github";
import type { NextApiRequest, NextApiResponse } from "next";

const SHA_REGEX = /^[0-9a-f]{4,40}$/i;

function isValidSha(sha: string): boolean {
  return SHA_REGEX.test(sha);
}

interface JobEvent {
  conclusion: string;
  htmlUrl: string;
  logUrl: string;
  failureCaptures: string[];
  failureLines: string[];
}

async function fetchJobStatusForShas(
  repo: string,
  jobName: string,
  shas: string[],
): Promise<Record<string, JobEvent[]>> {
  if (shas.length === 0) return {};

  const query = `
    SELECT
      workflow.head_sha AS sha,
      job.conclusion_kg AS conclusion,
      job.html_url AS htmlUrl,
      job.log_url AS logUrl,
      job.torchci_classification_kg.'captures'
        AS failureCaptures,
      arrayMap(
        x -> x,
        if(
          job.torchci_classification_kg.'line' = '',
          [],
          [job.torchci_classification_kg.'line']
        )
      ) AS failureLines
    FROM workflow_job job FINAL
    INNER JOIN workflow_run workflow FINAL
      ON workflow.id = job.run_id
    WHERE
      workflow.head_sha IN ({shas: Array(String)})
      AND workflow.repository.full_name = {repo: String}
      AND CONCAT(workflow.name, ' / ', job.name)
        = {jobName: String}
    ORDER BY job.started_at DESC
  `;

  const rows = await queryClickhouse(query, {
    repo,
    jobName,
    shas,
  });

  const result: Record<string, JobEvent[]> = {};
  for (const row of rows) {
    const sha = row.sha as string;
    if (!result[sha]) result[sha] = [];
    result[sha].push({
      conclusion: (row.conclusion as string) || "pending",
      htmlUrl: row.htmlUrl as string,
      logUrl: row.logUrl as string,
      failureCaptures:
        (row.failureCaptures as string[]) || [],
      failureLines: (row.failureLines as string[]) || [],
    });
  }
  return result;
}

async function fetchRecentTrunkShas(
  repo: string,
  limit: number = 5,
): Promise<string[]> {
  const query = `
    SELECT DISTINCT head_sha
    FROM workflow_run FINAL
    WHERE
      repository.full_name = {repo: String}
      AND head_branch = 'main'
      AND event = 'push'
    ORDER BY created_at DESC
    LIMIT {limit: UInt32}
  `;
  const rows = await queryClickhouse(query, { repo, limit });
  return rows.map((r: any) => r.head_sha as string);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method !== "POST") {
    return void res
      .status(405)
      .json({ error: "Method not allowed" });
  }

  const authorization = req.headers.authorization;
  if (!authorization) {
    return void res
      .status(403)
      .json({ error: "Authorization required" });
  }

  const owner = req.query["repoOwner"] as string;
  const repo = req.query["repoName"] as string;
  if (!owner || !repo) {
    return void res
      .status(400)
      .json({ error: "Missing repo parameters" });
  }

  const {
    prNumber,
    headSha,
    mergeBaseSha,
    jobName,
    workflowName,
  } = req.body;
  if (!prNumber || !headSha || !jobName) {
    return void res.status(400).json({
      error:
        "Missing required fields: prNumber, headSha, jobName",
    });
  }

  if (!isValidSha(headSha)) {
    return void res
      .status(400)
      .json({ error: "Invalid headSha format" });
  }
  if (mergeBaseSha && !isValidSha(mergeBaseSha)) {
    return void res
      .status(400)
      .json({ error: "Invalid mergeBaseSha format" });
  }

  const octokit =
    await getOctokitWithUserToken(authorization);
  const user = await octokit.rest.users.getAuthenticated();
  if (!user?.data?.login) {
    return void res
      .status(403)
      .json({ error: "Invalid credentials" });
  }

  const hasWritePerms =
    await hasWritePermissionsUsingOctokit(
      octokit,
      user.data.login,
      owner,
      repo,
    );
  if (!hasWritePerms) {
    return void res.status(403).json({
      error:
        "Write permission required to dispatch advisor",
    });
  }

  try {
    const repoFullName = `${owner}/${repo}`;
    const trunkShas = await fetchRecentTrunkShas(
      repoFullName,
      5,
    );
    const allShas = [headSha];
    if (mergeBaseSha) allShas.push(mergeBaseSha);
    allShas.push(...trunkShas);

    const jobStatus = await fetchJobStatusForShas(
      repoFullName,
      jobName,
      allShas,
    );

    const mkEvents = (sha: string) =>
      (jobStatus[sha] || []).map((e) => ({
        url: e.htmlUrl,
        log_url: e.logUrl,
        conclusion: e.conclusion,
        failure_captures: e.failureCaptures,
        failure_lines: e.failureLines,
      }));

    const trunkCommits = trunkShas.map((sha) => ({
      sha,
      partition: "trunk: recent main branch commit",
      events: mkEvents(sha),
    }));

    const signalPattern = {
      signal_key: jobName,
      signal_source: "job",
      workflow_name: workflowName || "",
      pr_number: prNumber,
      head_sha: headSha,
      merge_base_sha: mergeBaseSha || "",
      failed_partition: [
        {
          sha: headSha,
          is_suspect: true,
          partition:
            "pr_head: the PR head commit under investigation",
          timestamp: new Date().toISOString(),
          events: mkEvents(headSha),
        },
      ],
      successful_partition: [
        ...(mergeBaseSha
          ? [
              {
                sha: mergeBaseSha,
                partition:
                  "merge_base: the merge base commit",
                events: mkEvents(mergeBaseSha),
              },
            ]
          : []),
        ...trunkCommits.filter(
          (c) =>
            c.events.length > 0 &&
            c.events.some(
              (e) => e.conclusion === "success",
            ),
        ),
      ],
      trunk_status: trunkCommits,
    };

    const botOctokit = await getOctokit(owner, repo);
    await botOctokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: "claude-autorevert-advisor.yml",
      ref: "main",
      inputs: {
        suspect_commit: headSha,
        pr_number: String(prNumber),
        signal_pattern: JSON.stringify(signalPattern),
      },
    });

    return void res.status(200).json({
      message: "Advisor workflow dispatched",
      prNumber,
      headSha,
      jobName,
    });
  } catch (error: any) {
    console.error("Failed to dispatch advisor:", error);
    return void res.status(500).json({
      error: "Failed to dispatch advisor workflow",
      details:
        process.env.NODE_ENV === "development"
          ? error.message
          : undefined,
    });
  }
}
