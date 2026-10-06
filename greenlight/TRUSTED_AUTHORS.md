# Trusted authors

greenlight lists every open PR from the evaluation cohort (see the README's "Who is evaluated, and
whose verdict carries authority") but reviews only those whose author is eligible for them, and only
an eligible author's review carries authority: only it can approve the PR, render in Dr. CI, or
satisfy the land-time merge gate. For a listed PR whose author is not eligible for it, Dr. CI says
its changes can't be reviewed due to `merge_rules.yaml` restrictions, or are too big to review when
the PR is oversized. Either line also replaces a greenlight verdict on an older commit, but never
one on the PR's current head; in every other case — an eligible author's PR that is not oversized,
a draft, an author no rule names, a failed check — an outdated verdict stays. Eligibility comes from
the merge rules alone, and an ineligible author is what `--allow-untrusted-author` calls untrusted:
that local-only flag reviews such a PR anyway, in shadow. This document covers who is eligible,
onboarding and offboarding, and the risks this design accepts.

## The rule

A PR is authoritative only when one rule in `pytorch/pytorch`'s `merge_rules.yaml` both names its
author and covers every file the PR changes (`cohort.assess_rules`): team refs are expanded to their
members, approver membership is exact-case against the author's login as GitHub reports it, and
file patterns keep trymerge's own semantics (`merge_authz.MergeRule.covers`, compiled once by
`merge_authz.compile_rule`).

A rule whose patterns include `*` or `**` and no `-` exclusion covers every path, so an author it
names qualifies without greenlight reading the PR's files. A rule with any pattern trymerge rejects
— a brace, parenthesis, bracket or backslash, or patterns that do not compile as a regex — is logged
and qualifies nobody. For an author only path-scoped rules name, the PR's files decide, and only on
a non-ghstack PR based on `main` (`merge_authz.changed_files`): trymerge lands a ghstack stack from
its orig branch and accepts no other base, so elsewhere the files cannot bound what lands and the
author is not eligible.

Where it is checked:

- **The scan** (`authority.Authority`) answers per PR, lazily and at most once per pass, and reads a
  PR's files only for an author whom path-scoped rules alone name. A PR whose files read fails
  is ineligible for that pass and fails it; after a rate limit the remaining reads are skipped and
  those PRs are reported as abandoned. Neither is fingerprinted or dispatched, nor has greenlight's
  approval dismissed. A candidate fingerprinted at a head other than the one its files were read at
  is deferred to the next pass.
- **The `--pr` gate** (`authz_gates.admit_target`) runs the same check on the PR it fetches. A
  refused target is never fingerprinted or dispatched, but one with an author login still goes
  through the revert guard.
- **The verdict** (`verdict.has_covering_rule`) runs the same check again for every `LAND` or
  `NO_LAND` recorded without `--shadow`. A path-scoped rule's files must be the
  reviewed commit's: the first read must find the reviewed head, and a fresh read after the listing
  must find the same head and base. Any failure fails the command before the row is written.

All three log their answer with a reason that names no rule, team or file: the scan and the `--pr`
gate `PR #<n> by <login>: <reason>` for every PR they check, the verdict
`merge-rule eligibility on <repo>#<n>: author '<login>' is eligible` or
`... is not eligible: <reason>`. Besides `eligible`, a reason is one of
`no author`, `excluded (bot or greenlight)`, `no merge rule names '<login>' in exact case`
(followed by `; a rule names '<Variant>'` when a rule names a case variant),
`file listing unavailable` (a ghstack head, a base other than `main`, or more than 200 changed
files), and `no single merge rule naming this login covers all changed files (<N>)`; the verdict
adds `head moved` and `head or base moved`. The scan's lines are in the `greenlight-scan` Lambda's
CloudWatch logs; for one PR, a `pytorch/test-infra` writer can dispatch `greenlight-review.yml` with
its `pr` input and read the run's log.

A `REVERTED` row can only deny, so on a PR with a recorded row it is stamped non-shadow whatever the
files show; on a PR with none it follows the PR's authority. A PR whose recorded rows are all shadow
therefore also gets a non-shadow `REVERTED` row and a Dr. CI poke.

## Onboarding and offboarding

Both are a `merge_rules.yaml` change in `pytorch/pytorch`, with no greenlight deploy. The scheduled
scan resolves the rules afresh on every pass (about every 5 minutes), a `--loop` daemon once its
cached copy is older than `PYTORCH_GREENLIGHT_MERGE_RULES_TTL_SECONDS`, and the verdict on every run.
A login gains authority only where a rule names it in its exact GitHub casing, and the per-PR reason
catches a miscased entry.

Eligibility is not part of the fingerprint, so a PR already reviewed in shadow, or one whose
approval the scan dismissed while it was ineligible, is not re-reviewed when it becomes eligible,
whatever the cause: a rule naming its author or covering its files, a retarget to `main`, or a
change to the eligibility check. A push, a comment the fingerprint covers, or a local
`just run review --pr <N> --force` re-reviews it.

Removing an author from a rule stops greenlight reviewing each of their PRs that no remaining rule
covers. On its next pass that lists such a PR inside the review window and not labelled `Stale`,
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
- **Dr. CI can keep showing a stale approval.** When an author loses eligibility with the head
  unchanged — a merge-rule change — the scan dismisses greenlight's approval on a listed PR inside
  the review window and not labelled `Stale`, but Dr. CI keeps showing the last authoritative
  `LAND`, not even marked outdated: it never replaces a verdict on the current head. Nothing lands
  on it once the approval is gone. Once the head moves, the outdated verdict gives way to the
  `merge_rules.yaml` or too-big line where one applies.
- **An approval can outlive eligibility.** The scan dismisses an approval only on a PR it lists
  inside the review window and not labelled `Stale`, and only while the PR's latest recorded row is
  a `LAND`. Every other approval stays: on a PR outside the window, labelled `Stale`, or by an author
  no rule names, and under a later `FAILED`, `CANCELLED` or in-flight row. pytorch's land-time gate
  honours only the PR's latest non-shadow row, and allows greenlight's approval only when that row
  is a `LAND` for the PR's current head; any other row holds or refuses the merge. Under a later
  non-shadow row the approval alone therefore cannot land the PR, but one whose `LAND` is still the
  latest non-shadow row, with the head unchanged, can, however its author's eligibility has
  changed since.
- **Silent changes.** A login can join or leave a merge rule with no human edit — a nightly pytorch
  job regenerates the catch-all Metamates rule, and a bot approves and merges the change — and its
  PRs then gain authority, lose it, or keep only what a narrower rule covers.
- **Inherited logins.** A login freed by a deleted or renamed account can be registered by someone
  else, who inherits its merge-rules entry and the eligibility that comes with it.
- **trymerge's quirks are mirrored.** Only a rename's new path is checked, never its source. A
  pattern is an unanchored prefix, so `docs` also covers `docsx/`. Some odd patterns cover every
  file: an empty pattern list, an empty-string pattern, a list of only `-` exclusions (everything
  it does not exclude), a lone inline-flag pattern such as `?x` or `?i`, and a pattern with a
  leading or trailing `|`.
- **Moved heads and bases.** The verdict's files check is not pinned to a SHA: a push and its undoing
  inside the listing window, seconds for a large PR, pass both reads. A path-scoped author's verdict
  recorded after a push writes a shadow row. The scan's deferral compares heads only, so a retarget
  between its two reads goes unnoticed; a retarget to any base but `main` is shadow at the verdict.
- **A catch-all author's base is not bound.** For an author an all-path rule names, no check reads
  the files or the base, so a base change after the review — a retarget, or a push to a ghstack
  base — can still widen what lands beyond what the model reviewed.
- **A drifted PR is not re-reviewed.** A PR that drifts out of scope — a push that adds a file its
  author's rule does not cover, or that takes a path-scoped author's PR past 200 files — gets no
  further review. The scan's next pass dismisses the approval greenlight already gave it while that
  `LAND` is still the PR's latest recorded row and the PR is not labelled `Stale`; until then the
  land-time gate holds or refuses the merge, since that `LAND` is for an older commit. A pass that
  cannot read the PR's files leaves the approval in place.
- **One team fails every verdict.** The verdict resolves the merge rules on every run, so a single
  team whose members cannot be read fails every `LAND` and `NO_LAND` recorded without `--shadow`,
  with no row. It fails closed.
