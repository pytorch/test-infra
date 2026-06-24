// Pure rendering helpers for the AI CI Advisor verdict surfaced in the Dr.CI
// comment (no server-only imports, so this is unit-testable and importable
// anywhere). Two outputs:
//   - renderBadgeSvg: the colored status pill served by the advisorBadge API
//     route (the <img> in the comment points at that route so it can flip
//     analyzing -> verdict server-side without rewriting the comment).
//   - selectAdvisorLines / renderVerdictLine / renderInProgressLine: the
//     "AI verdict:" line emitted under each new failure in the comment.

import _ from "lodash";

// The signal_key prefix for HUD-originated (Dr.CI) advisor dispatches. Mirrors
// signalKeyForJob() in advisorDispatch.ts; duplicated here to keep this module
// free of any server-only imports.
export const DRCI_SIGNAL_KEY_PREFIX = "dr_ci_";

export function drciSignalKeyForJob(fullJobName: string): string {
  return `${DRCI_SIGNAL_KEY_PREFIX}${fullJobName}`;
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
export function advisorBadgeUrl(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  sha: string,
  jobName: string
): string {
  const qs = new URLSearchParams({ owner, repo, sha, job: jobName });
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
  jobId: number
): string {
  const badge = advisorBadgeUrl(hudBaseUrl, owner, repo, sha, jobName);
  const link = hudPrUrl(hudBaseUrl, owner, repo, prNumber, jobId);
  return `    AI verdict: <a href="${link}"><img src="${badge}"></a>\n`;
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
  summary: string
): string {
  const badge = advisorBadgeUrl(hudBaseUrl, owner, repo, sha, jobName);
  const link = hudPrUrl(hudBaseUrl, owner, repo, prNumber, jobId);
  // The advisor summary is model-generated from (attacker-influenceable) PR
  // content, so HTML-escape it before embedding in the comment: collapse
  // newlines (can't break the blockquote) and neutralize markup so it can't
  // close the <details>/<blockquote> or inject tags.
  const oneLine = _.escape((summary || "").replace(/\s*\n\s*/g, " ").trim());
  return (
    `  <details><summary>AI verdict: <a href="${link}"><img src="${badge}"></a></summary><blockquote>\n\n` +
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
}
export interface AdvisorLineVerdict {
  summary: string;
}

// Decide the per-job line: a finalized verdict wins; otherwise an in-progress
// dispatch ('dispatching'/'dispatched') shows the analyzing badge; otherwise no
// line. Pure so it is unit-testable without ClickHouse. Returns job.id -> HTML.
export function selectAdvisorLines(
  hudBaseUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  jobs: AdvisorLineJob[],
  verdictByKey: Map<string, AdvisorLineVerdict>,
  inProgressKeys: Set<string>
): Map<number, string> {
  const out = new Map<number, string>();
  for (const job of jobs) {
    if (!job.name) continue;
    const key = drciSignalKeyForJob(job.name);
    const verdict = verdictByKey.get(key);
    if (verdict) {
      out.set(
        job.id,
        renderVerdictLine(
          hudBaseUrl,
          owner,
          repo,
          prNumber,
          headSha,
          job.name,
          job.id,
          verdict.summary
        )
      );
      continue;
    }
    if (inProgressKeys.has(key)) {
      out.set(
        job.id,
        renderInProgressLine(
          hudBaseUrl,
          owner,
          repo,
          prNumber,
          headSha,
          job.name,
          job.id
        )
      );
    }
  }
  return out;
}
