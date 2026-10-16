// SVG badge for the AI CI Advisor verdict, embedded in the Dr.CI comment.
//
// The comment's <img> points here so the pill can flip analyzing -> verdict
// server-side without rewriting the comment (which only happens on the ~15-min
// Dr.CI cron). Caching is state-dependent: a short TTL while in-progress so the
// proxy (GitHub camo) re-fetches and the badge updates soon after the verdict
// lands, then a long immutable TTL once final (a verdict never changes for a
// fixed repo+sha+job).

import {
  ANALYZING_BADGE,
  drciSignalKeyForJob,
  isLiveDispatch,
  isStrictlyAfter,
  OUTDATED_BADGE,
  parseUtc,
  PENDING_BADGE,
  renderBadgeSvg,
  verdictBadge,
  verdictCoversRun,
} from "lib/advisor/advisorBadge";
import { isAdvisorEnabled } from "lib/advisor/advisorConfig";
import { isValidSha, readDispatchStates } from "lib/advisor/advisorDispatch";
import { queryClickhouseSaved } from "lib/clickhouse";
import type { NextApiRequest, NextApiResponse } from "next";

const SHORT_CACHE =
  "public, max-age=60, s-maxage=60, stale-while-revalidate=60";
// Long but NOT immutable: a verdict is normally written once per (sha, job),
// but a manual re-analyze or a retried dispatch can land a newer row, and the
// query returns the latest by timestamp. A finite TTL lets a corrected verdict
// propagate (within a day) instead of being cached forever by the proxy.
const LONG_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=86400";

// GitHub owner/repo name shape, to bound the public endpoint's CH lookups.
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const MAX_JOB_LEN = 256;
const MAX_SINCE_LEN = 64;

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : value ?? "";
}

function sendSvg(
  res: NextApiResponse,
  svg: string,
  cacheControl: string
): void {
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.status(200).send(svg);
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const owner = one(req.query.owner);
  const repo = one(req.query.repo);
  const sha = one(req.query.sha);
  const job = one(req.query.job);
  // The job run's completed_at (see advisorBadgeUrl). Optional: comments
  // rendered before it existed omit it, and an unusable value is ignored, which
  // leaves the badge describing the latest verdict as it always did.
  const sinceRaw = one(req.query.since);
  const since =
    sinceRaw.length <= MAX_SINCE_LEN && parseUtc(sinceRaw) ? sinceRaw : "";

  // Bad input -> a neutral pending pill (never a 4xx/5xx, which would render a
  // broken-image icon in the comment). Don't cache bad requests.
  if (
    !NAME_RE.test(owner) ||
    !NAME_RE.test(repo) ||
    !isValidSha(sha) ||
    !job ||
    job.length > MAX_JOB_LEN
  ) {
    sendSvg(res, renderBadgeSvg(PENDING_BADGE), "no-store");
    return;
  }

  // Only serve badges for advisor-enabled repos (same gate as the comment
  // path); a neutral pending pill for anything else.
  if (!isAdvisorEnabled(owner, repo)) {
    sendSvg(res, renderBadgeSvg(PENDING_BADGE), SHORT_CACHE);
    return;
  }

  const repoFull = `${owner}/${repo}`;
  const signalKey = drciSignalKeyForJob(job);

  try {
    // Finalized verdict wins. Hits the verdict table's ORDER BY prefix
    // (repo, suspect_commit, signal_key) -> indexed point lookup.
    const verdictRows = (await queryClickhouseSaved("advisor_verdict_for_job", {
      repo: repoFull,
      sha,
      signalKey,
    })) as { verdict: string; confidence: number; timestamp: string }[];

    const row = verdictRows[0];
    // Without `since` the latest verdict is shown, as before this parameter.
    if (row && !since) {
      const badge = verdictBadge(row.verdict, Number(row.confidence));
      sendSvg(res, renderBadgeSvg(badge), LONG_CACHE);
      return;
    }

    // With `since`, only a verdict that covers that run is shown, by the same
    // test the comment line and the suppression gate use.
    const states = await readDispatchStates(owner, repo, sha, [signalKey]);
    const dispatch = states.get(signalKey);
    if (row && verdictCoversRun(row.timestamp, since, dispatch)) {
      const badge = verdictBadge(row.verdict, Number(row.confidence));
      sendSvg(res, renderBadgeSvg(badge), LONG_CACHE);
      return;
    }

    // Otherwise: "analyzing" while a live dispatch has no newer verdict yet;
    // pending while one answered for an earlier run and this run's dispatch is
    // owed; "outdated" when a verdict exists with no live dispatch.
    let badge = PENDING_BADGE;
    if (isLiveDispatch(dispatch)) {
      if (!isStrictlyAfter(row?.timestamp, dispatch.version)) {
        badge = ANALYZING_BADGE;
      }
    } else if (row) {
      badge = OUTDATED_BADGE;
    }
    sendSvg(res, renderBadgeSvg(badge), SHORT_CACHE);
  } catch (e) {
    // Fail soft: a pending pill, uncached so the next view retries. Never 500
    // (a broken image is worse than a transient "pending").
    console.error("advisorBadge: lookup failed", e);
    sendSvg(res, renderBadgeSvg(PENDING_BADGE), "no-store");
  }
}
