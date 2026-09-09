// Server-side glue for the Green Light section of the Dr.CI comment. Reads the
// authoritative greenlight state for a whole Dr.CI sweep out of ClickHouse in one
// batched query, then delegates the (pure) rendering to lib/greenlight/greenlightRender.

import { queryClickhouseSaved } from "lib/clickhouse";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import {
  GreenlightState,
  renderGreenlightSection,
} from "lib/greenlight/greenlightRender";

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
}

function toGreenlightState(row: GreenlightStateRow): GreenlightState {
  return {
    prNumber: row.pr_number,
    status: row.status,
    reason: row.reason,
    message: row.message,
    headSha: row.head_sha,
    evalJob: row.eval_job,
    version: row.version,
  };
}

/**
 * Build the Green Light section for every PR in a Dr.CI sweep.
 * Takes pr_number -> the PR's head sha at sweep time, which the renderer needs to
 * tell a verdict on the current commit from one left behind by a later push.
 * Returns pr_number -> rendered markdown, omitting PRs with no greenlight state, those
 * whose state renders to nothing, and those whose own render threw. Empty (and issues
 * no query) when the repo isn't a greenlight repo or no PRs were passed. The caller
 * wraps this so a ClickHouse error can never break the Dr.CI comment.
 */
export async function buildGreenlightSections(
  owner: string,
  repo: string,
  headShaByPr: Map<number, string>
): Promise<Map<number, string>> {
  const sections = new Map<number, string>();
  const prNumbers = Array.from(headShaByPr.keys());
  if (!isGreenlightRepo(owner, repo) || prNumbers.length === 0) {
    return sections;
  }

  // The same folded key the gate above matched on. Rows are written under the
  // canonical spelling, so querying the caller's raw one matches nothing and the
  // section renders empty instead of failing.
  const rows = (await queryClickhouseSaved("greenlight_pr_states", {
    repo: greenlightRepoKey(owner, repo),
    prNumbers,
  })) as GreenlightStateRow[];

  // One instant for the whole sweep, so age-derived rendering is consistent across PRs.
  const now = new Date();
  for (const row of rows) {
    // Per row, because the only handler above this one fails the whole sweep to an
    // empty map: without this, one PR whose row the renderer chokes on would strip
    // the section off every other PR in the sweep as well. The log gets the PR
    // number and the error, never the row -- `message` is untrusted model output,
    // scrubbed on its way into the comment and not on its way into a log.
    try {
      const rendered = renderGreenlightSection(
        toGreenlightState(row),
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
  return sections;
}
