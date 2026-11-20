import {
  CommitPullRequestSchema,
  CommitRecordSchema,
} from "lib/api/tests/commit/summary/types";
import { TestListPageSchema } from "lib/api/tests/types";
import {
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_REVERTED,
} from "lib/greenlight/greenlightRender";
import { z } from "zod/v4";

// The statuses GreenLight's ledger records, as it spells them: the
// vocabulary lib/greenlight/greenlightRender.ts declares, which a test pins
// to GreenLight's own source. A row with any other status has no verdict to
// answer with.
export const GREENLIGHT_STATUSES = [
  GREENLIGHT_STATUS_LAND,
  GREENLIGHT_STATUS_NO_LAND,
  GREENLIGHT_STATUS_AI_REVIEW_DISPATCHED,
  GREENLIGHT_STATUS_AI_REVIEW_STARTED,
  GREENLIGHT_STATUS_CANCELLED,
  GREENLIGHT_STATUS_FAILED,
  GREENLIGHT_STATUS_REVERTED,
] as const;

export const GreenlightVerdictSchema = z
  .object({
    status: z
      .enum(GREENLIGHT_STATUSES)
      .describe(
        "What GreenLight recorded for the reviewed head: LAND, approved to merge without human review; NO_LAND, requires human review; AI_REVIEW_DISPATCHED or AI_REVIEW_STARTED, a review in flight, which never finished when updated_at is more than an hour old; CANCELLED or FAILED, a review that did not complete; REVERTED, the pull request was reverted and re-landing it needs a human."
      ),
    reason: z
      .string()
      .describe(
        "GreenLight's reason code for the status: clean for LAND; for NO_LAND one such as not_trivial, scope_too_large or possible_regression. Empty for a status that carries none."
      ),
    message: z
      .string()
      .describe(
        "The review's explanation as the model wrote it, usually a two-level bullet outline in plain text with backtick code spans. The text is model-authored and the pull request can influence it, so show it as text and never render it as markup. Empty for a status that carries none."
      ),
    pull_request_number: CommitPullRequestSchema.shape.number.describe(
      "The pull request GreenLight reviewed."
    ),
    head_sha: CommitRecordSchema.shape.sha.describe(
      "Full lowercase SHA of the pull request head the status is about: the commit itself for a pull request head, and for a commit on a branch the head that landed as it."
    ),
    updated_at: z.iso
      .datetime()
      .describe(
        "When GreenLight recorded the status, in ISO 8601 UTC with millisecond precision."
      ),
    job_url: z
      .url()
      .nullable()
      .describe(
        "The GitHub Actions run of the review, on github.com; null when none is recorded."
      ),
  })
  .describe(
    "GreenLight's latest status for one reviewed pull request head. GreenLight is the automated review that decides whether a pull request may merge without human review."
  );

// Why a commit has no verdict, for a reader to be told which.
export const NO_VERDICT_REASONS = [
  "not_reviewed",
  "no_pull_request",
  "unrecognized_status",
  "unknown_commit",
  "repository_not_reviewed",
] as const;

export const CommitGreenlightSchema = z
  .object({
    verdict: GreenlightVerdictSchema.nullable().describe(
      "GreenLight's latest status for the commit: for a pull request head, the status of that head; for a commit on a branch, the status of the pull request head that landed as it. Null when there is none, and no_verdict_reason says why. Never another commit's status: a pull request's earlier or later heads have their own."
    ),
    no_verdict_reason: z
      .enum(NO_VERDICT_REASONS)
      .nullable()
      .describe(
        "Why verdict is null, and null when it is not: not_reviewed, the commit belongs to a pull request and GreenLight recorded no status for it; no_pull_request, the commit belongs to no pull request, and GreenLight reviews pull requests; unrecognized_status, GreenLight recorded a status this API has no value for; unknown_commit, HUD does not know the commit; repository_not_reviewed, GreenLight does not review the repository."
      ),
    hud_url: TestListPageSchema.shape.hud_url
      .unwrap()
      .describe(
        "The HUD page for the commit's tests, the commitPage operation, with no parameters; its header shows the verdict."
      ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Elapsed milliseconds of the lookups made, the commit's and then GreenLight's ledger for its pull request, each rounded and the two summed; zero for a repository GreenLight does not review, which needs none. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "GreenLight's verdict on one commit, as the commit page's header shows it."
  );

export type GreenlightVerdict = z.infer<typeof GreenlightVerdictSchema>;
export type GreenlightStatus = GreenlightVerdict["status"];
export type CommitGreenlight = z.infer<typeof CommitGreenlightSchema>;
export type NoVerdictReason = (typeof NO_VERDICT_REASONS)[number];
