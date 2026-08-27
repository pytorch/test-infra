// The single definition of "is this PR approved" for the whole app.
//
// Lifted verbatim out of PytorchBotHandler.getApprovalStatus so more than one
// surface can reach it. It could not stay there: pytorchBotHandler imports
// updateDrciComments from pages/api/drci/drci, so anything on the Dr.CI side
// that imported it back would form a cycle. This module is a leaf.
//
// Pure -- it takes an already-fetched review list -- so the caller keeps
// ownership of pagination, of the empty-list case, and of its own logger.

import { PullRequestReview } from "@octokit/webhooks-types";

export const PR_COMMENTED = "commented";
export const PR_DISMISSED = "dismissed";
export const PR_CHANGES_REQUESTED = "changes_requested";
export const PR_APPROVED = "approved";

/**
 * The PR's approval verdict from its reviews: "" (nobody has decided),
 * PR_APPROVED, or PR_CHANGES_REQUESTED.
 *
 * `isPyTorchPyTorchRepo` gates the App-bot exemption below and `log` receives
 * the unrecognised-review-state notice; both were read off `this` before.
 */
export function getApprovalStatusFromReviews(
  reviews: PullRequestReview[],
  isPyTorchPyTorchRepo: boolean,
  log: (message: string) => void = () => {}
): string {
  // From https://docs.github.com/en/graphql/reference/enums#commentauthorassociation
  const ALLOWED_APPROVER_ASSOCIATIONS = [
    "COLLABORATOR",
    "CONTRIBUTOR",
    "MEMBER",
    "OWNER",
  ];

  // GitHub App bots authenticate via installations rather than as repo
  // collaborators, so their reviews always carry author_association=NONE.
  // Allowlist trusted App identities so their approvals are still honored,
  // but only on pytorch/pytorch since that is the sole repo these bots
  // review -- other supported orgs/repos must not honor the exemption.
  const ALLOWED_APPROVER_BOT_LOGINS = ["pytorchgreenlight[bot]"];

  // Find the latest review offered by each authroized reviewer
  // But first sort them in case Github ever returns the list unsorted
  var latest_reviews: { [user: string]: string } = reviews
    .sort((a: PullRequestReview, b: PullRequestReview) => {
      return Date.parse(a.submitted_at + "") < Date.parse(b.submitted_at + "")
        ? -1
        : 1;
    })
    .reduce(
      (
        latest_reviews: { [user: string]: string },
        curr_review: PullRequestReview
      ) => {
        if (
          !ALLOWED_APPROVER_ASSOCIATIONS.includes(
            curr_review.author_association
          ) &&
          !(
            isPyTorchPyTorchRepo &&
            ALLOWED_APPROVER_BOT_LOGINS.includes(curr_review.user?.login ?? "")
          )
        ) {
          // Not an authorized approver
          return latest_reviews;
        }

        // Casing is werid here. The typescript defintion says state will be lower case, yet github
        // returns upper case. We can't trust that to remain that way, so always conver the state
        // to lowercase before any comparisons
        switch (curr_review.state.toLocaleLowerCase()) {
          case PR_COMMENTED: // Ignore mere comments
            break;
          case PR_DISMISSED: // Ignore previous reviews by this person
            delete latest_reviews[curr_review.user.login];
            break;
          case PR_CHANGES_REQUESTED:
            latest_reviews[curr_review.user.login] = curr_review.state;
            break;
          case PR_APPROVED:
            latest_reviews[curr_review.user.login] = curr_review.state;
            break;
          default:
            log(
              `Found an invalid review state '${curr_review.state}' on review id ${curr_review.id}. See ${curr_review.html_url}`
            );
        }

        return latest_reviews;
      },
      {}
    );

  // Aggregate the reviews to figure out the overall status.
  // One approval is all that's needed
  // If there are any changes requested, the status is changes requested
  let approval_status = "";
  for (let [_, review_state] of Object.entries(latest_reviews)) {
    if (review_state.toLocaleLowerCase() == PR_APPROVED) {
      approval_status = review_state;
    } else if (review_state.toLocaleLowerCase() == PR_CHANGES_REQUESTED) {
      // If there are any changes requested, we exit early and just return changes requested
      approval_status = review_state;
      break;
    }
  }

  return approval_status.toLocaleLowerCase();
}
