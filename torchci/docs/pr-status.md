# PR Status comments

In `pytorch/pytorch`, PR Status is the first section of the existing PyTorchBot
Dr.CI comment, above automated review and CI results. Workflow-label, review,
reviewer-assignment, draft, and reopen webhooks refresh it. PRs created before
2026-09-01 are outside this workflow and get no PR Status section, including
drafts and approved PRs. Existing status-comment reconciliation handles quiet
or missing comments without requiring CI activity; label promotion runs on
handled webhooks.

## Coverage

| Phase                            | Status                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before triage                    | No PR Status section without a workflow label. Helpful Links includes Auto PR Triage runs for PRs labeled `open source`.                                                                    |
| Draft within the workflow        | Explicitly waiting for the author to mark it ready; triage advancement is paused while draft.                                                                                               |
| Missing actionable issue         | Explains the actionable-issue / supporting-maintainer requirement, automatic re-triage when eligibility changes, and the manual fallback.                                                   |
| Triaged                          | Queued for the bot to start automated review, not waiting on reviewers. Eligible PRs get `in progress` on handled webhooks.                                                                 |
| In progress                      | Explains author action, automated review, maintainer feedback, and CI readiness. The separate automated-review and CI sections provide running, completed, failed, and stale-review detail. |
| Ready for maintainer review      | Explicitly waiting for a maintainer with merge rights. Shows reviewers asked for re-review after fixes; otherwise asks the author to address outstanding feedback.                          |
| Needs additional approval        | Explains that an approver needs merge rights for the changed paths. This does not block triage advancement.                                                                                 |
| Approved                         | Gives the merge command and CI guidance. Merge-rules approval does not prevent an eligible triaged PR from getting `in progress`.                                                           |
| Merge underway / merged / closed | No dedicated terminal PR Status stage. GitHub's PR state and the merge bot's separate output cover these; the Dr.CI section is not a terminal-state record.                                 |

The top-level in-progress explanation is guidance, not a consolidated live
checklist. Before-triage and merge/closed coverage remain opportunities for a
separate change. The opened handler and CI sweep create Dr.CI comments, and the
status recovery job repairs missing comments for PRs in the workflow.

## Immediate triage advancement

An open, non-draft PR created on or after 2026-09-01 is eligible when it carries
`triaged` and none of `missing actionable issue`, `in progress`, or
`ready for review`. PyTorchBot immediately adds `in progress`, which triggers
automated review. The bot rechecks live state before writing. Human reviews,
including an approval that satisfies the merge rules, do not gate this
transition. Reviewer responses and reactions are not advancement inputs; there
is no waiting period or response command. Adding `in progress` does not grant
merge approval.

A triaged status means the bot's transition is queued, not that a reviewer owes
a response. Closed PRs, drafts, PRs before the rollout date, and PRs already
carrying one of the excluded labels do not advance.

Promotion is webhook-only in this change. The retired deadline job is removed;
there is no scheduled label-repair fallback until a separate recovery change is
deployed. A missed webhook can leave an eligible PR queued. The status-comment
reconciliation job below does not advance labels.

## Periodic status recovery

`.github/workflows/pr-status-sweep.yml` calls `POST /api/pr_status/sweep` every
15 minutes, at minutes 11, 26, 41, and 56. Its concurrency group is unchanged.
ClickHouse selects open post-rollout PRs with a workflow
label (including drafts and missing comments), plus open PRs whose bot-authored
Dr.CI comment still contains the PR Status marker. The second group includes
older PRs and PRs that lost their last workflow label, so stale status can still
be removed. The recovery job makes no GitHub search calls.

Each run checks a rotating batch of at most 100 candidates in numeric order,
with concurrency 5. A stable set of 1,200 candidates takes 12 runs (about three
hours) to cover. ClickHouse only selects candidates: live GitHub reads determine
the current phase, reviewers, and comment body before writing. Mirror lag may
delay discovering a candidate until a later run. Webhooks and normal CI updates
refresh active PRs sooner.

Recovery updates only the PR Status section. It preserves existing CI results
and skips unchanged comment bodies. A missing comment is recreated with current
status and standard HUD/helpful links, including the branch-specific Auto PR
Triage link for `open source` PRs. PRs outside the workflow do not get new
comments. For PRs created before the rollout date, recovery removes any stale
PR Status section while preserving the rest of the comment. CI classification
is populated by the normal CI update. Closed PRs and failed state reads are left
alone, and one PR's failure does not prevent checking the rest of the batch.

GitHub status reads, including paginated comment lookup, use a dedicated
read-only app with a rate limit separate from PyTorchBot. Only PyTorchBot writes
comments. Populate both `PRE_REVIEW_APP_ID` and `PRE_REVIEW_PRIVATE_KEY` in the HUD
deployment; they are mandatory for `getPreReviewOctokit`, the dedicated status
reader. An existing read-only app can be reused. The private key is
base64-encoded PEM, and the app needs read access to PRs, issues, contents, and
org members on `pytorch/pytorch`. The recovery job never falls back to PyTorchBot
for reads and needs no persisted cursor. The endpoint reports failed PR numbers
with HTTP 502, and configuration or candidate-query failures with 503. A
ClickHouse failure does not fall back to searching all GitHub PRs.

The status workflow reuses the existing `DRCI_BOT_KEY` and `HUD_API_TOKEN`
secrets for endpoint authentication. Coordinate removal of the retired deadline
workflow and populate the status-reader variables before deployment. No S3 or
cache configuration is required for status reconciliation.

## Status refresh during CI updates

Status and CI updates preserve each other's sections. Comment lookup paginates
and stops at the first matching bot-authored Dr.CI comment. No-op status refreshes
do not edit the comment. CI rebuilds use the dedicated status reader, reusing
one client per sweep. If it is unavailable or a live status read fails, the
rebuild keeps the existing PR Status section while updating CI results and the
Dr.CI check run; it does not fall back to PyTorchBot for status reads. Draft
metadata is checked for every workflow phase, including PRs without `triaged`.
Live workflow-label and comment reads prevent a mirror that predates triage
from erasing newly published progress.

## Re-triage when eligibility changes

When an issue in `pytorch/pytorch` gains `actionable`, the bot finds connected
PRs from its paginated timeline, including GitHub's manual development links and
references from PR descriptions. It verifies each current closing link or
`Part of #<issue>` / `Part of pytorch/pytorch#<issue>` claim before requesting
re-triage. Old links, comment-only mentions, code, and HTML comments do not count.

Only open, non-draft PRs against `main` or a `gh/.../base` branch carrying both
`open source` and `missing actionable issue` are re-triaged. PRs with
`no automated triage`, `in progress`, or `ready for review` are left alone. The
bot removes the old triage outcome labels and re-adds `open source` to start the
existing Auto PR Triage workflow. The missing-issue hold stays in place until
that entry event has been sent. Normal triage then rechecks the issue and routes
reviewers; the issue label does not itself advance the PR or grant merge approval.

If a trigger write fails after removing `open source`, a redelivered webhook
can resume the reset. With that label absent, the bot checks the PR's label
history and proceeds only if its own removal is the latest `open source` event
and happened at or after the triggering event. PR events use the original
webhook's update timestamp, so retrying after a failed write does not move the
recovery boundary. A maintainer's later removal prevents recovery. This uses
existing label history and leaves the missing-issue hold in place on failures.

For example, if PR #10 already says `Fixes #5` and was marked
`missing actionable issue`, labeling issue #5 `actionable` automatically requests
re-triage for PR #10. The new triage result and its label webhooks update PR Status.

Editing a PR description to add a valid actionable-issue link or
`Supported by @<maintainer>` also requests re-triage. The bot verifies current
issue labels, GitHub closing links, and the named maintainer's current permissions
before resetting triage. Unrelated edits do not retrigger it. Marking a draft
ready, reopening a PR, or removing `no automated triage` rechecks existing links
and support, including manual development links. These events use the same live
eligibility checks and retry protection as the issue-label event. A manual link
added through GitHub's sidebar alone has no handled webhook; for that case, or
whenever re-triage is still needed, anyone can comment `@pytorchbot triage` on a
PR labeled `open source` to re-run Auto PR Triage.

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

## Reviewer notifications

The daily notifications manifest includes only outstanding final-review requests
for PRs ready for maintainer review. Its schema is
`reviewers: { login: { final_review: [...] } }`, with `ManifestPr.stage` always
`final_review`. Team requests expand to members other than the PR author. Each
reviewer receives a PR once; a direct request takes precedence over a team
reference (`via`). Queued triaged PRs are not reviewer notification work.

The opt-in Slack digest renders only final review and distinguishes `open source`
PRs from maintainer PRs. Within each group, it sorts oldest stage timestamps first
(unknown timestamps last). It retains channel-membership, registration, dry-run,
stale-manifest, rate-limit, and weekday scheduling guards.

## Examples

### Draft

```markdown
## PR Status: draft

This PR is waiting for its author to mark it ready for review.
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

After fixes pass the readiness checks and the bot requests another review
(fictional reviewer names):

```markdown
## PR Status: ready for maintainer review

**Waiting for re-review:** `alice`, `bob`.

These reviewers have been asked to review the latest updates.
```
