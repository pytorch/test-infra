import dayjs from "dayjs";
import type {
  CommitRecord,
  CommitTestCounts,
} from "lib/api/tests/commit/summary/types";
import { testsPagePath } from "lib/api/tests/pages/parameters";
import { titleFirstLine, titleSuffix } from "lib/commitTitle";
import type { Hue } from "lib/tests/blockColors";
import {
  BUNDLE_STATUS_WORDS,
  BUNDLE_STATUSES,
  BundleStatus,
  PROBLEM_STATUSES,
} from "lib/tests/bundle";
import type { Crumb } from "lib/tests/header";

// The commit page's rules that are not a bundle's own: how the headline
// reads a commit title, how the header and the rows say times, and what
// the summary row shows for a commit's counts. Free of React, so the tests
// can run them as plain functions.

// A commit title in pieces: text; a span the author set in backticks,
// `not`, which is set as code; and "#202376", which links the pull request.
export type HeadlinePiece =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "pr"; number: number; text: string };

export interface Headline {
  pieces: HeadlinePiece[];
  // The pull request a title ends in, "(#202376)", which is taken off the
  // pieces and shown as the first pill of the facts; null when the title
  // ends in none.
  pullRequest: number | null;
}

const PR_REFERENCE = /(^|[\s("'[])#(\d+)(?=$|[^\w])/g;

function textPieces(text: string): HeadlinePiece[] {
  const pieces: HeadlinePiece[] = [];
  let last = 0;
  for (const match of text.matchAll(PR_REFERENCE)) {
    const start = match.index + match[1].length;
    if (start > last)
      pieces.push({ kind: "text", text: text.slice(last, start) });
    pieces.push({
      kind: "pr",
      number: Number(match[2]),
      text: `#${match[2]}`,
    });
    last = start + match[2].length + 1;
  }
  if (last < text.length) pieces.push({ kind: "text", text: text.slice(last) });
  return pieces;
}

// The headline of a commit title: the title's first line, its trailing
// "(#N)" taken off and kept as the pull request the header's first pill
// names (titleSuffix in lib/commitTitle.ts, which the API reads the title
// by too), backtick spans as code, and any "#N" left in the text, as a
// merge bot's revert names the commit it reverts, as a reference to that
// pull request.
export function headline(title: string): Headline {
  const firstLine = titleFirstLine(title);
  const suffix = titleSuffix(firstLine);
  const text = suffix === null ? firstLine : suffix.text;
  const pieces: HeadlinePiece[] = [];
  const parts = text.split(/`([^`]*)`/);
  parts.forEach((part, index) => {
    if (part === "") return;
    if (index % 2 === 1) pieces.push({ kind: "code", text: part });
    else pieces.push(...textPieces(part));
  });
  return {
    pieces,
    pullRequest: suffix === null ? null : suffix.pullRequest,
  };
}

// When something happened, for a header pill: "Oct 30, 5:09 am" in the
// viewer's time zone, with the exact time for its tooltip.
export function whenLabel(iso: string): string {
  return dayjs(iso).format("MMM D, h:mm a");
}
export function whenExact(iso: string): string {
  return dayjs(iso).format("MMM D, YYYY h:mm:ss a");
}

// When an attempt started, under its row's label: "7:12:21 am".
export function clockLabel(iso: string): string {
  return dayjs(iso).format("h:mm:ss a");
}

// The span the commit's runs took, under the wall time: "5:22 – 9:45 am"
// within one half of a day, "11:50 am – 1:10 pm" across noon, and the days
// named when they differ, "Oct 29, 5:07 pm – Oct 30, 1:10 am".
export function timeRangeLabel(startIso: string, endIso: string): string {
  const start = dayjs(startIso);
  const end = dayjs(endIso);
  if (!start.isSame(end, "day")) {
    return `${start.format("MMM D, h:mm a")} – ${end.format("MMM D, h:mm a")}`;
  }
  const sameHalf = start.format("a") === end.format("a");
  return `${start.format(sameHalf ? "h:mm" : "h:mm a")} – ${end.format(
    "h:mm a"
  )}`;
}

// The summary endpoint's counts of a commit's tests, and the runs' row of
// them. A run is a bundle: one test in one environment, env var set and
// GitHub job with all its attempts, so a test run in twelve jobs is twelve
// runs; the page's figures count runs and call them tests.
export type { CommitTestCounts };
export type RunCounts = CommitTestCounts["total"];

// The summary row's titles for each status, as a category of tests: the
// Outcome cell's words (BUNDLE_STATUS_WORDS), in the plural where the two
// differ.
export const STATUS_TITLES: Record<BundleStatus, string> = {
  ...BUNDLE_STATUS_WORDS,
  xfailed: "Expected failures",
};

// The legend's word for a status: "failed", "timed out", "expected
// failures".
export function statusWord(status: BundleStatus): string {
  return STATUS_TITLES[status].toLowerCase();
}

// The summary row's sizes, in px: the facts' text and the counts' words, and
// the counts' figures, COUNT_FIGURE_SIZE while the counts and the facts share
// the line at it. When the line is short of room the figures shrink a pixel
// at a time, down to the facts' size and no further, so a figure never reads
// smaller than the facts beside it; the gap between counts shrinks with them.
// At the floor the facts wrap under the counts, as they would have.
export const SUMMARY_TEXT_SIZE = 15;
export const COUNT_FIGURE_SIZE = 22;
export const COUNT_FIGURE_MIN_SIZE = SUMMARY_TEXT_SIZE;
export const COUNT_GAP = 30;

// The gap between counts at a figure size: COUNT_GAP at the full size,
// smaller in proportion.
export function countGap(figureSize: number): number {
  return Math.round((COUNT_GAP * figureSize) / COUNT_FIGURE_SIZE);
}

// The largest figure size, from COUNT_FIGURE_SIZE down a pixel at a time, at
// which the counts on one line (`widthAt`, measured at that size) fit the
// width left beside the facts; COUNT_FIGURE_MIN_SIZE when none above it
// does.
export function fittingCountSize(
  available: number,
  widthAt: (_figureSize: number) => number
): number {
  for (let size = COUNT_FIGURE_SIZE; size > COUNT_FIGURE_MIN_SIZE; size--) {
    if (widthAt(size) <= available) return size;
  }
  return COUNT_FIGURE_MIN_SIZE;
}

// The hue of each status in the summary's bar and legend: the Health
// cells' red for the failing statuses, yellow for flaky, green for passed,
// purple for skipped; null is the neutral grey of the grid's "other" cell,
// for the expected failures and the rest.
export const SUMMARY_STATUS_HUES: Record<BundleStatus, Hue | null> = {
  failed: "red",
  timed_out: "red",
  flaky: "yellow",
  passed: "green",
  other: null,
  xfailed: null,
  skipped: "purple",
};

// The hue a problem status is marked with, in the legend's counts and the
// table's Outcome blocks: failed and timed out red, flaky yellow; null for
// the rest, which stay plain.
export function problemHue(status: BundleStatus): Hue | null {
  return PROBLEM_STATUSES.includes(status) ? SUMMARY_STATUS_HUES[status] : null;
}

// A status with runs, as the summary's bar and legend show it.
export interface SummaryStatus {
  status: BundleStatus;
  counts: RunCounts;
  // The segment's width relative to the others', log10(runs + 1).
  weight: number;
  // The status's true share of the runs, "51.4%" or "under 0.01%".
  share: string;
}

// The statuses with runs, in BUNDLE_STATUSES order, each weighted for the
// bar by log10(runs + 1): a handful of failures beside millions of passes
// gets a visible width. So the bar is not to scale; the share says what
// the proportion is.
export function summaryStatuses(counts: CommitTestCounts): SummaryStatus[] {
  return BUNDLE_STATUSES.flatMap((status) => {
    const statusCounts = counts.by_status[status];
    if (statusCounts.runs === 0) return [];
    return [
      {
        status,
        counts: statusCounts,
        weight: Math.log10(statusCounts.runs + 1),
        share: shareLabel(statusCounts.runs, counts.total.runs),
      },
    ];
  });
}

// A status's share of the runs to three figures, "51.4%", "0.883%"; below
// a hundredth of a percent, "under 0.01%", and short of the whole but
// rounding to it, "over 99.9%", so no status reads as every run beside
// another with runs.
export function shareLabel(runs: number, total: number): string {
  if (total === 0) return "0%";
  const share = (100 * runs) / total;
  if (share < 0.01) return "under 0.01%";
  const rounded = Number(share.toPrecision(3));
  if (rounded >= 100 && runs < total) return "over 99.9%";
  return `${rounded}%`;
}

// Whether the commit has runs and none failed, timed out or was flaky: the
// legend then leads with "Every test passed".
export function allPassed(counts: CommitTestCounts): boolean {
  return (
    counts.total.runs > 0 &&
    PROBLEM_STATUSES.every((status) => counts.by_status[status].runs === 0)
  );
}

// The pull request a commit belongs to, by number: its own, as the API
// records it, else the one its title ends in, "(#202376)"; null for
// neither, a merge bot's revert.
export function commitPullRequestNumber(
  commit: Pick<CommitRecord, "title" | "pull_request">
): number | null {
  return commit.pull_request?.number ?? headline(commit.title).pullRequest;
}

// Where the commit page's subject lives, as the header's breadcrumb: the
// repository, linking the tests list; for a pull request head the pull
// request's number, linking its page, else the branch, linking HUD's view
// of it; and the commit's short SHA, the page itself, which links nowhere.
export function commitCrumbs(
  repo: string,
  commit: Pick<
    CommitRecord,
    "sha" | "branch" | "pull_request_head" | "pull_request"
  >
): Crumb[] {
  const crumbs: Crumb[] = [{ text: repo, href: testsPagePath(repo) }];
  if (!commit.pull_request_head && commit.branch !== null) {
    crumbs.push({
      text: commit.branch,
      href: `/hud/${repo}/${encodeURIComponent(commit.branch)}/1`,
    });
  } else if (commit.pull_request !== null) {
    crumbs.push({
      text: `#${commit.pull_request.number}`,
      href: commit.pull_request.url,
    });
  }
  crumbs.push({ text: shortSha(commit.sha) });
  return crumbs;
}

// The seven characters a commit is known by.
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// The page of a pull request the headline names: the commit's own pull
// request's page when it is the one named, else GitHub's for the number.
export function pullRequestUrl(
  repo: string,
  number: number,
  commit: Pick<CommitRecord, "pull_request">
): string {
  return commit.pull_request !== null && commit.pull_request.number === number
    ? commit.pull_request.url
    : `https://github.com/${repo}/pull/${number}`;
}
