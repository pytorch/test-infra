// Turning "this verdict is wrong" into the body of a pytorch/test-infra issue.
//
// Everything here is pure -- no ClickHouse, no Octokit, no server-only imports --
// so the wording and the validation are unit-testable, and the React panel can
// import the same caps it will be held to instead of guessing them.
//
// Two different kinds of untrusted text meet in the body this builds, and they
// are contained differently on purpose:
//
//   - The verdict `message` is model-authored and PR-influenceable, so it goes
//     through defangGreenlightMessage: capped, @-neutralized, and sealed in a
//     fence longer than any backtick run inside it. Same treatment it already
//     gets in the Dr.CI comment.
//   - The reporter's own comment is a human writing prose they intend to publish,
//     so it renders as markdown, mentions and all. It is capped, and it is placed
//     LAST, below the facts block, so nothing it says can be mistaken for the part
//     of the body the server wrote.
//
// Deliberately NOT run through defuseSweepSentinels. That defuse exists so a
// rendered verdict cannot pin its PR into Dr.CI's re-render sweep forever; the
// sweep greps comment bodies on pytorch/pytorch PRs, and nothing in it ever looks
// at a test-infra issue. Defusing here would only smuggle zero-width spaces into
// text a human triager is going to copy back out.

import { isGreenlightRepo } from "lib/greenlight/greenlightConfig";
import { inlineCode, shortSha } from "lib/greenlight/greenlightInlineCode";
import { capCodePoints } from "lib/greenlight/greenlightOutline";
import {
  defangGreenlightMessage,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
} from "lib/greenlight/greenlightRender";
import { GREENLIGHT_HUD_BASE_URL } from "lib/greenlight/greenlightReportLink";

/** Where the reports land. Not configurable: the triage board is pinned to it. */
export const GREENLIGHT_REPORT_OWNER = "pytorch";
export const GREENLIGHT_REPORT_REPO = "test-infra";

/**
 * The distinguishing prefix. Kept literal and kept first in the title so the
 * board, a search, and a notification filter all key off the same string.
 */
export const GREENLIGHT_REPORT_TITLE_PREFIX = "[GreenLight policy]";

/** Already exists on pytorch/test-infra; spelled exactly as GitHub has it. */
export const GREENLIGHT_REPORT_LABEL = "Greenlight: policy triage";

/**
 * pytorch/projects/177, "GreenLight Policies Reviews". The node id rather than
 * the number: addProjectV2ItemById takes an id, and resolving the number would
 * cost a round trip on every report to learn a constant.
 */
export const GREENLIGHT_REPORT_PROJECT_ID = "PVT_kwDOAUB9vs4BftWs";
export const GREENLIGHT_REPORT_PROJECT_URL =
  "https://github.com/orgs/pytorch/projects/177";

/**
 * The reporter's own prose. Same cap the verdict message gets: long enough for a
 * real explanation with a stack trace in it, short enough that a paste of a whole
 * log does not become the issue.
 */
export const GREENLIGHT_REPORT_COMMENT_CAP = 4000;

/** GitHub rejects a longer title outright. */
export const GREENLIGHT_REPORT_TITLE_CAP = 256;

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

// eval_job reaches this module from a database column, so the host has to be
// anchored: a userinfo prefix (`https://u:p@github.com/`) and a lookalike host
// (`https://github.com.example/`) both satisfy a mere "contains github.com". Same
// expression the panel and the comment renderer guard the link with.
const SAFE_JOB_URL_RE = /^https:\/\/github\.com\/[^\s()<>"'\\]+$/;

/**
 * The verdicts a report can be filed against: the two that are a judgement.
 * CANCELLED, FAILED and the in-flight statuses are the absence of a verdict and
 * REVERTED is an exclusion from review, so there is nothing there to be wrong
 * about -- and a bot-authored issue saying otherwise would be inventing one.
 */
export function isReportableStatus(status: string | undefined | null): boolean {
  const trimmed = (status ?? "").trim();
  return (
    trimmed === GREENLIGHT_STATUS_LAND || trimmed === GREENLIGHT_STATUS_NO_LAND
  );
}

/** What the browser sends. Every field is re-derived or re-checked server-side. */
export interface GreenlightReportRequest {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  sha: string;
  comment: string;
}

export type ParsedReportRequest =
  | { ok: true; value: GreenlightReportRequest }
  | { ok: false; error: string };

/**
 * Validate a POST body into a request.
 *
 * Note what is NOT here: the status, the reason, and the verdict message. The
 * issue is authored by a bot, so a client that could name the verdict could have
 * the bot publish a verdict Green Light never reached. The caller looks those up
 * from `misc.greenlight_pr_state` itself, keyed by the (repo, pr, sha) below.
 */
export function parseReportRequest(raw: unknown): ParsedReportRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "Request body must be a JSON object" };
  }
  const body = raw as Record<string, unknown>;

  const repoOwner = typeof body.repoOwner === "string" ? body.repoOwner : "";
  const repoName = typeof body.repoName === "string" ? body.repoName : "";
  if (!NAME_RE.test(repoOwner) || !NAME_RE.test(repoName)) {
    return { ok: false, error: "repoOwner and repoName must be repo names" };
  }
  // The same gate the panel renders behind. A repo Green Light does not review
  // has no state to dispute, so a report against one is a bot-authored issue
  // about nothing.
  if (!isGreenlightRepo(repoOwner, repoName)) {
    return { ok: false, error: "Green Light does not review this repository" };
  }

  const prNumber = Number(body.prNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: "prNumber must be a positive integer" };
  }

  const sha = typeof body.sha === "string" ? body.sha.trim() : "";
  if (!FULL_SHA_RE.test(sha)) {
    return { ok: false, error: "sha must be a full 40-character commit sha" };
  }

  // Required, not optional. A report with no explanation gives the triager the
  // verdict they could already read on the HUD and nothing else.
  const rawComment = typeof body.comment === "string" ? body.comment : "";
  const comment = rawComment.trim();
  if (comment === "") {
    return { ok: false, error: "comment is required" };
  }

  return {
    ok: true,
    value: {
      repoOwner,
      repoName,
      prNumber,
      sha: sha.toLowerCase(),
      comment: capCodePoints(comment, GREENLIGHT_REPORT_COMMENT_CAP),
    },
  };
}

/** The verdict as the server read it back, not as the browser described it. */
export interface GreenlightReportSubject {
  repoOwner: string;
  repoName: string;
  prNumber: number;
  /** The commit the verdict was reached on. */
  headSha: string;
  /** The trunk commit it landed as, or "" if it never landed. */
  mergeCommitSha: string;
  status: string;
  reason: string;
  message: string;
  evalJob: string;
  version: string;
}

function repoFullName(subject: GreenlightReportSubject): string {
  return `${subject.repoOwner}/${subject.repoName}`;
}

/**
 * `[GreenLight policy] Wrong NO_LAND verdict on pytorch/pytorch#123 (abc1234)`.
 *
 * The status is in the title because it is the one thing that decides which of
 * two very different bugs this is -- a false approval or a false refusal -- and
 * a board where both read the same is a board nobody can skim.
 */
export function buildReportTitle(subject: GreenlightReportSubject): string {
  const title =
    `${GREENLIGHT_REPORT_TITLE_PREFIX} Wrong ${subject.status.trim()} verdict on ` +
    `${repoFullName(subject)}#${subject.prNumber} ` +
    `(${subject.headSha.trim().slice(0, 7)})`;
  return capCodePoints(title, GREENLIGHT_REPORT_TITLE_CAP);
}

/**
 * A machine-readable restatement of the subject, invisible once GitHub renders
 * the body. Nothing reads it yet; it is what a later dedup pass or a metrics
 * query would key on, and it costs one line to emit now versus reparsing English
 * later. Every value in it is constrained by parseReportRequest or by the status
 * vocabulary, so none of them can carry a `-->`.
 */
export function reportMarker(subject: GreenlightReportSubject): string {
  return (
    `<!-- greenlight-policy-report v1 repo=${repoFullName(subject)} ` +
    `pr=${subject.prNumber} sha=${subject.headSha.trim().toLowerCase()} ` +
    `status=${subject.status.trim()} -->`
  );
}

function factLines(subject: GreenlightReportSubject): string[] {
  const repo = repoFullName(subject);
  const headSha = subject.headSha.trim();
  const mergeSha = subject.mergeCommitSha.trim();
  const reason = subject.reason.trim();
  const version = subject.version.trim();
  const evalJob = subject.evalJob.trim();

  // Cross-repo autolinks: `owner/repo#123` and `owner/repo@sha` both resolve from
  // an issue in another repository, so the reader gets a live reference and a
  // hover card rather than a bare URL.
  const lines = [
    `- **Pull request:** ${repo}#${subject.prNumber}`,
    `- **Reviewed commit:** ${repo}@${headSha}`,
  ];
  if (mergeSha !== "") {
    lines.push(`- **Landed on trunk as:** ${repo}@${mergeSha}`);
  }
  lines.push(`- **Verdict:** ${inlineCode(subject.status.trim())}`);
  if (reason !== "") {
    lines.push(`- **Reason:** ${inlineCode(reason)}`);
  }
  if (version !== "") {
    lines.push(`- **Recorded at:** ${inlineCode(version)}`);
  }
  lines.push(
    `- **HUD:** ${GREENLIGHT_HUD_BASE_URL}/${repo}/pull/${subject.prNumber}`,
    `- **Commit page:** ${GREENLIGHT_HUD_BASE_URL}/${repo}/commit/${headSha}`
  );
  // Bare, never `[text](url)`: the guard proves the URL is a github.com one, not
  // that it is free of the characters that would break out of a link target.
  if (SAFE_JOB_URL_RE.test(evalJob)) {
    lines.push(`- **Inference job:** ${evalJob}`);
  }
  return lines;
}

/**
 * The issue body.
 *
 * `reporter` is the login the server authenticated, never one the browser named.
 * It is stated on the first visible line because the issue is authored by the
 * bot: without it the body has no author, and a reporter can write anything they
 * like further down.
 */
export function buildReportBody({
  subject,
  reporter,
  comment,
}: {
  subject: GreenlightReportSubject;
  reporter: string;
  comment: string;
}): string {
  const sections = [
    reportMarker(subject),
    `Reported by @${reporter} from the HUD: Green Light reached the wrong ` +
      `verdict on ${shortSha(subject.headSha)}.`,
    "## Verdict under dispute",
    factLines(subject).join("\n"),
  ];

  const message = subject.message ?? "";
  if (message.trim() !== "") {
    sections.push("## What Green Light said", defangGreenlightMessage(message));
  }

  sections.push(
    "## Reporter's comment",
    capCodePoints(comment.trim(), GREENLIGHT_REPORT_COMMENT_CAP)
  );

  return sections.join("\n\n");
}
