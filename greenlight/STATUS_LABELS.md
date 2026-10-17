# Status labels (`GL/*`)

greenlight shows where a `pytorch/pytorch` PR stands in its ledger (`misc.greenlight_pr_state`)
with three labels: `GL/approved` shows a non-shadow `LAND`, `GL/human` a non-shadow `NO_LAND`, which
leaves the PR to a human reviewer, and `GL/superseded` that the verdict, read as an approval, could
no longer land the PR on its own and greenlight will not review the PR again. The labels are display
only. greenlight never reads one to decide anything — anyone with triage rights can add or remove
one, and `@pytorchbot label` can add one — and reads a PR's labels only to work out which writes
bring them in line. The code is `verdict_labels.py`; what has to exist before it runs, and the token
permission it needs, are under "Deployment" below.

## What a PR carries

The labels follow pytorch's land-time gate (see the README's "Land-time verification"). A verdict is
*current* while it is the PR's latest non-shadow row, the one the gate reads, and its head is the
PR's head, compared case-insensitively as the gate compares them: a new commit, a rebase or ghstack
re-submit, or a newer in-flight, `FAILED` or `CANCELLED` row at the same head ends it.

| Situation | Labels |
| --- | --- |
| greenlight records a non-shadow `LAND` / `NO_LAND` on the PR's current head | `GL/approved` / `GL/human` |
| Verdict current, PR inside the review window and not labelled `Stale`, author eligible | that verdict's label |
| Verdict current, PR inside the review window and not labelled `Stale`, author determined ineligible | `GL/superseded` only |
| Verdict current, PR labelled `Stale` or author undetermined | unchanged |
| Verdict no longer current, greenlight will not review again, no review in progress | `GL/superseded` only |
| Verdict no longer current, and greenlight will review again or a review is in progress | unchanged |
| Reverted, with the verdict on the reverted head | the verdict's label and `GL/superseded`, kept even if the PR is reworked and re-landed |
| Reverted, with the verdict on another head | `GL/superseded` only |
| Only shadow verdicts, or none | none written; a hand-added one is left alone |

*Will not review again* means the tick itself found a reason for which the gate refuses at once
rather than waiting: a human has decided the PR (a merge-authorized approval, or changes requested
by a non-bot reviewer), or the scan skipped it as `Stale`. Two departures from the gate are
deliberate: idleness alone supersedes nothing, since the write would reopen an idle PR's review
window and reset pytorch's stale clock, and an author determined ineligible counts, though the gate
does not check eligibility, because greenlight dismisses its approval there. A review is *in
progress* while its in-flight row is younger than the scan's `--timeout-minutes` window (45 minutes
by default). The reverted head is the PR's head when the scan recorded its `REVERTED` row; a verdict
that lands after the revert makes the scan record that row again.

## When greenlight writes them

At verdict time, the reviewer workflow's `record` job (`verdict`), right after it approves or
dismisses and before the status comment, makes the verdict's label the PR's only `GL/*` label for a
non-shadow `LAND` or `NO_LAND`. It leaves a PR that is no longer open as it is, and one whose head
has moved off the reviewed one or that carries `Reverted` to the scan.

At scan time, every listing tick that reaches its dispatch phase without a rate limit runs a label
pass after its dispatches and before it raises for the PRs that failed: a paused tick (`--max 0`)
too, a `--pr` run never. The pass judges the listed PRs that are reverted, labelled `Stale`, or kept
by the review window (updated inside it, or with an in-flight or retry-eligible review), reads their
latest non-shadow rows in one ClickHouse query, and supersedes, restores or re-applies their labels.
It restores a label someone removed on every PR it judges whose row above names labels. Any other
PR, closed or draft, by an author outside the evaluation cohort, or idle, keeps the labels it has,
and so does a listed PR the pass finds closed when it fetches it.

A human decision comes to light only when a PR is fingerprinted. A paused tick fingerprints nothing,
and a tick that reaches its `--max` cap stops fingerprinting there, so on those ticks the pass
supersedes an unfingerprinted PR as human-decided only on a skip taken from a kept fingerprint
result (logged `cached`), which only fast ticks reuse.

Both write only on a transition: a PR whose `GL/*` labels, compared case-insensitively, already
match is left alone; otherwise the extras are removed, then the missing labels are added in one
request, and a removal that finds the label already gone counts as done. Both are best-effort: a
failed write is logged and never fails the scan, withholds the approval or loses the verdict row. In
the pass, a failure on one PR is logged and the pass moves on to the next, but three failures with
no PR synced between them (`LABEL_PASS_MAX_FAILURES`) stop it for that tick, and a rate limit stops
it at once. The pass takes its PRs in number order, so three that keep failing stop it at the same
place every tick. The PRs it did not reach wait for the next tick. Its ClickHouse read is not
guarded and fails the scan like the scan's other reads.

The pass is also time-boxed, in every run mode: it starts a PR only while less than 150 s
(`LABEL_PASS_DEADLINE`) have passed since the tick began its listing. Against the Lambda's 300 s
timeout, that typically leaves room, though nothing guarantees it, for the writes of a PR started
just before the deadline and for the Dr. CI poke drain that ends the scan. A tick already 150 s past
the start of its listing when its dispatches end skips the pass without reading ClickHouse. Full
ticks, which list every open PR and reuse no kept fingerprint result, can reach the pass that late,
and PRs that only full ticks list, such as idle ones that are `Stale`-skipped or reverted only by
their recorded row, then wait for a later full tick.

## Side effects

A label write is a PR update, with effects outside greenlight:

- It bumps the PR's `updated_at`. That re-lists the PR on fast ticks for the next review window and,
  on a PR the scan fingerprints, costs a fresh fingerprint fetch on every tick until one finds the
  bump at least two minutes old: at most two with ticks two minutes or more apart, more on a
  `--loop` daemon (60 s apart by default). It never causes a re-review, since labels are not part of
  the fingerprint. It also restarts pytorch's stale clock: each write on a `Stale` PR (the
  supersede, and every restore after someone removes the label) postpones its 30-day closure, and a
  write on an open `Reverted` PR, which the scan judges at any age, restarts the 60 days after which
  pytorch labels it `Stale`.
- Each add starts runs of pytorch's `labeled`-triggered workflows, which skip.
- A removal on a PR with neither a `release notes:` label nor `topic: not user facing` can make
  pytorch-bot's `checkLabelsBot` post its release-notes reminder: once per PR, or again whenever its
  earlier reminder is not among the PR's first 30 comments, since it looks for its earlier one on
  the first page only.

## Deployment

The three labels must exist in `pytorch/pytorch`, named exactly `GL/approved`, `GL/human` and
`GL/superseded`, before code that writes them reaches test-infra `main`, since two paths run
greenlight from `main` without waiting for a Lambda release: the reviewer workflow's `record` job,
at the ref the scan dispatches it at (`main` by default), so verdict-time labels start at merge; and
a listing run of `greenlight-review.yml` dispatched by hand at `main` (empty `pr`), which runs the
label pass. The scheduled scan's pass follows the `greenlight-scan` Lambda release (see the README's
"Deployment"). The label writes call the issue-label endpoints, which GitHub's App-permission table
lists under both Pull requests: write and Issues: write; greenlight's App tokens request
`pull_requests: write` and not `issues: write`. If label writes return 403, the App installation and
the three token mints used for label writes (`_TOKEN_PERMISSIONS` in `lambda_handler.py`,
`greenlight-review.yml`, and the `record` job in `greenlight-pr-review.yml`) need `issues: write`
too. No flag turns the labels off.

## Known edges

- A review that finishes 45-55 minutes after it started can flip `GL/superseded` back to the
  verdict's label once.
- A verdict-time write followed by a failed S3 upload leaves a label with no row behind it until
  greenlight reviews the PR again.
- A verdict recorded after a human has merged the PR writes no label, and the scan never touches a
  closed PR, so a merged PR keeps the label it merged with. If the PR is reverted, though, the scan
  pairs its `REVERTED` row with the PR's latest verdict, which can be that late one.
- A verdict the `record` job downgrades to shadow, on a PR whose author the scan still judges
  eligible, writes no label, and greenlight does not review the PR again until it changes, so the
  label of the verdict before it stays.
- An author made ineligible and then eligible again, with no push, shows `GL/approved` although
  greenlight never re-posts the approval it dismissed.
- A reverted PR whose reopen failed stays closed, so the scan never lists it and it never gets
  `GL/superseded`.
- Two revert edges are accepted as rare. A PR superseded before it merged at the verdict's commit
  (its author ineligible, or a newer failed run plus a human decision) shows the verdict's label
  again after the revert. A push in the minutes before the scan records the `REVERTED` row drops the
  verdict's label, since the reverted head is then the new one.
- The first listing ticks after deploy label the open PRs the pass judges, time-boxed and with the
  side effects above. A PR that closed before deploy carries none, nor does one idle since then that
  is not reverted or labelled `Stale`, nor one whose row above leaves its labels unchanged, such as
  one awaiting an in-flight or retried review.
