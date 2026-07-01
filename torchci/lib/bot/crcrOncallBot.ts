import { Probot } from "probot";
import { fetchCrcrAllowlist } from "../crcrAllowlist";
import { isPyTorchbotSupportedOrg } from "./utils";

const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
]);

const MARKER = "<!-- crcr-oncall -->";

/**
 * Parse the downstream ``owner/repo`` out of a CRCR check run name.
 *
 * Check runs are named ``crcr/<owner>/<repo>/<workflow_name>`` (see the
 * Python gh_helper.check_run_name), so the downstream repo is the first two
 * path segments after the ``crcr/`` prefix.
 */
function downstreamRepoFromCheckRunName(name: string): string | null {
  const prefix = "crcr/";
  if (!name.startsWith(prefix)) {
    return null;
  }
  const parts = name.slice(prefix.length).split("/");
  if (parts.length < 3 || !parts[0] || !parts[1]) {
    return null;
  }
  return `${parts[0]}/${parts[1]}`;
}

/**
 * Search existing PR comments for one with the CRCR on-call marker.
 * Returns its ID (or 0 if none found).
 */
async function findExistingComment(
  octokit: any,
  owner: string,
  repo: string,
  prNumber: number
): Promise<number> {
  const commentsRes = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
  });
  for (const comment of commentsRes.data) {
    if (comment.body?.includes(MARKER)) {
      return comment.id;
    }
  }
  return 0;
}

export default function crcrOncallBot(app: Probot): void {
  app.on("check_run.completed", async (ctx) => {
    const owner = ctx.payload.repository.owner.login;
    if (!isPyTorchbotSupportedOrg(owner)) {
      return;
    }

    const repo = ctx.payload.repository.name;
    const checkRun = ctx.payload.check_run;

    // Only act on CRCR-created check runs
    const downstreamRepo = downstreamRepoFromCheckRunName(checkRun.name);
    if (!downstreamRepo) {
      return;
    }

    // Only comment on failures
    const conclusion = checkRun.conclusion ?? "";
    if (!FAILURE_CONCLUSIONS.has(conclusion)) {
      return;
    }

    // Get the PR this check run belongs to
    const prs = checkRun.pull_requests ?? [];
    if (prs.length === 0) {
      ctx.log(
        `crcrOncall: no PR associated with check run ${checkRun.name}, skipping`
      );
      return;
    }

    const headSha = checkRun.head_sha;
    const checkRunUrl = checkRun.html_url ?? "";

    // Load oncalls from the allowlist
    let oncalls: string[];
    try {
      const allowlist = await fetchCrcrAllowlist(ctx.octokit);
      oncalls = allowlist.getOncallsForRepo(downstreamRepo);
    } catch (err) {
      ctx.log({ err }, "crcrOncall: failed to load allowlist, skipping");
      return;
    }

    if (oncalls.length === 0) {
      ctx.log(
        `crcrOncall: no oncalls configured for ${downstreamRepo}, skipping`
      );
      return;
    }

    const mentions = oncalls.map((o) => `@${o}`).join(" ");

    // Post a comment on each associated PR (typically just one)
    for (const pr of prs) {
      try {
        const prNumber = pr.number;

        // Dedup by marker: only comment once per PR.
        const existingId = await findExistingComment(
          ctx.octokit,
          owner,
          repo,
          prNumber
        );
        if (existingId !== 0) {
          ctx.log(
            `crcrOncall: comment already exists on PR #${prNumber}, skipping`
          );
          continue;
        }

        const commentBody = `${MARKER}
## :x: CRCR downstream CI failure

The downstream CI workflow in **${downstreamRepo}** has failed on commit \`${headSha.slice(0, 7)}\`.

${mentions} please investigate.

### Details

| Field | Value |
|---|---|
| **Check Run** | [${checkRun.name}](${checkRunUrl}) |
| **Commit** | \`${headSha}\` |
| **Conclusion** | \`${conclusion}\` |
`;

        await ctx.octokit.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: commentBody,
        });

        ctx.log(
          `crcrOncall: commented on PR #${prNumber} for ${downstreamRepo} (${conclusion})`
        );
      } catch (err) {
        ctx.log({ err }, `crcrOncall: failed to comment on PR for ${downstreamRepo}`);
      }
    }
  });
}
