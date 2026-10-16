// Pure rendering helpers for the AI CI Advisor verdict surfaced in the Dr.CI
// comment (no server-only imports, so this is unit-testable and importable
// anywhere). Two outputs:
//   - renderBadgeSvg: the colored status pill served by the advisorBadge API
//     route (the <img> in the comment points at that route so it can flip
//     analyzing -> verdict server-side without rewriting the comment).
//   - selectAdvisorLines / renderVerdictLine / renderInProgressLine: the
//     "AI verdict:" line emitted under each new failure in the comment.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import _ from "lodash";

dayjs.extend(utc);

// The signal_key prefix for HUD-originated (Dr.CI) advisor dispatches. Mirrors
// signalKeyForJob() in advisorDispatch.ts; duplicated here to keep this module
// free of any server-only imports.
export const DRCI_SIGNAL_KEY_PREFIX = "dr_ci_";

export function drciSignalKeyForJob(fullJobName: string): string {
  return `${DRCI_SIGNAL_KEY_PREFIX}${fullJobName}`;
}

// Each advisor <img> carries an alt of the form `AI verdict: <outcome>`. This
// does two jobs: (1) it encodes the verdict outcome as machine-readable text in
// the comment body (an AI agent reading the comment, or a human with images
// off, gets the verdict without fetching the badge SVG), and (2) the
// not-yet-concluded sentinel below is what the Dr.CI cron matches on to keep
// re-rendering a PR until its verdict lands -- the badge image flips
// server-side via camo, but the concluded <details> expand is comment-body text
// that only appears on a re-render, so an unconcluded PR must stay a candidate.
export const ADVISOR_ALT_PREFIX = "AI verdict: ";
// Sentinel alt for the in-progress line (no concluded verdict at render time).
// No verdict label contains "pending", so a concluded line never matches this.
export const ADVISOR_PENDING_ALT = `${ADVISOR_ALT_PREFIX}pending`;
// The exact attribute the in-progress line emits. The cron candidate query
// matches THIS (the full `alt="..."` form, not the bare phrase) so a
// model-generated summary that happens to contain the words can't false-match:
// summaries are HTML-escaped, so a literal `"` in one becomes `&quot;` and can
// never reproduce the real double-quoted attribute.
export const ADVISOR_PENDING_ALT_ATTR = `alt="${ADVISOR_PENDING_ALT}"`;

// The alt text for a concluded verdict line: `AI verdict: <label>`, where the
// label is the same human-readable outcome shown on the badge pill.
export function advisorVerdictAlt(verdict: string, confidence: number): string {
  return `${ADVISOR_ALT_PREFIX}${verdictBadge(verdict, confidence).label}`;
}

export interface AdvisorBadge {
  label: string;
  // Hex fill, e.g. "#2da44e".
  color: string;
  // Use dark text for light (yellow-ish) fills that wash out white text.
  darkText: boolean;
}

// Dispatched but no verdict yet.
export const ANALYZING_BADGE: AdvisorBadge = {
  label: "analyzing",
  color: "#9f9f9f",
  darkText: false,
};

// No verdict and no in-progress dispatch found (race / stale comment).
export const PENDING_BADGE: AdvisorBadge = {
  label: "pending",
  color: "#9f9f9f",
  darkText: false,
};

// A verdict exists, but it answers an analysis of an earlier run of the job at
// the same commit (a rerun), so it says nothing about this one.
export const OUTDATED_BADGE: AdvisorBadge = {
  label: "outdated",
  color: "#9f9f9f",
  darkText: false,
};

// Whether `later` is strictly after `earlier`, both read as UTC. False when
// either is missing, unparseable or the epoch sentinel, so a caller can never
// mistake an unknown time for an ordering. Equality is false because these
// timestamps are truncated and a tie cannot be told apart from either order.
export function isStrictlyAfter(later?: string, earlier?: string): boolean {
  const a = parseUtc(later);
  const b = parseUtc(earlier);
  return a !== null && b !== null && a.isAfter(b);
}

export function parseUtc(ts?: string): dayjs.Dayjs | null {
  if (!ts) return null;
  const d = dayjs.utc(ts);
  return d.isValid() && d.valueOf() > 0 ? d : null;
}

// The latest misc.ai_advisor_dispatches row for one (head, signal key): its
// state and its version (UTC; for a terminal row, just after its pre-dispatch
// row, i.e. before the dispatch captured its evidence). `retryPending` marks a
// failed dispatch that auto-dispatch will retry.
export interface DispatchMark {
  state: string;
  version: string;
  retryPending?: boolean;
}

// Whether a dispatch at `version` was made after the run that finished at
// `completedAt`, so its evidence included that run. completed_at has whole-
// second precision while versions carry milliseconds, so a run recorded at
// 01:13:57 may have finished as late as 01:13:57.999: only a version at or after
// the next whole second counts. False when either time is unknown.
export function dispatchedAfterRun(
  version: string | undefined,
  completedAt: string | undefined
): boolean {
  const v = parseUtc(version);
  const c = parseUtc(completedAt);
  return (
    v !== null &&
    c !== null &&
    v.valueOf() >= c.startOf("second").valueOf() + 1000
  );
}

// A dispatch that was made and not superseded by a failed POST. 'dispatching'
// counts too: its 'dispatched' confirmation write is allowed to fail.
export function isLiveDispatch(
  d?: DispatchMark
): d is DispatchMark & { state: "dispatching" | "dispatched" } {
  return d?.state === "dispatching" || d?.state === "dispatched";
}

// Whether a verdict written at `verdictTimestamp` speaks for the job run that
// finished at `completedAt`. Verdict rows record no analyzed run, only (head,
// job name), so this ties the verdict to a dispatch instead: the latest
// dispatch was made after the run finished, so it analyzed this run, and the
// verdict is newer than that dispatch, so it is taken as that dispatch's
// answer. Comparing the verdict with the run's completion alone is not enough:
// an analysis of an earlier run that is still going when this run finishes
// lands later and passes.
//
// LIMIT: "the newest verdict after the dispatch is its answer" holds while one
// analysis per key is in flight, which auto-dispatch keeps in the normal case
// (readyToReanalyze). It does not hold when two renders dispatch one key at
// the same moment, or when GitHub accepted a dispatch whose POST still threw
// (recorded 'failed', then retried). An earlier analysis can then land after a
// later dispatch and be counted for it. Closing that needs the verdict row to
// record which dispatch it answers.
export function verdictCoversRun(
  verdictTimestamp: string | undefined,
  completedAt: string | undefined,
  dispatch: DispatchMark | undefined
): boolean {
  return (
    isLiveDispatch(dispatch) &&
    dispatchedAfterRun(dispatch.version, completedAt) &&
    isStrictlyAfter(verdictTimestamp, dispatch.version)
  );
}

export type ConfidenceBucket = "high" | "med" | "low";

// Confidence is shown as a word baked into the label, never a number:
//   high >= 0.89, med (0.70, 0.89), low <= 0.70.
export function confidenceBucket(confidence: number): ConfidenceBucket {
  if (confidence >= 0.89) return "high";
  if (confidence > 0.7) return "med";
  return "low";
}

// Map a verdict + confidence to a label and a color on a green -> yellow -> red
// gradient, with "uncertain" (low confidence) pulling toward yellow. The "AI
// verdict:" prefix lives in the comment line, so the badge carries only the
// status text.
export function verdictBadge(
  verdict: string,
  confidence: number
): AdvisorBadge {
  const v = (verdict || "").toLowerCase();

  if (v === "garbage") {
    return { label: "garbage", color: "#6e7781", darkText: false };
  }
  if (v === "infra_issue") {
    // Same "suppressed, not the code's fault" family as garbage, but a
    // distinct blue-grey so reviewers can tell CI-infra failures apart from
    // genuinely corrupt signals.
    return { label: "infra issue", color: "#57606a", darkText: false };
  }
  if (v === "unsure") {
    return { label: "inconclusive", color: "#8b949e", darkText: false };
  }

  const bucket = confidenceBucket(confidence);

  // `related` is the context-neutral successor to `revert`; treat both as the
  // "related to this PR" pole.
  if (v === "related" || v === "revert") {
    if (bucket === "high") {
      return { label: "related", color: "#d1242f", darkText: false };
    }
    if (bucket === "med") {
      return { label: "probably related", color: "#e8702a", darkText: false };
    }
    return { label: "related (uncertain)", color: "#e0a82e", darkText: true };
  }

  if (v === "not_related") {
    if (bucket === "high") {
      return { label: "not related", color: "#2da44e", darkText: false };
    }
    if (bucket === "med") {
      return {
        label: "probably not related",
        color: "#94c11f",
        darkText: true,
      };
    }
    return {
      label: "not related (uncertain)",
      color: "#c9b81a",
      darkText: true,
    };
  }

  // Unknown verdict value -> treat as inconclusive rather than guessing a pole.
  return { label: "inconclusive", color: "#8b949e", darkText: false };
}

// A minimal flat single-segment SVG pill (shields "flat" look, no left label).
export function renderBadgeSvg(badge: AdvisorBadge): string {
  const text = badge.label;
  // Approximate text width; Verdana ~6.5px/char at 11px, plus horizontal pad.
  const width = Math.max(46, Math.round(text.length * 6.5) + 16);
  const textColor = badge.darkText ? "#33333a" : "#ffffff";
  const safe = _.escape(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${safe}">
<title>${safe}</title>
<rect width="${width}" height="20" rx="3" fill="${badge.color}"/>
<text x="${(width / 2).toFixed(
    1
  )}" y="14" fill="${textColor}" font-family="Verdana,DejaVu Sans,Geneva,sans-serif" font-size="11" text-anchor="middle">${safe}</text>
</svg>`;
}

// Absolute URL of the badge image for one (repo, sha, job). Camo fetches it
// server-side; the route resolves the live state, so the same URL flips from
// analyzing to the verdict without the comment changing.
//
// `since` is the job's completed_at. The route then shows only a verdict that
// covers that run (verdictCoversRun), so a rerun at the same commit never shows
// the earlier run's verdict, and each run gets its own URL, which camo caches
// separately.
export function advisorBadgeUrl(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  sha: string,
  jobName: string,
  since?: string
): string {
  const qs = new URLSearchParams({ owner, repo, sha, job: jobName });
  if (since) qs.set("since", since);
  return `${hudBaseUrl}/api/drci/advisorBadge?${qs.toString()}`;
}

function hudPrUrl(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  jobId: number
): string {
  return `${hudBaseUrl}/pr/${owner}/${repo}/${prNumber}#${jobId}`;
}

// In-progress line: just the badge (no expand), linked to HUD. The pill flips
// to the verdict in place once the advisor finishes.
export function renderInProgressLine(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string,
  jobName: string,
  jobId: number,
  since?: string
): string {
  const badge = advisorBadgeUrl(hudBaseUrl, owner, repo, sha, jobName, since);
  const link = hudPrUrl(hudBaseUrl, owner, repo, prNumber, jobId);
  // alt = the pending sentinel: it marks this PR for re-rendering until the
  // verdict lands (see ADVISOR_PENDING_ALT_ATTR) and reads as "AI verdict:
  // pending". Emit the shared attr constant so the cron's match stays in lockstep.
  return `    AI verdict: <a href="${link}"><img ${ADVISOR_PENDING_ALT_ATTR} src="${badge}"></a>\n`;
}

// Outdated line: the only verdict is for an earlier run of this job and no
// analysis is in flight or owed. Says so rather than showing the earlier
// verdict, which the suppression gate ignores for the same reason. The alt is
// not the pending sentinel: with nothing in flight or owed, re-rendering this
// PR every sweep could not change the line.
export function renderOutdatedLine(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string,
  jobName: string,
  jobId: number,
  since?: string
): string {
  const badge = advisorBadgeUrl(hudBaseUrl, owner, repo, sha, jobName, since);
  const link = hudPrUrl(hudBaseUrl, owner, repo, prNumber, jobId);
  return `    AI verdict: <a href="${link}"><img alt="${ADVISOR_ALT_PREFIX}${OUTDATED_BADGE.label}" src="${badge}"></a> (for an earlier run of this job)\n`;
}

// Concluded line: "AI verdict:" plain text toggles the expand; the badge links
// to HUD; the reasoning lives inside the expand.
export function renderVerdictLine(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  sha: string,
  jobName: string,
  jobId: number,
  verdict: string,
  confidence: number,
  summary: string,
  since?: string
): string {
  const badge = advisorBadgeUrl(hudBaseUrl, owner, repo, sha, jobName, since);
  const link = hudPrUrl(hudBaseUrl, owner, repo, prNumber, jobId);
  // alt encodes the concluded outcome (`AI verdict: related`, etc.) so the
  // verdict is machine-readable text in the comment AND no longer matches the
  // pending sentinel, dropping the PR from the re-render candidate set. The
  // label comes from our own verdictBadge map, but escape defensively anyway.
  const altText = _.escape(advisorVerdictAlt(verdict, confidence));
  // The advisor summary is model-generated from (attacker-influenceable) PR
  // content, so HTML-escape it before embedding in the comment: collapse
  // newlines (can't break the blockquote) and neutralize markup so it can't
  // close the <details>/<blockquote> or inject tags.
  const oneLine = _.escape((summary || "").replace(/\s*\n\s*/g, " ").trim());
  return (
    `  <details><summary>AI verdict: <a href="${link}"><img alt="${altText}" src="${badge}"></a></summary><blockquote>\n\n` +
    `  ${oneLine}\n\n` +
    `  <a href="${link}">Full reasoning on HUD &rarr;</a>\n` +
    `  </blockquote></details>\n`
  );
}

// Minimal shapes the pure selector needs (subset of RecentWorkflowsData /
// AdvisorVerdict) so this module stays import-light.
export interface AdvisorLineJob {
  id: number;
  name: string;
  // The job's completed_at. Unset or unparseable means the run cannot be told
  // apart from an earlier one, and any verdict for the job is shown as before.
  completedAt?: string;
}
export interface AdvisorLineVerdict {
  // verdict + confidence drive the badge label baked into the alt text.
  verdict: string;
  confidence: number;
  summary: string;
  timestamp?: string;
}

// Decide the per-job line. Pure so it is unit-testable without ClickHouse.
// Returns job.id -> HTML. In order:
//   - a verdict that covers this run (verdictCoversRun; the suppression gate
//     uses the same test), or any verdict when the run's completion time is
//     unknown: the verdict line;
//   - any other live dispatch: the in-progress line. Either its analysis has
//     not answered yet, or it answered for an earlier run and auto-dispatch
//     owes this run a new one (a rerun). The pending sentinel keeps the PR in
//     the sweep until that work lands, including when a pass skipped it on a
//     transient error;
//   - a failed dispatch that auto-dispatch will retry: the in-progress line,
//     for the same reason;
//   - a verdict with no live or retryable dispatch: the outdated line;
//   - otherwise no line.
// `dispatchByKey` holds the latest dispatch row per signal key, or is null when
// it could not be read. Then nothing can be shown as covering its run, and
// every job gets the in-progress line: its sentinel keeps the PR in the sweep,
// so the next render, with a working read, settles the lines.
export function selectAdvisorLines(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  jobs: AdvisorLineJob[],
  verdictByKey: Map<string, AdvisorLineVerdict>,
  dispatchByKey: Map<string, DispatchMark> | null
): Map<number, string> {
  const out = new Map<number, string>();
  for (const job of jobs) {
    if (!job.name) continue;
    const key = drciSignalKeyForJob(job.name);
    const verdict = verdictByKey.get(key);
    const dispatch = dispatchByKey?.get(key);
    const since = parseUtc(job.completedAt) ? job.completedAt : undefined;
    const args = [
      hudBaseUrl,
      owner,
      repo,
      prNumber,
      headSha,
      job.name,
      job.id,
    ] as const;

    if (
      verdict &&
      (!since || verdictCoversRun(verdict.timestamp, since, dispatch))
    ) {
      out.set(
        job.id,
        renderVerdictLine(
          ...args,
          verdict.verdict,
          verdict.confidence,
          verdict.summary,
          since
        )
      );
    } else if (
      dispatchByKey === null ||
      isLiveDispatch(dispatch) ||
      dispatch?.retryPending
    ) {
      out.set(job.id, renderInProgressLine(...args, since));
    } else if (verdict) {
      out.set(job.id, renderOutdatedLine(...args, since));
    }
  }
  return out;
}
