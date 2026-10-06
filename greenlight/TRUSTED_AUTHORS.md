# Trusted authors

greenlight reviews every open PR from the evaluation cohort (see the README's "Who is evaluated,
and whose verdict carries authority"), but only an eligible author's review carries authority: only
it can approve the PR, render in Dr. CI, or satisfy the land-time merge gate. Every other review is
shadow. Eligibility comes from the merge rules alone, and an ineligible author is what
`--allow-untrusted-author` calls untrusted. This document covers who is eligible, onboarding and
offboarding, and the risks this design accepts.

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
  is shadow for that pass, stays out of fingerprinting and dispatch, and fails the pass; after a
  rate limit the remaining reads are skipped and those PRs are reported as abandoned. A candidate
  fingerprinted at a head other than the one its files were read at is deferred to the next pass.
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

Eligibility is not part of the fingerprint, so a PR already reviewed in shadow is not re-reviewed
when it becomes eligible, whatever the cause: a rule naming its author or covering its files, a
retarget to `main`, or a change to the eligibility check. A push, a comment the fingerprint covers,
or a local `just run review --pr <N> --force` re-reviews it.

Removing an author revokes nothing by itself: the scan skips an approved PR until it changes, and
stops listing the author's PRs once no rule names them. The next verdict recorded on such a PR is
shadow unless a remaining rule still covers it, and a shadow verdict dismisses greenlight's approval.
To take a live approval back at once, dismiss greenlight's review by hand. The kill switches are the
"Greenlight Review Bot" rule in `merge_rules.yaml`, without which no greenlight approval authorizes a
merge, and the `greenlight-scan` Lambda, whose disabling stops the scheduled scan.

## Accepted risks

- **A revert is caught only on a PR the scan lists.** The scheduled scan revert-guards the PRs it
  lists, the evaluation cohort's at every dial setting, so it misses a PR whose author no merge rule
  names, such as an author removed after greenlight approved the PR; a manual `--pr` run still
  covers any PR with an author login. Otherwise a reverted PR keeps greenlight's approval until
  someone dismisses it by hand.
- **Dr. CI can keep showing a stale approval.** When an author loses eligibility, greenlight's next
  shadow verdict on the PR dismisses its approval, but Dr. CI renders only non-shadow rows, so it
  keeps showing the last authoritative `LAND`, not even marked outdated while the head is
  unchanged. Nothing lands on it: greenlight's approval is gone.
- **Silent changes.** A login can join or leave a merge rule with no human edit — a nightly pytorch
  job regenerates the catch-all Metamates rule, and a bot approves and merges the change — and its
  PRs then gain authority, turn shadow, or keep only what a narrower rule covers.
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
- **A drifted PR keeps its approval.** A PR that drifts out of scope — a push that adds a file its
  author's rule does not cover, or that takes a path-scoped author's PR past 200 files — turns
  shadow. At dial `0`, or whenever the dial holds it out, it gets no shadow review to dismiss the
  approval greenlight already gave it, so that approval lingers until the land-time gate refuses
  the moved head SHA.
- **One team fails every verdict.** The verdict resolves the merge rules on every run, so a single
  team whose members cannot be read fails every `LAND` and `NO_LAND` recorded without `--shadow`,
  with no row. It fails closed.
