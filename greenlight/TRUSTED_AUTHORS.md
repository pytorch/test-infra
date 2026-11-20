# Trusted authors

greenlight lists the open PRs from the evaluation cohort — every one on a full tick; on a fast tick,
the recently updated ones plus the open `Reverted`-labelled ones (see the README's "Usage" and "Who
is evaluated, and whose verdict carries authority") — but reviews only those whose author is
eligible for them, and only an eligible author's review carries authority: only it can approve the
PR, render in Dr. CI, or satisfy the land-time merge gate. For a listed PR whose author is not
eligible for it, Dr. CI says
its changes can't be reviewed due to `merge_rules.yaml` restrictions, or are too big to review when
the PR is oversized. Either line also replaces a greenlight verdict on an older commit, but never
one on the PR's current head; in every other case — an eligible author's PR that is not oversized,
a draft, an author no rule names, a failed check — an outdated verdict stays. Eligibility comes from
the merge rules and the PR's base, and an ineligible author is what `--allow-untrusted-author` calls
untrusted: that local-only flag reviews such a PR anyway, in shadow. This document covers who is
eligible, onboarding and offboarding, and the risks this design accepts.

## The rule

A PR is authoritative only when a rule in `pytorch/pytorch`'s `merge_rules.yaml` names its author
(`cohort.assess_rules`), whatever files the PR changes, and trymerge accepts its base
(`merge_authz.accepts_base`): a PR based on `main`, a ghstack PR, one whose head branch is named
`gh/<user>/<N>/head`, or a PR in a GitHub-native stack whose trunk is `main`. Team refs are expanded
to their members, and approver membership is exact-case against the author's login as GitHub
reports it. Whether the changes need a human is the review's call; the size gate in
`greenlight-pr-review.yml` declines a diff over 2000 lines or 200 files with a canned `NO_LAND`.

A rule with any pattern trymerge rejects — a brace, parenthesis, bracket or backslash, or patterns
that do not compile as a regex — is logged and qualifies nobody (`merge_authz.MergeRule.valid`).
The base test matches trymerge's base rule by branch names alone: GitHub's pull request object
reports a native stack's trunk as `stack.base.ref` and has no `stack` for a PR in no stack, and a
head branch named like a ghstack head passes whatever repository it comes from.

Where it is checked:

- **The scan** judges each PR's base from the pull request listing's own payload, with no extra
  request (`pr_listing`), and `authority.Authority` answers per PR, at most once per pass, from the
  merge rules and that listing, with no GitHub call. A PR listed on a base trymerge refuses is
  shadow. A PR from the issues endpoint, which carries no base (the fast tick's `Reverted`-labelled
  supplement), is judged by its author alone.
- **The `--pr` gate** (`authz_gates.admit_target`) runs the same check on the PR it fetches. A
  refused target is never fingerprinted or dispatched, but one with an author login still goes
  through the revert guard.
- **The verdict** (`verdict.has_eligible_author`) runs the check again for every `LAND` or `NO_LAND`
  recorded without `--shadow`: once a valid rule names the author, one fresh read of the PR must
  find the reviewed head on a base trymerge accepts. Any failure fails the command before the row is
  written.

All three log their answer with a reason that names no rule, team or file: the scan and the `--pr`
gate `PR #<n> by <login>: <reason>` for every PR they check (`PR #<n> by <login>: base not accepted`
and `--pr <n> by <login>: trymerge refuses its base` for a refused base), the verdict
`merge-rule eligibility on <repo>#<n>: author '<login>' is eligible` or
`... is not eligible: <reason>`. Besides `eligible`, a reason is one of `no author`,
`excluded (bot or greenlight)` and `no merge rule names '<login>' in exact case` (followed by
`; a rule names '<Variant>'` when a valid rule names a case variant); the verdict adds `head moved`
and `base not accepted`. The scan's lines are in the `greenlight-scan` Lambda's CloudWatch logs;
for one PR, a `pytorch/test-infra` writer can dispatch `greenlight-review.yml` with its `pr` input
and read the run's log.

A `REVERTED` row can only deny, so on a PR with a recorded row it is stamped non-shadow whatever its
author or base show; on a PR with none it follows the PR's authority. A PR whose recorded rows are
all shadow therefore also gets a non-shadow `REVERTED` row and a Dr. CI poke.

## Onboarding and offboarding

Both are a `merge_rules.yaml` change in `pytorch/pytorch`, with no greenlight deploy. The scheduled
scan resolves the rules afresh on every pass (about every 5 minutes), a `--loop` daemon once its
cached copy is older than `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS`, and the verdict on every run.
A login gains authority only where a rule names it in its exact GitHub casing, and the per-PR reason
catches a miscased entry.

Eligibility is not part of the fingerprint, so a PR already reviewed in shadow, or one whose
approval the scan dismissed while it was ineligible, is not re-reviewed when it becomes eligible,
whatever the cause: a rule naming its author, a retarget to `main`, or a change to the eligibility
check. A push, a comment the fingerprint covers, or a local
`just run review --pr <N> --force` re-reviews it.

Removing an author from a rule stops greenlight reviewing their PRs once no remaining valid rule
names them. On its next pass that lists such a PR inside the review window and not labelled `Stale`,
the scan dismisses greenlight's approval when the PR's latest recorded row is a `LAND`, and a review
already in flight is recorded in shadow, which dismisses it too. A PR outside the window or labelled
`Stale` keeps its approval, and so does every PR of an author no rule names, since the scan does not
list them. To take a live approval back at once, dismiss greenlight's review by hand. The kill
switches are the "Greenlight Review Bot" rule in `merge_rules.yaml`, without which no greenlight
approval authorizes a merge, and the `greenlight-scan` Lambda, whose disabling stops the scheduled
scan.

## Accepted risks

- **A revert is caught only on a PR the scan lists.** The scheduled scan revert-guards the PRs it
  lists, the evaluation cohort's, eligible or not, so it misses a PR whose author no merge rule
  names, such as an author removed after greenlight approved the PR; a manual `--pr` run still
  covers any PR with an author login. Otherwise a reverted PR keeps greenlight's approval until
  someone dismisses it by hand.
- **Dr. CI can keep showing a stale approval.** When a PR loses eligibility with the head
  unchanged — a merge-rule change, or a retarget to a base trymerge refuses — the scan dismisses
  greenlight's approval on a listed PR inside the review window and not labelled `Stale`, but Dr. CI
  keeps showing the last authoritative `LAND`, not even marked outdated: it never replaces a verdict
  on the current head. Nothing lands on it once the approval is gone. Once the head moves, the
  outdated verdict gives way to the `merge_rules.yaml` or too-big line where one applies.
- **An approval can outlive eligibility.** The scan dismisses an approval only on a PR it lists
  inside the review window and not labelled `Stale`, and only while the PR's latest recorded row is
  a `LAND`. Every other approval stays: on a PR outside the window, labelled `Stale`, or by an author
  no rule names, and under a later `FAILED`, `CANCELLED` or in-flight row. pytorch's land-time gate
  honours only the PR's latest non-shadow row, and allows greenlight's approval only when that row
  is a `LAND` for the PR's current head; any other row holds or refuses the merge. Under a later
  non-shadow row the approval alone therefore cannot land the PR, but one whose `LAND` is still the
  latest non-shadow row, with the head unchanged, can, however its eligibility has changed since.
- **A dismissed approval is not restored.** A PR on a base trymerge refuses has greenlight's
  approval dismissed whoever wrote it. Retargeted to `main` later, its fingerprint is unchanged, since
  the base is not part of it, so the scan skips it and nothing approves it again until the
  fingerprint changes.
- **Rule paths do not bound eligibility.** Any valid rule naming the author qualifies them on every
  path, so an approver whom a rule trusts with one directory gets reviews of changes anywhere, and a
  `LAND` gives an approval that the "Greenlight Review Bot" rule (patterns `*`) accepts for any path.
  Only the review's hard stops send the areas they name to a human.
- **Silent changes.** A login can join or leave a merge rule with no human edit — a nightly pytorch
  job regenerates the catch-all Metamates rule, and a bot approves and merges the change — and its
  PRs then gain or lose authority.
- **Inherited logins.** A login freed by a deleted or renamed account can be registered by someone
  else, who inherits its merge-rules entry and the eligibility that comes with it.
- **The base test reads branch names.** It is not pinned to a commit and mirrors trymerge's base
  rule by name alone, so a head branch merely named like a ghstack head passes it.
- **Moved heads and bases.** The verdict reads the head SHA and the base branch's name, never the
  base branch's commit, so a push to the base branch after the review goes unnoticed; a verdict
  recorded after a push to the head, or after a retarget to a base trymerge refuses, writes a shadow
  row. The scan judges the base from the listing and does not read the PR again before dispatch, so
  a retarget between the listing and the dispatch is not caught there: the verdict then records a
  shadow row, and the in-flight marker written at dispatch, which is not shadow, stays the PR's
  latest non-shadow row until the PR changes. Dr. CI then shows the review in progress, then not
  completed.
- **No author's base commit is bound.** Nothing records the base a review diffed, so a base change
  after the review — a retarget onto `main`, a push to a ghstack base, or a native-stack PR's base
  branch moved back along the PR's head history (trymerge refuses a head not built on that branch's
  tip) — can widen what lands beyond what the model reviewed, for every author; pytorch's land-time
  gate compares heads only. See the next two bullets.
- **ghstack branches are trusted.** As with human approvals, trymerge does not tie what it lands
  from a ghstack stack to the file list that was reviewed: anyone who can push `gh/*` branches,
  which is anyone with write access, can arrange before or after the review for unreviewed content
  in any path to land. An eligible author's ghstack PR needs no human approval.
- **Native-stack bases are trusted.** When trymerge lands a GitHub-native stack, merging one of its
  PRs lands every open PR of the stack up to it, bottom first, after checking each one's own file
  list against the merge rules; a PR above the bottom one lands the changes between the tip of its
  base branch, the head branch of the PR below, and its head. trymerge refuses the merge when a PR
  it lands moved while the merge was prepared, or when a PR's head is not built on the tip of its
  base branch, but nothing compares that base with the one greenlight reviewed: pytorch's land-time
  gate compares heads only, and the verdict reads the base branch's name, never its commit. The
  branch below is writable by anyone with write access, and moving it back along the PR's head
  history after the review makes the PR land changes its reviewed file list left to the PR below. An
  open PR below lands in the same merge and needs its own authorization: a human approval, which
  trymerge does not tie to a commit, so one given before the move still counts, or greenlight's,
  which the land-time gate accepts only with a `LAND` for the moved head. Without either, trymerge
  refuses the merge. A closed PR below has already landed, so only the changes it dropped before
  landing come with the PR. Moving the PR out of its stack onto `main` after the review needs no
  push: trymerge then merges it alone, checking only its own file list, which then holds the changes
  of every PR below it, against the merge rules, where greenlight's approval satisfies the rule
  covering every path, while the land-time gate still sees the reviewed head. Either way, the scan
  withdraws that approval only when its next pass finds the PR ineligible, with no valid rule naming
  the author or a base trymerge refuses, and only on a PR inside the review window and not labelled
  `Stale`; a changed file list never withdraws it. An eligible author's native-stack PR needs no
  human approval.
- **A drifted PR keeps its eligibility.** Eligibility never reads files, so a push that takes a PR
  into new paths, or past 200 files, leaves it eligible. The push changes the head, so the scan
  dispatches a new review, and a diff past the size gate gets its canned `NO_LAND`, which dismisses
  greenlight's approval; until the new verdict, the land-time gate holds or refuses the merge, since
  the standing `LAND` is for an older commit.
- **One team fails every verdict.** The verdict resolves the merge rules on every run, so a single
  team whose members cannot be read fails every `LAND` and `NO_LAND` recorded without `--shadow`,
  with no row. It fails closed.
