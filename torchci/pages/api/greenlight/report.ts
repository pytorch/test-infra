/**
 * POST /api/greenlight/report
 *
 * Files a "this Green Light verdict is wrong" issue on pytorch/test-infra and
 * puts it on the GreenLight Policies Reviews board for the team to triage.
 *
 * The issue is authored by PyTorchBot, not by the reporter, which decides three
 * things about this handler:
 *
 *   - It is gated behind the shared HUD GitHub gate (write access to
 *     pytorch/pytorch, or the allow list), not merely behind "is logged in".
 *     An open endpoint here is an open endpoint for filing bot-authored issues
 *     on test-infra.
 *   - The authenticated login is the only name that reaches the body. The
 *     browser never gets to say who reported.
 *   - The verdict is read back from `misc.greenlight_pr_state` here rather than
 *     accepted from the request. A client that could name the status could have
 *     the bot publish a verdict Green Light never reached.
 *
 * Adding to the board is best-effort and deliberately not fatal: by the time it
 * runs the issue exists, and failing the request would tell the reporter their
 * report was lost when it was filed. The response says which of the two happened.
 */
import { authorizeGithubToken, resolveGithubToken } from "lib/auth/githubAuth";
import { queryClickhouseSaved } from "lib/clickhouse";
import { getOctokit } from "lib/github";
import { greenlightRepoKey } from "lib/greenlight/greenlightConfig";
import {
  GreenlightPrStateRow,
  selectStateForSha,
} from "lib/greenlight/greenlightHudState";
import {
  buildReportBody,
  buildReportTitle,
  GREENLIGHT_REPORT_LABEL,
  GREENLIGHT_REPORT_OWNER,
  GREENLIGHT_REPORT_PROJECT_ID,
  GREENLIGHT_REPORT_REPO,
  GreenlightReportSubject,
  isReportableStatus,
  parseReportRequest,
} from "lib/greenlight/greenlightReport";
import type { NextApiRequest, NextApiResponse } from "next";
import { authOptions } from "../auth/[...nextauth]";

export interface GreenlightReportResponse {
  issueUrl: string;
  issueNumber: number;
  /** False when the issue was filed but the board add failed; see the logs. */
  addedToProject: boolean;
}

const ADD_TO_PROJECT = `
mutation($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
    item { id }
  }
}
`;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const githubToken = await resolveGithubToken(req, res, authOptions);
  if (!githubToken) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const auth = await authorizeGithubToken(githubToken);
  if (!auth.ok) {
    return res.status(auth.status).json({ error: auth.error });
  }

  const parsed = parseReportRequest(req.body);
  if (!parsed.ok) {
    return res.status(400).json({ error: parsed.error });
  }
  const { repoOwner, repoName, prNumber, sha, comment } = parsed.value;

  let row: GreenlightPrStateRow | undefined;
  try {
    // The same read the panel made to show the verdict being disputed, so the
    // two cannot describe different rows -- including selectStateForSha, which
    // matches the reviewed head OR the trunk commit it landed as, and never
    // falls back to "some other verdict for this PR".
    const rows = (await queryClickhouseSaved("greenlight_pr_state_history", {
      repo: greenlightRepoKey(repoOwner, repoName),
      owner: repoOwner,
      project: repoName,
      prNumber,
    })) as GreenlightPrStateRow[];
    row = selectStateForSha(rows, sha);
  } catch (error) {
    console.error("greenlight report: state lookup failed", error);
    return res.status(500).json({ error: "Failed to read Green Light state" });
  }

  if (row === undefined) {
    return res
      .status(404)
      .json({ error: "No Green Light verdict for that commit" });
  }
  if (!isReportableStatus(row.status)) {
    return res
      .status(400)
      .json({ error: "Only LAND and NO_LAND verdicts can be reported" });
  }

  const subject: GreenlightReportSubject = {
    repoOwner,
    repoName,
    prNumber,
    // The row's own head_sha, not the sha in the request: on a landed commit
    // those differ, and the issue should name the commit that was reviewed.
    headSha: asString(row.head_sha),
    mergeCommitSha: asString(row.merge_commit_sha),
    status: asString(row.status),
    reason: asString(row.reason),
    message: asString(row.message),
    evalJob: asString(row.eval_job),
    version: asString(row.version),
  };

  let issue;
  try {
    const octokit = await getOctokit(
      GREENLIGHT_REPORT_OWNER,
      GREENLIGHT_REPORT_REPO
    );
    issue = await octokit.rest.issues.create({
      owner: GREENLIGHT_REPORT_OWNER,
      repo: GREENLIGHT_REPORT_REPO,
      title: buildReportTitle(subject),
      body: buildReportBody({ subject, reporter: auth.login, comment }),
      labels: [GREENLIGHT_REPORT_LABEL],
    });

    let addedToProject = true;
    try {
      await octokit.graphql(ADD_TO_PROJECT, {
        projectId: GREENLIGHT_REPORT_PROJECT_ID,
        contentId: issue.data.node_id,
      });
    } catch (error) {
      // Almost always a permissions answer rather than a transient one: the app
      // needs organization Projects read & write, and the board has to list it
      // under Manage access. Loud in the log, survivable for the reporter.
      addedToProject = false;
      console.error(
        `greenlight report: failed to add issue #${issue.data.number} to the triage board`,
        error
      );
    }

    const response: GreenlightReportResponse = {
      issueUrl: issue.data.html_url,
      issueNumber: issue.data.number,
      addedToProject,
    };
    return res.status(201).json(response);
  } catch (error) {
    console.error("greenlight report: failed to file issue", error);
    return res.status(502).json({ error: "Failed to file the GitHub issue" });
  }
}
