// Pure rendering of the automated PR review section of the Dr.CI comment, from
// the latest misc.pr_review_verdicts row for a PR. The rows are written by the
// hardened PR review workflow (scripts/pr_review/emit_row.py), which runs in
// pytorch/pytorch and, before it, ran in pytorch/ciforge.
// No ClickHouse / Octokit / server-only imports, so this is unit-testable as-is.
//
// `summary` and the findings are model output on untrusted PRs. The workflow's
// sanitizer defuses links, mentions and HTML but leaves markdown structure alone,
// so containment is this file's job: every model-written string goes into a code
// fence after the sweep sentinels are broken (see getPRsNeedingCommentRefresh in
// drci.ts). Its timing constants and text helpers are its own, not Green Light's,
// so a change to Green Light cannot change this section. The one thing shared is
// the sweep-sentinel vocabulary and its defuse, which every renderer writing into
// the Dr.CI comment must use (lib/greenlight/greenlightSweep.ts).

import {
  defuseSweepSentinels,
  PR_REVIEW_PENDING_ALT_ATTR,
  ZERO_WIDTH_SPACE,
} from "lib/greenlight/greenlightSweep";

export const PR_REVIEW_SECTION_HEADER = "AUTOMATED REVIEW";

export const PR_REVIEW_IN_PROGRESS_HEADLINE = "Review in progress";
export const PR_REVIEW_READY_HEADLINE = "Ready for human review";
export const PR_REVIEW_CHANGES_HEADLINE = "Changes requested";
export const PR_REVIEW_TOO_LARGE_HEADLINE = "Skipped, PR too large to review";
export const PR_REVIEW_INCOMPLETE_HEADLINE = "Review did not complete";
export const PR_REVIEW_OUTDATED_PREFIX = "OUTDATED (earlier commit) - ";

const READY_EMOJI = "✅";
const CHANGES_EMOJI = "🟡";
const IN_PROGRESS_EMOJI = "⏳";
const NO_VERDICT_EMOJI = "⚪";

// A `started` row older than this renders as "did not complete": the review job
// is capped at 90 minutes (hardened-pr-review-run.yml), so a run older than that
// plus slack for queueing will never write its terminal row.
export const PR_REVIEW_IN_PROGRESS_STALE_MS = 2 * 60 * 60 * 1000;

// Emitted only while a review is live, so Dr.CI keeps re-rendering the PR until
// the verdict lands or the run goes stale (getPRsNeedingCommentRefresh in
// drci.ts). Every other render omits it, which is how the PR leaves that set.
// What brings the PR into the sweep when a review starts is the review's Stage 1
// `capture` job, which runs on the PR head (the review itself runs on main).
const PR_REVIEW_PENDING_MARKER = `<!-- pr-review ${PR_REVIEW_PENDING_ALT_ATTR} -->`;

// Code points of model text one fence may carry, and the findings budget below
// it, so a finding is dropped whole and counted rather than cut mid-message.
export const PR_REVIEW_MESSAGE_CAP = 4000;
export const PR_REVIEW_FINDINGS_BUDGET = 3500;
const WRAP_WIDTH = 100;

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

// The PR status splicer (lib/prStatus.ts) and comment lookups find their
// sections by raw `<!-- ... -->` markers, so text this section writes must
// never carry a comment opener: one could make them cut into the section.
export function escapeCommentOpeners(text: string): string {
  return text.split("<!--").join("&lt;!--");
}

// Undo the sanitizer's markdown escapes (`\[`, `\_`, `\#` and the HTML
// entities). They keep text inert when rendered as markdown, but inside a fence
// they would show as literal backslashes and `&lt;`. Comment openers stay
// escaped (above).
export function unescapeSanitized(text: string): string {
  return escapeCommentOpeners(
    (text || "")
      .replace(/\\([[\]()@#*_])/g, "$1")
      .split("&lt;")
      .join("<")
      .split("&gt;")
      .join(">")
      .split("&amp;")
      .join("&")
  );
}

// Greedy wrap of one line. Whitespace runs are kept as written except where a
// break replaces one with a newline, so wrapping never joins text together.
function wrapLine(line: string): string {
  if (line.length <= WRAP_WIDTH) {
    return line;
  }
  // Odd indices are whitespace runs, even indices the words between them.
  const parts = line.split(/(\s+)/);
  const out: string[] = [];
  let current = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const word = parts[i + 1] ?? "";
    if (
      current.trim() &&
      current.length + parts[i].length + word.length > WRAP_WIDTH
    ) {
      out.push(current);
      current = word;
    } else {
      current = `${current}${parts[i]}${word}`;
    }
  }
  out.push(current);
  return out.join("\n");
}

// Cap, neutralize @-mentions, wrap, and seal in a fence longer than any backtick
// run the text holds, so it cannot break out. Not HTML-escaped: the fence is the
// containment, and GitHub escapes a code block's content.
export function fenceModelText(text: string): string {
  const capped = Array.from(text || "")
    .slice(0, PR_REVIEW_MESSAGE_CAP)
    .join("");
  const neutralized = capped.split("@").join(`@${ZERO_WIDTH_SPACE}`);
  // Defused again after the wrap, so no change the wrap makes can matter.
  const wrapped = defuseSweepSentinels(
    neutralized.split("\n").map(wrapLine).join("\n")
  );
  const runs = wrapped.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((run) => run.length)) : 0;
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${wrapped}\n${fence}`;
}

function fence(text: string): string {
  return fenceModelText(defuseSweepSentinels(unescapeSanitized(text)));
}

// One inline code span: backticks and line breaks removed so the value cannot
// end the span or the line.
function inlineCode(value: string): string {
  return `\`${(value || "").replace(/[`\r\n]/g, "")}\``;
}

function isOutdated(reviewedSha: string, currentSha: string): boolean {
  const reviewed = (reviewedSha || "").trim().toLowerCase();
  const current = (currentSha || "").trim().toLowerCase();
  return reviewed !== "" && current !== "" && reviewed !== current;
}

function commitLines(headSha: string, currentHeadSha: string): string[] {
  const sha = (headSha || "").trim();
  if (!sha) {
    return [];
  }
  const line = `Reviewed commit: ${inlineCode(sha.slice(0, 7))}`;
  return isOutdated(sha, currentHeadSha)
    ? [
        `${line} (NOT the current head ${inlineCode(
          currentHeadSha.slice(0, 7)
        )})`,
      ]
    : [line];
}

// ClickHouse serves DateTime64 zone-less (`2026-10-01 19:50:00.000`); the server
// runs in UTC, so build the epoch explicitly rather than let Date.parse read it
// as local time. NaN when unparseable.
function timestampMs(value: string): number {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(
      (value || "").trim()
    );
  if (!m) {
    return Date.parse(value);
  }
  return Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number((m[7] ?? "").slice(0, 3).padEnd(3, "0"))
  );
}

// A missing or far-future timestamp counts as stale, so a broken row cannot
// keep the pending sentinel (and the PR in every sweep) alive.
export function isReviewRunStale(timestamp: string, now: Date): boolean {
  const ms = timestampMs(timestamp);
  return (
    Number.isNaN(ms) ||
    Math.abs(now.getTime() - ms) >= PR_REVIEW_IN_PROGRESS_STALE_MS
  );
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
// fits the budget is what reaches the fence. `unparsed` counts findings the row
// reports that could not be shown at all.
function findingsText(findings: Finding[], unparsed: number): string {
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
  const hidden = findings.length - blocks.length + unparsed;
  if (hidden > 0) {
    blocks.push(`(${hidden} more not shown, see the review run)`);
  }
  return defuseSweepSentinels(blocks.join("\n\n"));
}

function findingsLines(row: PrReviewRow): string[] {
  const findings = parseFindings(row.findings_json);
  const count = Math.max(Number(row.findings_count) || 0, findings.length);
  if (findings.length > 0) {
    return [
      "",
      `**Findings (${count}):**`,
      fenceModelText(findingsText(findings, count - findings.length)),
    ];
  }
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
    ...commitLines(row.head_sha, currentHeadSha).map(escapeCommentOpeners),
  ];
  const runUrl = reviewRunUrl(repo, row.review_run_id);
  if (runUrl) {
    lines.push("", `[Review run](${runUrl})`);
  }
  const summary = isOutdated(row.head_sha, currentHeadSha)
    ? `${PR_REVIEW_OUTDATED_PREFIX}${headline}`
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
    if (isReviewRunStale(row.timestamp, now)) {
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
  // for the author. The status vocabulary is open-ended, so it gets the same
  // marker escape as model text.
  return renderSection(
    NO_VERDICT_EMOJI,
    PR_REVIEW_INCOMPLETE_HEADLINE,
    [
      escapeCommentOpeners(
        defuseSweepSentinels(`reason: ${inlineCode(status)}`)
      ),
    ],
    row,
    repo,
    currentHeadSha
  );
}
