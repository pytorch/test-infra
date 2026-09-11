// The single definition of "is this PR approved" for the whole app.
//
// Two surfaces need this and must not disagree: the merge command, which
// refuses to land an unapproved PR, and the PR Status line in the Dr.CI comment,
// which tells the contributor whether it is theirs to land. A contributor told
// "Approved, go merge" by one and refused by the other is worse than either
// answer alone, so the rules live here rather than in each caller.
//
// Pure: takes an already-fetched review list, so it is unit-testable and neither
// caller has to agree on how the reviews were paginated.

import { PullRequestReview } from "@octokit/webhooks-types";

export const PR_COMMENTED = "commented";
export const PR_DISMISSED = "dismissed";
export const PR_CHANGES_REQUESTED = "changes_requested";
export const PR_APPROVED = "approved";

// From https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
// Anyone at all can submit an approving review on a public PR, so an approval
// only counts from someone with a standing relationship to the repo.
export const ALLOWED_APPROVER_ASSOCIATIONS = [
  "COLLABORATOR",
  "CONTRIBUTOR",
  "MEMBER",
  "OWNER",
];

// GitHub App bots authenticate via installations rather than as repo
// collaborators, so their reviews always carry author_association=NONE.
// Allowlist trusted App identities so their approvals are still honored, but
// only on pytorch/pytorch since that is the sole repo these bots review --
// other supported orgs/repos must not honor the exemption.
export const ALLOWED_APPROVER_BOT_LOGINS = ["pytorchgreenlight[bot]"];

function isAuthorizedApprover(
  review: PullRequestReview,
  allowBots: boolean
): boolean {
  if (ALLOWED_APPROVER_ASSOCIATIONS.includes(review.author_association)) {
    return true;
  }
  return (
    allowBots && ALLOWED_APPROVER_BOT_LOGINS.includes(review.user?.login ?? "")
  );
}

/**
 * The standing decision of each authorized reviewer, keyed by login, as the
 * review `state` string GitHub returned.
 *
 * `allowBots` enables the App-bot exemption above; pass isPyTorchPyTorch(...).
 *
 * Reviews are sorted by submission time rather than trusted in list order, so a
 * caller that paginated differently -- or a GitHub change -- cannot silently
 * make an older decision win. Plain comments are not decisions and are skipped;
 * a dismissal clears that reviewer's standing decision entirely, which is how a
 * dismissed approval stops counting.
 */
function getLatestReviewDecisions(
  reviews: PullRequestReview[],
  allowBots: boolean,
  log: (message: string) => void
): { [user: string]: string } {
  return [...reviews]
    .sort((a, b) =>
      Date.parse(a.submitted_at + "") < Date.parse(b.submitted_at + "") ? -1 : 1
    )
    .reduce((latest: { [user: string]: string }, review) => {
      if (!isAuthorizedApprover(review, allowBots)) {
        return latest;
      }

      // isAuthorizedApprover tolerates a missing user (it can pass on the
      // association branch alone), so the login has to be checked before it is
      // used as a key. Without this a review with a null user throws, and the
      // webhook path has no catch above it -- the delivery would just fail.
      const login = review.user?.login;
      if (!login) {
        return latest;
      }

      // Casing is weird here. The TypeScript definition says state will be
      // lower case, yet GitHub returns upper case. We can't trust that to
      // remain that way, so always convert the state to lowercase before any
      // comparisons.
      switch (review.state.toLocaleLowerCase()) {
        case PR_COMMENTED: // Ignore mere comments
          break;
        case PR_DISMISSED: // Ignore previous reviews by this person
          delete latest[login];
          break;
        case PR_CHANGES_REQUESTED:
        case PR_APPROVED:
          latest[login] = review.state;
          break;
        default:
          log(
            `Found an invalid review state '${review.state}' on review id ${review.id}. See ${review.html_url}`
          );
      }

      return latest;
    }, {});
}

/**
 * Aggregate those decisions into one verdict: "" (nobody has decided),
 * PR_APPROVED, or PR_CHANGES_REQUESTED. One approval is all that's needed, but
 * any outstanding changes-requested overrides it.
 */
function aggregateApprovalStatus(decisions: {
  [user: string]: string;
}): string {
  let status = "";
  for (const state of Object.values(decisions)) {
    const normalized = state.toLocaleLowerCase();
    if (normalized === PR_APPROVED) {
      status = normalized;
    } else if (normalized === PR_CHANGES_REQUESTED) {
      return normalized;
    }
  }
  return status;
}

/**
 * The PR's approval verdict: "", PR_APPROVED, or PR_CHANGES_REQUESTED. The one
 * entry point -- the two steps above are split for readability, not for reuse.
 */
export function getApprovalStatusFromReviews(
  reviews: PullRequestReview[],
  allowBots: boolean,
  log: (message: string) => void = () => {}
): string {
  return aggregateApprovalStatus(
    getLatestReviewDecisions(reviews, allowBots, log)
  );
}

/**
 * The logins of reviewers who could plausibly have been assigned to the PR.
 *
 * This exists because GitHub drops a reviewer from `requested_reviewers` as soon
 * as they submit a review of ANY kind -- including a plain comment -- so
 * reconstructing the assigned set needs the people who have already been
 * through it.
 *
 * That recovery is the only purpose, so the same authorization bar as an
 * approval applies. Without it, `author_association: NONE` is enough for any
 * GitHub user to leave one review comment and permanently insert themselves
 * into a bot-authored sentence naming who must sign off on the PR -- and
 * nothing ever removes them, since there is no dismissal for a comment. The bar
 * costs nothing for the case this recovers: a genuinely assigned reviewer
 * clears it by definition.
 *
 * `excludeLogins` drops people who cannot be their own reviewer, i.e. the PR
 * author. GitHub blocks self-approval but permits self-COMMENT reviews, so an
 * author replying inline to feedback would otherwise be listed as owing
 * agreement on their own change.
 *
 * The App-bot exemption is deliberately NOT applied: a bot is not an assigned
 * reviewer anyone is waiting on, and a login like `pytorchgreenlight[bot]` could
 * not be rendered into the @-list anyway.
 */
export function getReviewerLogins(
  reviews: PullRequestReview[],
  excludeLogins: string[] = []
): string[] {
  const excluded = new Set(excludeLogins);
  return Array.from(
    new Set(
      reviews
        .filter((review) => isAuthorizedApprover(review, /*allowBots*/ false))
        .map((review) => review.user?.login)
        .filter(
          (login): login is string => Boolean(login) && !excluded.has(login!)
        )
    )
  );
}
