// The "Report a bad review" link: a new pytorch/test-infra issue from the
// automated PR review feedback form (.github/ISSUE_TEMPLATE/ai-pr-review-feedback.yml),
// with the PR, commit and run filled in. The form's label puts the issue on the
// feedback board. scripts/pr_review/post_review.py in pytorch/pytorch builds the
// same link for the GitHub review; keep the two in step.
//
// Every value comes from a ClickHouse row and ends up as a link target in a
// bot-authored comment, so each is checked whole. A bad repo or PR number gives
// "" (no link); a bad commit or run id is left out of the prefill.

export const PR_REVIEW_REPORT_ISSUE_URL =
  "https://github.com/pytorch/test-infra/issues/new";
export const PR_REVIEW_REPORT_TEMPLATE = "ai-pr-review-feedback.yml";

const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const FULL_SHA_RE = /^[0-9a-fA-F]{40}$/;

export function prReviewReportUrl(
  repo: string,
  prNumber: number,
  headSha: string,
  runId: number | string
): string {
  const pr = Number(prNumber);
  if (!REPO_RE.test(repo || "") || !Number.isSafeInteger(pr) || pr <= 0) {
    return "";
  }
  const params = new URLSearchParams({
    template: PR_REVIEW_REPORT_TEMPLATE,
    title: `[AI PR review] ${repo}#${pr}`,
    pr: `https://github.com/${repo}/pull/${pr}`,
  });
  const sha = (headSha || "").trim();
  if (FULL_SHA_RE.test(sha)) {
    params.set("commit", sha.toLowerCase());
  }
  const run = Number(runId);
  if (Number.isSafeInteger(run) && run > 0) {
    params.set("run", `https://github.com/${repo}/actions/runs/${run}`);
  }
  return `${PR_REVIEW_REPORT_ISSUE_URL}?${params.toString()}`;
}
