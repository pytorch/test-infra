// Pure rendering of the automated PR review section of the Dr.CI comment, from
// the latest misc.pr_review_verdicts row for a PR. pytorch/pytorch's hardened PR
// review workflow writes those rows (scripts/pr_review/emit_row.py there).
// No ClickHouse / Octokit / server-only imports, so this is unit-testable as-is.
//
// `summary` and the findings are model output on untrusted PRs. The workflow's
// sanitizer defuses links, mentions and HTML but leaves markdown structure alone,
// so containment is this file's job: every model-written string goes into a code
// fence through the same defang Green Light uses, after the sweep sentinels are
// broken (see getPRsNeedingCommentRefresh in drci.ts).

import {
  isOutdatedVerdict,
  reviewedCommitLines,
} from "lib/greenlight/greenlightCommitLine";
import { inlineCode } from "lib/greenlight/greenlightInlineCode";
import {
  defangGreenlightMessage,
  GREENLIGHT_OUTDATED_HEADLINE_PREFIX,
} from "lib/greenlight/greenlightRender";
import { isInProgressStale } from "lib/greenlight/greenlightStaleness";
import {
  defuseSweepSentinels,
  PR_REVIEW_PENDING_ALT_ATTR,
} from "lib/greenlight/greenlightSweep";

export const PR_REVIEW_SECTION_HEADER = "AUTOMATED REVIEW";

export const PR_REVIEW_IN_PROGRESS_HEADLINE = "Review in progress";
export const PR_REVIEW_READY_HEADLINE = "Ready for human review";
export const PR_REVIEW_CHANGES_HEADLINE = "Changes requested";
export const PR_REVIEW_TOO_LARGE_HEADLINE = "Skipped, PR too large to review";
export const PR_REVIEW_INCOMPLETE_HEADLINE = "Review did not complete";

const READY_EMOJI = "✅";
const CHANGES_EMOJI = "🟡";
const IN_PROGRESS_EMOJI = "⏳";
const NO_VERDICT_EMOJI = "⚪";

// Emitted only while a review is live, so Dr.CI keeps re-rendering the PR until
// the verdict lands or the run goes stale (getPRsNeedingCommentRefresh in
// drci.ts). Every other render omits it, which is how the PR leaves that set.
// What brings the PR into the sweep when a review starts is the review's Stage 1
// `capture` job, which runs on the PR head (the review itself runs on main).
const PR_REVIEW_PENDING_MARKER = `<!-- pr-review ${PR_REVIEW_PENDING_ALT_ATTR} -->`;

// Room for the findings fence, leaving headroom under the defang cap (4000) so a
// finding is dropped whole and counted, never cut off mid-message.
export const PR_REVIEW_FINDINGS_BUDGET = 3500;

const SEVERITY_ORDER = ["major", "minor", "info"];

// The latest misc.pr_review_verdicts row for one PR, as the
// pr_review_verdicts_for_prs saved query returns it.
export interface PrReviewRow {
  pr_number: number;
  head_sha: string;
  status: string;
  verdict: string | null;
  summary: string;
  findings_count: number;
  // extra['findings']: a JSON array of the sanitized findings, "" when absent.
  findings_json: string;
  review_run_id: number | string;
  timestamp: string;
}

interface Finding {
  path: string;
  line: number;
  severity: string;
  message: string;
}

// Undo the sanitizer's markdown escapes (`\[`, `\_`, `\#` and the HTML
// entities). They keep text inert when rendered as markdown, but inside a fence
// they would show as literal backslashes and `&lt;`. The fence contains the
// rendering, but not code that edits the RAW body: the PR status splicer
// (lib/prStatus.ts) and comment lookups find their sections by `<!-- ... -->`
// markers, so a restored marker could make them cut text out of this section,
// fence included. Every comment opener therefore stays escaped.
export function unescapeSanitized(text: string): string {
  return (text || "")
    .replace(/\\([[\]()@#*_])/g, "$1")
    .split("&lt;")
    .join("<")
    .split("&gt;")
    .join(">")
    .split("&amp;")
    .join("&")
    .split("<!--")
    .join("&lt;!--");
}

function fence(text: string): string {
  return defangGreenlightMessage(defuseSweepSentinels(unescapeSanitized(text)));
}

export function parseFindings(findingsJson: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(findingsJson || "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const findings = parsed.filter(
    (f): f is Finding =>
      typeof f === "object" &&
      f !== null &&
      typeof f.path === "string" &&
      Number.isSafeInteger(f.line) &&
      SEVERITY_ORDER.includes(f.severity) &&
      typeof f.message === "string"
  );
  // Stable sort: the model's order is kept within a severity.
  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );
}

// Measured after unescaping and defusing, which change the length, so what
// fits the budget is what reaches the fence.
function findingsText(findings: Finding[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (const f of findings) {
    const block = defuseSweepSentinels(
      unescapeSanitized(`[${f.severity}] ${f.path}:${f.line}\n${f.message}`)
    );
    // A block bigger than the whole budget would be cut mid-message by the
    // fence's cap, taking the "more not shown" line with it: count it as hidden.
    if (block.length > PR_REVIEW_FINDINGS_BUDGET) {
      continue;
    }
    if (used + block.length > PR_REVIEW_FINDINGS_BUDGET) {
      break;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  const hidden = findings.length - blocks.length;
  if (hidden > 0) {
    blocks.push(`(${hidden} more not shown, see the review run)`);
  }
  return defuseSweepSentinels(blocks.join("\n\n"));
}

function findingsLines(row: PrReviewRow): string[] {
  const findings = parseFindings(row.findings_json);
  if (findings.length > 0) {
    return [
      "",
      `**Findings (${findings.length}):**`,
      defangGreenlightMessage(findingsText(findings)),
    ];
  }
  const count = Number(row.findings_count) || 0;
  if (count > 0) {
    // Rows written before the workflow recorded findings text carry only a count.
    return [
      "",
      `${count} finding(s); the text is in the review run's "Sanitize the verdict" step.`,
    ];
  }
  return [];
}

function reviewRunUrl(repo: string, runId: number | string): string {
  const id = Number(runId);
  return Number.isSafeInteger(id) && id > 0
    ? `https://github.com/${repo}/actions/runs/${id}`
    : "";
}

function renderSection(
  emoji: string,
  headline: string,
  bodyLines: string[],
  row: PrReviewRow,
  repo: string,
  currentHeadSha: string,
  inProgress: boolean = false
): string {
  const lines = [
    ...bodyLines,
    "",
    ...reviewedCommitLines(row.head_sha, currentHeadSha),
  ];
  const runUrl = reviewRunUrl(repo, row.review_run_id);
  if (runUrl) {
    lines.push("", `[Review run](${runUrl})`);
  }
  const summary = isOutdatedVerdict(row.head_sha, currentHeadSha)
    ? `${GREENLIGHT_OUTDATED_HEADLINE_PREFIX}${headline}`
    : headline;
  // Two newlines after <p> so the body is parsed as markdown, matching the
  // other Dr.CI sections.
  const marker = inProgress ? `${PR_REVIEW_PENDING_MARKER}\n` : "";
  return (
    `\n${marker}<details><summary>${emoji} <b>${PR_REVIEW_SECTION_HEADER}</b> - ${summary}:</summary><p>\n\n` +
    `${lines.join("\n")}\n\n` +
    `</p></details>`
  );
}

// `repo` is the canonical owner/name the row was read under; `currentHeadSha` is
// the PR's head at render time. Returns "" when the row has nothing to show.
export function renderPrReviewSection(
  row: PrReviewRow,
  repo: string,
  now: Date,
  currentHeadSha: string
): string {
  const status = (row.status || "").trim();
  const verdict = (row.verdict || "").trim();

  if (status === "started") {
    if (isInProgressStale(row.timestamp, now)) {
      return renderSection(
        NO_VERDICT_EMOJI,
        PR_REVIEW_INCOMPLETE_HEADLINE,
        ["No result was recorded for this review run."],
        row,
        repo,
        currentHeadSha
      );
    }
    return renderSection(
      IN_PROGRESS_EMOJI,
      PR_REVIEW_IN_PROGRESS_HEADLINE,
      ["An automated review of this PR is running."],
      row,
      repo,
      currentHeadSha,
      true
    );
  }

  if (status === "succeeded") {
    if (
      verdict !== "ready_for_human_review" &&
      verdict !== "changes_requested"
    ) {
      return "";
    }
    const ready = verdict === "ready_for_human_review";
    return renderSection(
      ready ? READY_EMOJI : CHANGES_EMOJI,
      ready ? PR_REVIEW_READY_HEADLINE : PR_REVIEW_CHANGES_HEADLINE,
      [fence(row.summary), ...findingsLines(row)],
      row,
      repo,
      currentHeadSha
    );
  }

  if (status === "skipped_too_large") {
    return renderSection(
      NO_VERDICT_EMOJI,
      PR_REVIEW_TOO_LARGE_HEADLINE,
      [
        "This PR is over the automated review's size limit, so it was not reviewed.",
      ],
      row,
      repo,
      currentHeadSha
    );
  }

  if (status === "") {
    return "";
  }
  // Every other terminal status is a run that produced no verdict. Its failure
  // detail is not shown: it can quote model output and it is not actionable
  // for the author.
  return renderSection(
    NO_VERDICT_EMOJI,
    PR_REVIEW_INCOMPLETE_HEADLINE,
    // The status vocabulary is open-ended, so keep raw-body markers out of it
    // as for model text.
    [
      defuseSweepSentinels(`reason: ${inlineCode(status)}`)
        .split("<!--")
        .join("&lt;!--"),
    ],
    row,
    repo,
    currentHeadSha
  );
}
