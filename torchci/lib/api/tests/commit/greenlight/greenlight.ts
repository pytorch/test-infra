import {
  CommitGreenlight,
  GREENLIGHT_STATUSES,
  GreenlightStatus,
  GreenlightVerdict,
  NoVerdictReason,
} from "lib/api/tests/commit/greenlight/types";
import type { CommitSummaryQuery } from "lib/api/tests/commit/summary/parameters";
import { lookUpCommit } from "lib/api/tests/commit/summary/summary";
import { commitPageUrl } from "lib/api/tests/pages/links";
import { timed } from "lib/api/tests/timed";
import { queryClickhouseSaved } from "lib/clickhouse";
import {
  greenlightRepoKey,
  isGreenlightRepo,
} from "lib/greenlight/greenlightConfig";
import {
  GreenlightPrStateRow,
  selectStateForSha,
} from "lib/greenlight/greenlightHudState";
import { parseVersionMs } from "lib/greenlight/greenlightStaleness";

// The saved query the HUD's verdict panel reads, one row per reviewed head of
// a pull request: the endpoint reads the same one, so the panel and the test
// hub's commit page cannot name different verdicts for a commit.
export const GREENLIGHT_HISTORY_QUERY = "greenlight_pr_state_history";

// eval_job is a database column, so the host is anchored: a userinfo prefix
// and a lookalike domain both satisfy a mere "contains github.com". The
// expression the verdict panel and the Dr.CI comment guard the link with.
const SAFE_JOB_URL = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

function isGreenlightStatus(status: string): status is GreenlightStatus {
  return (GREENLIGHT_STATUSES as readonly string[]).includes(status);
}

// A ledger row as the endpoint answers it: null for a status the ledger's
// vocabulary does not hold, which the HUD has nothing to say for.
function toVerdict(row: GreenlightPrStateRow): GreenlightVerdict | null {
  const status = String(row.status ?? "").trim();
  if (!isGreenlightStatus(status)) return null;
  const updatedAtMs = parseVersionMs(String(row.version ?? ""));
  if (Number.isNaN(updatedAtMs)) {
    throw new Error(`Unparsable greenlight_pr_state version: ${row.version}`);
  }
  const jobUrl = String(row.eval_job ?? "").trim();
  return {
    status,
    reason: String(row.reason ?? ""),
    message: typeof row.message === "string" ? row.message : "",
    pull_request_number: Number(row.pr_number),
    head_sha: String(row.head_sha ?? "")
      .trim()
      .toLowerCase(),
    updated_at: new Date(updatedAtMs).toISOString(),
    job_url: SAFE_JOB_URL.test(jobUrl) ? jobUrl : null,
  };
}

// GreenLight's verdict on a commit, never null: a commit without one answers
// with a null verdict and the reason it has none, since most commits have
// none and a page asks for every commit it shows, to say which it is. The
// commit's own lookup names its pull request, as it does for the summary;
// the ledger is then read for that pull request, and the row about this
// commit chosen from it (selectStateForSha): the head itself, or the head
// that landed as it. A commit on a branch never carries the SHA that was
// reviewed, so for one the query is also given the commit and its timestamp,
// the committer's, from which it recovers that head; a pull request head is
// matched as it is, and giving its timestamp would tag the head pushed
// before it. A repository GreenLight does not review is answered without a
// query.
export async function getCommitGreenlight(
  query: CommitSummaryQuery
): Promise<CommitGreenlight> {
  const [owner, project] = query.repo.split("/");
  const answer = (
    found: GreenlightVerdict | NoVerdictReason,
    duration_ms: number
  ): CommitGreenlight => ({
    verdict: typeof found === "string" ? null : found,
    no_verdict_reason: typeof found === "string" ? found : null,
    hud_url: commitPageUrl(query.repo, query.sha),
    query_duration_ms: duration_ms,
  });
  if (!isGreenlightRepo(owner, project)) {
    return answer("repository_not_reviewed", 0);
  }
  // Timed whole, so a commit HUD does not know still reports its lookup.
  const lookup = await timed(lookUpCommit(query, "api_commit_greenlight"));
  const commit = lookup.result;
  if (commit === null) return answer("unknown_commit", lookup.duration_ms);
  if (commit.pullRequestNumber === null) {
    return answer("no_pull_request", lookup.duration_ms);
  }
  const history = await timed(
    queryClickhouseSaved(GREENLIGHT_HISTORY_QUERY, {
      repo: greenlightRepoKey(owner, project),
      owner,
      project,
      prNumber: commit.pullRequestNumber,
      ...(commit.pullRequestHead
        ? {}
        : {
            sha: query.sha,
            committedAt: new Date(commit.committedAtMs).toISOString(),
          }),
    }) as Promise<GreenlightPrStateRow[]>
  );
  const row = selectStateForSha(history.result, query.sha);
  return answer(
    row === undefined
      ? "not_reviewed"
      : toVerdict(row) ?? "unrecognized_status",
    lookup.duration_ms + history.duration_ms
  );
}
