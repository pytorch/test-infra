# PR Status comments

In `pytorch/pytorch`, PR Status is the first section of the existing PyTorchBot
Dr.CI comment, above automated review and CI results. Label, review, reviewer
assignment, draft, and reopen webhooks refresh the section. Pre-review accept
commands and the independent scheduled pre-review check also refresh it, so
reactions and deadlines do not depend on a webhook or CI activity.

## Coverage audit

| Phase                            | Status after this change                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before triage                    | No PR Status section without a workflow label. Helpful Links includes Auto PR Triage runs for PRs labeled `open source`.                                                                    |
| Draft within the workflow        | `draft`: explicitly waiting for the author to mark it ready; pre-review cannot advance while draft.                                                                                         |
| Missing actionable issue         | Explains the actionable-issue / supporting-maintainer requirement, automatic re-triage when a linked issue gains `actionable`, and the manual fallback.                                     |
| Pre-review                       | Enabled for `triaged` PRs after the rollout date. Shows actual response progress and the shared deadline, rather than all assignments with mentions.                                        |
| In progress                      | Explains author action, automated review, maintainer feedback, and CI readiness. The separate automated-review and CI sections provide running, completed, failed, and stale-review detail. |
| Ready for maintainer review      | Explicitly waiting for a maintainer with merge rights. Outstanding change requests instead ask the author to address feedback and request another review.                                   |
| Needs additional approval        | Explains that an approver needs merge rights for the changed paths. Such an approval no longer hides active pre-review.                                                                     |
| Approved                         | Gives the merge command and CI guidance.                                                                                                                                                    |
| Merge underway / merged / closed | No dedicated PR Status stage. GitHub's PR state and the merge bot's separate output cover these; the Dr.CI section is not a terminal-state record.                                          |

Previously, `triaged` was commented out of the status trigger list: PRs waiting
only for pre-review could have no section at all. The old pre-review text listed
all assigned reviewers without checking their responses. It showed no absolute
deadline. Returning a triaged PR to draft could also leave pre-review guidance
visible. The ready-for-review text did not distinguish waiting on a maintainer
from waiting on the author.

The top-level in-progress explanation remains guidance, not a consolidated live
checklist. Before-triage and merge/closed coverage remain opportunities for a
separate change. PR Status still updates an existing Dr.CI comment; the opened
handler or CI sweep creates that comment if absent.

## Pre-review refresh behavior

The displayed deadline and reviewer categories come from the same calculation
that decides whether to add `in progress`. Accepted reviewers disappear from the
waiting list. Reviewers who do not respond before the deadline disappear from
the lists without being credited as accepting. Teams use `org/team` without a
mention. Explicit objections remain visible after silent reviewers time out.
Missing history never invents a deadline or causes an automatic acceptance.

The scheduled check runs every 15 minutes. Young PRs are checked in rotating
batches; every potential silent timeout is checked each run. Unchanged PRs with
objections or verified merge approval retain the existing six-hour backoff.
Thus reaction-only changes are eventually visible, not instant. Label/review
webhooks and accept commands can refresh sooner. All comment reads use the
pre-review app during the sweep, and only changed bodies are written as
PyTorchBot. Comment lookup paginates and stops at the first matching bot-authored
Dr.CI comment. CI results are preserved when splicing the status section. If a
live status or comment read fails during a CI rebuild, that PR's comment write
is skipped rather than restoring stale progress from the mirror. CI failure
classifications are still returned. Draft metadata is checked for every workflow
phase, including PRs without `triaged`. CI rebuilds always read live workflow
labels for `pytorch/pytorch`, so a mirror that predates triage cannot erase
newly published pre-review progress.

## Re-triage when eligibility changes

When an issue in `pytorch/pytorch` gains `actionable`, the bot finds connected
PRs from its paginated timeline, including GitHub's manual development links and
references from PR descriptions. It verifies each current closing link or
`Part of #<issue>` / `Part of pytorch/pytorch#<issue>` claim before requesting
re-triage. Old links, comment-only mentions, code, and HTML comments do not count.

Only open, non-draft PRs against `main` or a `gh/.../base` branch carrying both
`open source` and `missing actionable issue` are re-triaged. PRs with
`no automated triage`, `in progress`, or `ready for review` are left alone. The
bot removes the old triage outcome labels and re-adds `open source` to start the existing Auto PR
Triage workflow. The missing-issue hold stays in place until that entry event
has been sent. Normal triage then rechecks the issue and routes reviewers; the
issue label does not itself grant pre-review or merge approval.

If a trigger write fails after removing `open source`, a redelivered webhook
can resume the reset. With that label absent, the bot checks the PR's label
history and proceeds only if its own removal is the latest `open source` event
and happened at or after the triggering event. PR events use the original webhook's
update timestamp, so retrying after a failed write does not move the recovery
boundary. A maintainer's later removal
prevents recovery. This uses existing label history and leaves the missing-issue
hold in place on failures.

For example, if PR #10 already says `Fixes #5` and was marked `missing actionable
issue`, labeling issue #5 `actionable` automatically requests re-triage for PR
#10. The new triage result and its label webhooks update PR Status.

Editing a PR description to add a valid actionable-issue link or `Supported by
@<maintainer>` also requests re-triage. The bot verifies current issue labels,
GitHub closing links, and the named maintainer's current permissions before
resetting triage. Unrelated edits do not retrigger it. Marking a draft ready,
reopening a PR, or removing `no automated triage` rechecks existing links and
support, including manual development links. These events use the same live
eligibility checks and retry protection as the issue-label event. A manual link
added through GitHub's sidebar alone has no handled webhook; the status comment
retains manual re-triage instructions for that case.

## Returning to maintainer review

When a PR moves from `in progress` back to `ready for review`, the bot requests
another review from human reviewers whose requests for changes remain
outstanding and who still have triage or higher permissions. This also applies
when disabling automated review advances an in-progress PR. Comment-only reviews
do not clear a changes request; an approval or dismissal does.

Each reviewer is requested at most once per in-progress cycle. Current requests
and requests added, answered, or explicitly removed during that cycle are left
alone. A failed request prevents promotion so the operation can be retried.
The status names currently requested reviewers with outstanding changes,
without `@` mentions. Responding or removing a request refreshes the list.

## Examples

These use fictional reviewer names. The UTC deadline is calculated from the PR's
actual latest entry into pre-review; later review requests do not extend it.

### Waiting for responses

```markdown
## PR Status: in pre-review

Pre-review is a quick check of the PR's overall direction before automated and detailed maintainer review; it does not grant merge approval. Assigned reviewers can pre-accept with a 👍 on the PR description or a `@pytorchbot pre-review accept` comment, or request changes with a 👎 on the PR description.

**Waiting for pre-review:** `bob`, `pytorch/core`.

**Pre-review accepted:** `alice`.

**Pre-review deadline:** 2026-11-05 16:30:00 UTC. Reviewers who have not responded by then no longer block pre-review. Adding reviewers does not extend this deadline.

Progress refreshes on bot checks, including the scheduled check every 15 minutes. Unchanged PRs with objections are rechecked every six hours.
```

### Deadline passed with an objection

```markdown
## PR Status: in pre-review

Pre-review is a quick check of the PR's overall direction before automated and detailed maintainer review; it does not grant merge approval. Assigned reviewers can pre-accept with a 👍 on the PR description or a `@pytorchbot pre-review accept` comment, or request changes with a 👎 on the PR description.

**Pre-review accepted:** `alice`.

**Pre-review request changes:** `bob`. These block pre-review and do not expire. Address the feedback; the reviewer must remove their thumbs-down, or the change request must be approved or dismissed.

**Pre-review deadline:** 2026-11-05 16:30:00 UTC. This deadline has passed; reviewers who did not respond no longer block pre-review.

Progress refreshes on bot checks, including the scheduled check every 15 minutes. Unchanged PRs with objections are rechecked every six hours.
```

If all remaining reviewers are silent when the deadline passes, the bot adds
`in progress` and immediately updates the status to that phase. No label webhook
is needed for that refresh.

### Draft

```markdown
## PR Status: draft

This PR is waiting for its author to mark it ready for review. Pre-review does not advance while the PR is a draft.
```

### Maintainer review

```markdown
## PR Status: ready for maintainer review

Waiting for a maintainer with merge rights for the changed paths to review this PR. Please address any feedback they leave.
```

An opted-out PR may keep `ready for review` after a maintainer requests changes;
its message then becomes:

```markdown
## PR Status: ready for maintainer review

A maintainer requested changes. Please address their feedback and ask for another review.
```

After fixes pass the readiness checks and the bot requests another review:

```markdown
## PR Status: ready for maintainer review

**Waiting for re-review:** `alice`, `bob`.

These reviewers have been asked to review the latest updates.
```
