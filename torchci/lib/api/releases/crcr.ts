import { RELEASE_DATABASE } from "lib/api/releases/database";
import type { CrcrRepo, ReleaseCrcr } from "lib/api/releases/types";
import { CollectedCrcrResultsSchema } from "lib/api/releases/types";
import { queryClickhouse } from "lib/clickhouse";
import { z } from "zod/v4";

// The downstream CI results for a release's candidates, as the collector last
// recorded them: the details of the crcr_summary step (release/portal/config/steps.yml),
// which has a row of its own for each release candidate.

const RcSchema = z.string().regex(/^rc\d+$/);

interface CrcrDbRow {
  rc: string;
  details: string;
}

// The newest observation of the newest release candidate that has one: by number, so
// rc10 follows rc9, as the artifacts endpoint and the board's current_rc choose. Found
// by the check type, not the step id, as the milestone reader does, so a release whose
// config numbers the step differently is read the same way.
async function latestCrcrRow(version: string): Promise<CrcrDbRow | null> {
  const rows: CrcrDbRow[] = await queryClickhouse(
    `
SELECT rc, details
FROM ${RELEASE_DATABASE}.release_event
WHERE release = {release: String}
  AND check_type = 'crcr_summary'
  AND rc != ''
ORDER BY toUInt32OrZero(replaceRegexpOne(rc, '^rc', '')) DESC, observed_at DESC
LIMIT 1`,
    { release: version },
    "api_release_crcr"
  );
  return rows[0] ?? null;
}

// A row with no details is a release candidate the collector has looked at and has no
// downstream repo to list for yet. Opted-in repos that have not reported are listed in
// the details, with the result no_result. Every repo is for the row's release candidate,
// the one the response names as current: a repo of another one is bad collector data,
// not a result to show as current.
function parseRepos(details: string, rc: string) {
  if (details === "") return [];
  let collected: unknown;
  try {
    collected = JSON.parse(details);
  } catch {
    throw new Error("Release CRCR observation has invalid JSON details");
  }
  const parsed = CollectedCrcrResultsSchema.safeParse(collected);
  if (!parsed.success) {
    throw new Error("Release CRCR observation has invalid details");
  }
  if (parsed.data.repos.some((repo) => repo.rc !== rc)) {
    throw new Error(
      "Release CRCR observation has a repo for another release candidate"
    );
  }
  return parsed.data.repos;
}

// Failed repos first, then the repos with no result (a silent repo is a problem to look
// at too), then passed, each by repo name, so a repo keeps its place from one request
// to the next.
const RESULT_ORDER: Record<CrcrRepo["result"], number> = {
  failed: 0,
  no_result: 1,
  passed: 2,
};

function problemsFirst(a: CrcrRepo, b: CrcrRepo): number {
  if (a.result !== b.result)
    return RESULT_ORDER[a.result] - RESULT_ORDER[b.result];
  return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
}

export function buildCrcr(
  rc: string | null,
  collected: ReturnType<typeof parseRepos>
): ReleaseCrcr {
  const repos = collected
    .map((repo) => ({
      ...repo,
      // The repo page has no release view yet: it reads event=nightly and shows its PR
      // view for anything else, so a release link would show unrelated results. Null
      // until it does (/crcr/{org}/{repo}?event=release&version={version}).
      hud_url: null,
    }))
    .sort(problemsFirst);
  const count = (result: CrcrRepo["result"]) =>
    repos.filter((repo) => repo.result === result).length;
  return {
    rc,
    summary: {
      repos: repos.length,
      passing: count("passed"),
      failing: count("failed"),
      no_result: count("no_result"),
    },
    repos,
  };
}

export async function getCrcrResults(version: string): Promise<ReleaseCrcr> {
  const row = await latestCrcrRow(version);
  if (row === null) return buildCrcr(null, []);
  const rc = RcSchema.safeParse(row.rc);
  if (!rc.success) {
    throw new Error(
      "Release CRCR observation has an invalid release candidate"
    );
  }
  return buildCrcr(rc.data, parseRepos(row.details, rc.data));
}
