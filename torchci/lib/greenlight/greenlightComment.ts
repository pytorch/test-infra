// Server-side glue for the Green Light section of the Dr.CI comment. Reads the
// authoritative greenlight state for a whole Dr.CI sweep out of ClickHouse in one
// batched query, then delegates the (pure) rendering to lib/greenlight/greenlightRender.
// A PR with no state at all gets the eligibility line from greenlightEligibility, and
// so does a PR whose only state is shadow, unless that line is "waiting". The same
// line, unless "waiting", replaces a verdict reached on an earlier commit.

import { queryClickhouseSaved } from "lib/clickhouse";
import { isOutdatedVerdict } from "lib/greenlight/greenlightCommitLine";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import {
  EligibilityCheck,
  EligibilityPr,
  greenlightEligibilityGate,
  renderGreenlightEligibility,
} from "lib/greenlight/greenlightEligibility";
import {
  GREENLIGHT_STATUS_REVERTED,
  GreenlightState,
  renderGreenlightSection,
} from "lib/greenlight/greenlightRender";
import { Octokit } from "octokit";

// The columns of a misc.greenlight_pr_state row that this module reads, as the
// greenlight_pr_states saved query returns them. Saved queries are untyped
// (any[]), so this is the cast target. run_id is selected there too, but only to
// order the rows; nothing downstream reads it.
interface GreenlightStateRow {
  pr_number: number;
  status: string;
  reason: string;
  message: string;
  head_sha: string;
  eval_job: string;
  version: string;
  shadow: boolean;
}

function toGreenlightState(
  row: GreenlightStateRow,
  repo: string
): GreenlightState {
  return {
    repo,
    prNumber: row.pr_number,
    status: row.status,
    reason: row.reason,
    message: row.message,
    headSha: row.head_sha,
    evalJob: row.eval_job,
    version: row.version,
  };
}

async function eligibilityLine(
  check: EligibilityCheck,
  prNumber: number,
  readPr: () => Promise<EligibilityPr>
): Promise<string> {
  try {
    return renderGreenlightEligibility(await check(await readPr()));
  } catch (e) {
    console.error("greenlight eligibility check failed for PR", prNumber, e);
    return "";
  }
}

/**
 * Build the Green Light section for every PR in a Dr.CI sweep.
 * Takes pr_number -> the PR's head sha at sweep time, which the renderer needs to
 * tell a verdict on the current commit from one left behind by a later push, and
 * the sweep's Octokit, which reads the PRs that have no non-shadow greenlight state
 * and those whose verdict was left behind.
 * Returns pr_number -> rendered markdown. A PR with no greenlight state gets its
 * eligibility line instead, and so does a PR whose only state is shadow unless that
 * line is "waiting"; a left-behind verdict gives way to that line on the same terms,
 * and stays when its check throws. Omitted are PRs whose state or eligibility
 * renders to nothing, those whose own render threw, and those with no verdict
 * whose check threw. Empty (and issues no query) when the repo isn't a greenlight
 * repo or no PRs were passed. The caller wraps this so a ClickHouse error can
 * never break the Dr.CI comment.
 */
export async function buildGreenlightSections(
  owner: string,
  repo: string,
  headShaByPr: Map<number, string>,
  octokit: Octokit
): Promise<Map<number, string>> {
  const sections = new Map<number, string>();
  const prNumbers = Array.from(headShaByPr.keys());
  if (!isGreenlightRepo(owner, repo) || prNumbers.length === 0) {
    return sections;
  }

  // The same folded key the gate above matched on. Rows are written under the
  // canonical spelling, so querying the caller's raw one matches nothing and the
  // section renders empty instead of failing. It is also the repo the report link
  // names, so a link built from the caller's raw spelling cannot differ per caller.
  const repoKey = greenlightRepoKey(owner, repo);
  const rows = (await queryClickhouseSaved("greenlight_pr_states", {
    repo: repoKey,
    prNumbers,
  })) as GreenlightStateRow[];

  // One instant for the whole sweep, so age-derived rendering is consistent across PRs.
  const now = new Date();
  const withAuthority = new Set<number>();
  const shadowOnly = new Set<number>();
  const leftBehind = new Set<number>();
  for (const row of rows) {
    // A shadow evaluation carries no authority, so Dr.CI never renders one; its PR
    // is checked for eligibility below instead.
    if (row.shadow) {
      shadowOnly.add(row.pr_number);
      continue;
    }
    withAuthority.add(row.pr_number);
    const headSha = headShaByPr.get(row.pr_number) ?? "";
    // Per row, because the only handler above this one fails the whole sweep to an
    // empty map: without this, one PR whose row the renderer chokes on would strip
    // the section off every other PR in the sweep as well. The log gets the PR
    // number and the error, never the row -- `message` is untrusted model output,
    // scrubbed on its way into the comment and not on its way into a log.
    try {
      const rendered = renderGreenlightSection(
        toGreenlightState(row, repoKey),
        now,
        headSha
      );
      if (rendered) {
        sections.set(row.pr_number, rendered);
        // The rows the renderer marks outdated: a revert holds for every head, so
        // a REVERTED row never is.
        if (
          row.status.trim() !== GREENLIGHT_STATUS_REVERTED &&
          isOutdatedVerdict(row.head_sha, headSha)
        ) {
          leftBehind.add(row.pr_number);
        }
      }
    } catch (e) {
      console.error("greenlight section render threw for PR", row.pr_number, e);
    }
  }

  const check = greenlightEligibilityGate(octokit, owner, repo);
  // For a PR that already has a row: a shadow-only one, whose finished review the
  // scan repeats only once the PR changes, or a verdict on an earlier commit, which
  // stands until a review of the new head replaces it. "waiting" could promise a
  // review that never starts; "too_big" and "merge_rules" say why none will.
  const shadowCheck: EligibilityCheck = async (pr) => {
    const eligibility = await check(pr);
    return eligibility === "waiting" ? null : eligibility;
  };
  await Promise.all(
    prNumbers
      .filter(
        (prNumber) => !withAuthority.has(prNumber) || leftBehind.has(prNumber)
      )
      .map(async (prNumber) => {
        const prCheck =
          leftBehind.has(prNumber) || shadowOnly.has(prNumber)
            ? shadowCheck
            : check;
        const line = await eligibilityLine(prCheck, prNumber, async () => {
          const { data } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: prNumber,
          });
          return data;
        });
        if (line) {
          sections.set(prNumber, line);
        }
      })
  );
  return sections;
}

// The eligibility line for a pull_request.opened webhook, read off the PR the
// payload carries; "" for any other event or repo. `context` is probot's.
export async function buildGreenlightOpenedLine(
  owner: string,
  repo: string,
  context: any
): Promise<string> {
  const pr = context.payload?.pull_request;
  if (
    context.payload?.action !== "opened" ||
    !pr ||
    !isGreenlightRepo(owner, repo)
  ) {
    return "";
  }
  return eligibilityLine(
    greenlightEligibilityGate(context.octokit, owner, repo),
    pr.number,
    async () => pr
  );
}
