import { GithubWorkflowSchema } from "lib/api/tests/test/runs/types";
import { TestListPageSchema } from "lib/api/tests/types";
import { BUNDLE_STATUSES, BundleStatus } from "lib/runOutcomes";
import { z } from "zod/v4";

const count = z.number().int().nonnegative();
const sha = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .describe("Full lowercase commit SHA.");

const STATUS_MEANINGS: Record<BundleStatus, string> = {
  failed: "a final failed, error or crashed outcome",
  timed_out: "a final timed_out outcome",
  flaky:
    "a final pass after a failing attempt (failed, error, crashed or timed_out)",
  passed: "a pass with no failing attempt",
  other: "a final unexpected pass (xpassed) or unknown outcome",
  xfailed: "a final expected failure (xfailed)",
  skipped: "every attempt skipped",
};

export const CommitCountsSchema = z
  .object({
    tests: count.describe("Distinct catalog tests counted here."),
    jobs: count.describe(
      "Distinct GitHub jobs the counted tests' bundles with this result ran in."
    ),
  })
  .describe("Tests and the distinct GitHub jobs they ran in.");

export const CommitStatusCountsSchema = CommitCountsSchema.extend({
  runs: count.describe(
    "Bundles with this status: one per test, environment, env var set and GitHub job, after replacement deduplication."
  ),
}).describe(
  "Tests, jobs and bundles of one status, counted over every bundle on the commit."
);

function statusRecord<Schema extends z.ZodType>(
  schema: Schema,
  describe: (_status: BundleStatus) => string
) {
  return z.object(
    Object.fromEntries(
      BUNDLE_STATUSES.map((status) => [
        status,
        schema.describe(describe(status)),
      ])
    ) as Record<BundleStatus, Schema>
  );
}

export const CommitTestCountsSchema = z
  .object({
    total: CommitStatusCountsSchema.describe(
      "Every test with a retained bundle on the commit, each once; every GitHub job any of them ran in; and every bundle, one per test, environment, env var set and GitHub job. The by_worst_status tests add up to total.tests and the by_status runs to total.runs."
    ),
    by_worst_status: statusRecord(
      CommitCountsSchema,
      (status) =>
        `Tests whose worst result on the commit is ${status}, ${STATUS_MEANINGS[status]}, ranked failed, timed_out, flaky, passed, other, xfailed, skipped; and the distinct jobs their ${status} bundles ran in. A test counts once across these seven, so skipped means skipped in every job.`
    ).describe(
      "Every test once, under the worst status among its bundles, worst first: failed, timed_out, flaky, passed, other, xfailed, skipped. The counts add up to total.tests. The tests are what the commit's runs endpoint selects with worst_status set to the status, and the jobs come from the bundles it lists with status set to the same."
    ),
    by_status: statusRecord(
      CommitStatusCountsSchema,
      (status) =>
        `Tests with at least one ${status} bundle, ${STATUS_MEANINGS[status]}, the distinct jobs those bundles ran in, and the bundles themselves. A test that failed in one job and was flaky in another counts under both.`
    ).describe(
      "Every status's tests, jobs and bundles over all of the commit's bundles, so a test can count under several statuses. The runs are what the commit's runs endpoint lists with status set to the status."
    ),
  })
  .describe(
    "The commit's test counts after replacement deduplication, by the bundle status rule: a bundle's status follows its last executed attempt's outcome, a skip never overriding an executed attempt, flaky being a final pass after a failing attempt. The commit page's summary shows the runs of each status and total.runs, with total.tests as the distinct tests."
  );

// The pull request as the runs' workflow metadata spells it, with its title.
const workflowPullRequest = GithubWorkflowSchema.shape.pull_request.unwrap();

export const CommitPullRequestSchema = z
  .object({
    number: workflowPullRequest.shape.number.describe(
      "The pull request number."
    ),
    url: workflowPullRequest.shape.url.describe(
      "The pull request's page on GitHub."
    ),
    title: z
      .string()
      .nullable()
      .describe(
        "The pull request's title from the latest retained pull_request record; null when none is retained."
      ),
  })
  .describe("The pull request the commit belongs to.");

export const CommitRecordSchema = z
  .object({
    sha,
    url: z.url().describe("The commit's page on GitHub."),
    title: z
      .string()
      .describe(
        "The commit's title: the first line of its message, or the pull request's title for a commit known only as a pull request head."
      ),
    author: z
      .object({
        name: z
          .string()
          .nullable()
          .describe(
            "The commit author's name as git records it; null when unknown."
          ),
        login: z
          .string()
          .nullable()
          .describe(
            "The author's GitHub login, known for a commit pushed to a branch; null otherwise."
          ),
      })
      .describe("Who wrote the commit."),
    committed_at: z.iso
      .datetime()
      .describe(
        "The commit's timestamp, in ISO 8601 UTC with millisecond precision."
      ),
    branch: z
      .string()
      .nullable()
      .describe(
        "The commit's branch: for a commit pushed to a branch, the branch of its push and its workflow runs, main for a commit on main; for a pull request head, the pull request's head branch as its workflow runs record it, gh/<user>/<n>/head for a ghstack pull request and the branch in the fork for a fork's, else as its pull request record names it. Among several, main, else the first by name. Null when unknown."
      ),
    pull_request_head: z
      .boolean()
      .describe(
        "True for a pull request head: a commit whose workflow runs record a pull request in the repository, including one pushed to a ciflow tag or to a ghstack branch, or, when its runs record none and no push run put it on a branch, a commit that one of the repository's pull request records has named as its head, which is how a pull request from a fork is known; such a commit has no neighbours. False for a commit pushed to a branch."
      ),
    pull_request: CommitPullRequestSchema.nullable().describe(
      "The pull request the commit's workflow runs record for it, the one whose base repository is the commit's; else, when the runs record none and no push run put the commit on a branch, the lowest numbered pull request of the repository whose head the commit is or was, which is how a pull request from a fork is found; else the pull request a commit on a branch names at the end of its title, (#N); null when none is known. Set for a pull request head always, and for a branch commit whose title names one."
    ),
    newer_sha: sha
      .nullable()
      .describe(
        "On a branch, the next commit pushed to it after this one that has test jobs; null at the branch head, or for a pull request head."
      ),
    older_sha: sha
      .nullable()
      .describe(
        "On a branch, the latest commit pushed to it before this one that has test jobs; null when none is recorded, or for a pull request head."
      ),
  })
  .describe(
    "The commit as its workflow runs and pushes describe it, with its neighbours on its branch."
  );

export const CommitSummarySchema = z
  .object({
    commit: CommitRecordSchema,
    counts: CommitTestCountsSchema,
    first_started_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the earliest retained attempt on the commit started, in ISO 8601 UTC with millisecond precision; null without runs."
      ),
    last_ended_at: z.iso
      .datetime()
      .nullable()
      .describe(
        "When the latest retained attempt on the commit ended, in ISO 8601 UTC with millisecond precision; null without runs."
      ),
    retention_starts_at: z.iso
      .datetime()
      .describe(
        "The start of the runs table's retention when this was answered, in ISO 8601 UTC: runs that started before it are no longer kept, so a commit committed before it with no runs is one whose runs expired, not one that had none."
      ),
    hud_url: TestListPageSchema.shape.hud_url
      .unwrap()
      .describe(
        "The HUD page for the commit's tests, the commitPage operation, with no parameters."
      ),
    query_duration_ms: TestListPageSchema.shape.query_duration_ms.describe(
      "Sum of the individually rounded elapsed milliseconds of the commit lookup, the test counts, and the pull request and neighbour lookups when made. The counts run concurrently with the rest, so this sum can exceed wall-clock time. Includes client and network overhead and decoding; excludes SQL construction, mapping and API transport."
    ),
  })
  .describe(
    "What happened to the tests on one commit: the commit, its test counts by status, when its runs ran, and its page."
  );

export type CommitSummary = z.infer<typeof CommitSummarySchema>;
export type CommitTestCounts = z.infer<typeof CommitTestCountsSchema>;
export type CommitRecord = z.infer<typeof CommitRecordSchema>;
