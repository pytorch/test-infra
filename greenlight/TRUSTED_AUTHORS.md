# Trusted authors

greenlight reviews every open PR from the evaluation cohort (see the README's "Who is evaluated,
and whose verdict carries authority"), but only an eligible author's review carries authority: only
it can approve the PR, render in Dr. CI, or satisfy the land-time merge gate. Every other review is
shadow. This document covers who is eligible, the `pytorch/test-infra` issue that lists the trusted
authors, and the risks this design accepts.

## The rule

The scan treats a PR as authoritative only when both hold:

- its author is listed in the trusted-authors issue, matched case-insensitively;
- one rule in `pytorch/pytorch`'s `merge_rules.yaml` both names the author and covers every file
  the PR changes: team refs are expanded to their members, approver membership is exact-case
  against the author's login as GitHub reports it, and file patterns keep trymerge's own semantics
  (`merge_authz.MergeRule.covers`, compiled once by `merge_authz.compile_rule`).

A rule whose patterns include `*` or `**` and no `-` exclusion covers every path, so an author it
names qualifies without greenlight reading the PR's files. A rule with any pattern trymerge rejects
— a brace, parenthesis, bracket or backslash, or patterns that do not compile as a regex — is logged
and qualifies nobody. For an author only path-scoped rules name, the PR's files decide, and only on
a non-ghstack PR based on `main` (`merge_authz.changed_files`): trymerge lands a ghstack stack from
its orig branch and accepts no other base, so elsewhere the files cannot bound what lands and the
author is not eligible. An empty list is valid and means no enforcement: every PR is shadow.

Where it is checked:

- **The scan** (`authority.Authority`) answers per PR, lazily and at most once per pass, and reads a
  PR's files only for a listed author whom path-scoped rules alone name. A PR whose files read fails
  is shadow for that pass, stays out of fingerprinting and dispatch, and fails the pass; after a
  rate limit the remaining reads are skipped and those PRs are reported as abandoned. A candidate
  fingerprinted at a head other than the one its files were read at is deferred to the next pass.
- **The `--pr` gate** (`authz_gates.admit_target`) runs the same check on the PR it fetches. A
  refused target is never fingerprinted or dispatched, but a listed author's refused PR still goes
  through the revert guard.
- **The verdict** (`verdict.has_covering_rule`) re-checks the merge rules alone, never the issue,
  for every `LAND` or `NO_LAND` recorded without `--shadow`. A path-scoped rule's files must be the
  reviewed commit's: the first read must find the reviewed head, and a fresh read after the listing
  must find the same head and base. Any failure fails the command before the row is written.

Both log their answer with a reason that names no rule, team or file: the scan
`PR #<n> by <login>: <reason>` for every listed author it checks, the verdict
`merge-rule eligibility on <repo>#<n>: author '<login>' is eligible` or
`... is not eligible: <reason>`. Besides `eligible`, a reason is one of
`no author`, `excluded (bot or greenlight)`, `no merge rule names '<login>' in exact case`
(followed by `; a rule names '<Variant>'` when a rule names a case variant),
`file listing unavailable` (a ghstack head or a base other than `main`), and
`no single merge rule naming this login covers all changed files (<N>)`; the verdict adds
`head moved` and `head or base moved`. The scan's lines are in the `greenlight-scan` Lambda's
CloudWatch logs; for one PR, a `pytorch/test-infra` writer can dispatch `greenlight-review.yml` with
its `pr` input and read the run's log.

A `REVERTED` row can only deny, so on a PR with a recorded row whose author is currently listed it is
stamped non-shadow whatever the files show; otherwise it follows the PR's authority. A listed
author's PR whose recorded rows are all shadow therefore also gets a non-shadow `REVERTED` row and a
Dr. CI poke.

## The issue

The list is the body of `pytorch/test-infra` issue #8945 (`constants.TRUSTED_AUTHORS_ISSUE_NUMBER`).
Only the scan reads it, with its own token, once per invocation and before any other GitHub read. If
the issue cannot be read or parsed, every scan fails with that error until it is fixed. The body must
open with a fenced code block holding one `@login` per line:

````text
```
# blank lines and '#' comments are allowed
@alice
@bob
```
Anything after the closing fence is ignored.
````

- The first non-blank line opens the block: up to three leading spaces and exactly three backticks,
  then either nothing or the info string `text` in any case, with spaces or tabs around it allowed.
  Any other info string is an error, because GitHub draws some languages, such as `mermaid` or
  `math`, as a picture in place of the lines.
- The block closes at the first later line that is exactly three backticks, with up to three
  leading spaces and trailing spaces or tabs. Everything after it is ignored.
- Inside the block, every line is a blank line, a `#` comment, or `@login` with nothing else on it:
  surrounding whitespace is ignored, a trailing comment is not.
- Anything else is an error — text before the fence, a fence that never closes, any other line in
  the block, an empty body. An empty block is not an error; it is an empty list.

A mention inside a code block notifies nobody. The read must answer with the configured issue
itself, so a transferred issue, which GitHub redirects, and a pull request are both refused. For a
transferred, converted-to-discussion, or deleted issue, restore or recreate it, set
`TRUSTED_AUTHORS_ISSUE_NUMBER` to its number, and deploy: `greenlight-review.yml` picks the change up
on merge, and the `greenlight-scan` Lambda needs its release, the Terrafile pin, and the apply (see
the README's "Deployment").

### Onboarding and offboarding

Both are an edit to the issue body, with no deploy: the next scheduled scan (about 5 minutes) reads
it. A listed login still needs a merge rule that names it in its exact GitHub casing. Each pass warns
about a listed login no rule names in any casing, and the per-PR reason catches a miscased entry.

Listing an author does not re-review their PRs already reviewed in shadow, and neither does
retargeting a PR to `main`: the fingerprint covers neither. A push to the PR, or a local
`just run review --pr <N> --force`, gets it a fresh review.

Removing an author revokes nothing already approved. A review dispatched before the removal can
even approve afterwards, since the verdict checks merge rules only, and the scan then skips the PR
until it changes. To take a live approval back at once, dismiss greenlight's review by hand. The kill
switch is the "Greenlight Review Bot" rule in `merge_rules.yaml`: without it, no greenlight approval
authorizes a merge.

## Accepted risks

- **One-person grants.** Anyone who can edit the issue — any `pytorch/test-infra` writer (about 80
  today), the issue's author, or a token with Issues: write — can add a login alone. The merge
  rules bound what a grant is worth: a listed login gains authority only on its own PRs, and only
  where a merge rule already names it for every file the PR changes.
- **A weak audit trail.** The issue's edit history is the record of who changed the list. Each scan
  logs the listed logins and the issue's `updated_at`, which dates a change but does not name who
  made it.
- **A broken issue stops the scan.** Until it is fixed, no PR is reviewed and no reverted PR is
  revoked.
- **A revert is caught only on a listed PR.** The scheduled scan revert-guards the PRs it lists: the
  merge-rule cohort, or at dial `0` every listed login. So an author outside every merge rule is
  missed at any other dial, and a delisted author at dial `0`; a manual `--pr` run still covers a
  listed author's PR. Otherwise a reverted PR keeps greenlight's approval until someone dismisses
  it by hand.
- **Dr. CI can keep showing a stale approval.** When an author loses eligibility, greenlight's next
  shadow verdict on the PR dismisses its approval, but Dr. CI renders only non-shadow rows, so it
  keeps showing the last authoritative `LAND`, not even marked outdated while the head is
  unchanged. Nothing lands on it: greenlight's approval is gone.
- **Silent drop-outs.** A login can leave a merge rule with nobody touching the issue — a nightly
  pytorch job regenerates the Metamates rule — and its PRs then turn shadow, or keep only what a
  narrower rule covers.
- **Inherited logins.** A login freed by a deleted or renamed account can be registered by someone
  else, who inherits its entry here, as they would its merge-rules entry.
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
  author's rule does not cover — turns shadow. At dial `0`, or whenever the dial holds it out, it
  gets no shadow review to dismiss the approval greenlight already gave it, so that approval
  lingers until the land-time gate refuses the moved head SHA.
- **One team fails every verdict.** The verdict resolves the merge rules on every run, so a single
  team whose members cannot be read fails every `LAND` and `NO_LAND` recorded without `--shadow`,
  with no row. It fails closed.
