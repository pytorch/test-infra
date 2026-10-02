// Server-side glue for the Green Light section of the Dr.CI comment. Reads the
// authoritative greenlight state for a whole Dr.CI sweep out of ClickHouse in one
// batched query, then delegates the (pure) rendering to lib/greenlight/greenlightRender.
// A PR with no state at all gets the eligibility line from greenlightEligibility.

import { queryClickhouseSaved } from "lib/clickhouse";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import {
  EligibilityPr,
  GreenlightEligibility,
  greenlightEligibilityGate,
  renderGreenlightEligibility,
} from "lib/greenlight/greenlightEligibility";
import {
  GreenlightState,
  renderGreenlightSection,
} from "lib/greenlight/greenlightRender";
import { Octokit } from "octokit";

// The columns of a misc.greenlight_pr_state row that the render consumes, as the
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

export interface GreenlightSweep {
  headShaByPr: Map<number, string>;
  octokit: Octokit;
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
  check: (_pr: EligibilityPr) => Promise<GreenlightEligibility | null>,
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
 * the sweep's Octokit, which reads the PRs that have no greenlight state.
 * Returns pr_number -> rendered markdown. A PR with no greenlight state gets its
 * eligibility line instead; omitted are PRs whose only state is shadow, those whose
 * state or eligibility renders to nothing, and those whose own render or check
 * threw. Empty (and issues no query) when the repo isn't a greenlight repo or no
 * PRs were passed. The caller wraps this so a ClickHouse error can never break the
 * Dr.CI comment.
 */
export async function buildGreenlightSections(
  owner: string,
  repo: string,
  { headShaByPr, octokit }: GreenlightSweep
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
  const withState = new Set<number>();
  for (const row of rows) {
    withState.add(row.pr_number);
    // A shadow evaluation carries no authority, so Dr.CI never renders one.
    if (row.shadow) {
      continue;
    }
    // Per row, because the only handler above this one fails the whole sweep to an
    // empty map: without this, one PR whose row the renderer chokes on would strip
    // the section off every other PR in the sweep as well. The log gets the PR
    // number and the error, never the row -- `message` is untrusted model output,
    // scrubbed on its way into the comment and not on its way into a log.
    try {
      const rendered = renderGreenlightSection(
        toGreenlightState(row, repoKey),
        now,
        headShaByPr.get(row.pr_number) ?? ""
      );
      if (rendered) {
        sections.set(row.pr_number, rendered);
      }
    } catch (e) {
      console.error("greenlight section render threw for PR", row.pr_number, e);
    }
  }

  const check = greenlightEligibilityGate(octokit, owner, repo);
  await Promise.all(
    prNumbers
      .filter((prNumber) => !withState.has(prNumber))
      .map(async (prNumber) => {
        const line = await eligibilityLine(check, prNumber, async () => {
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
