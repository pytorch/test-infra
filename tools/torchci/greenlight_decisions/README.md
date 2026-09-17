# greenlight_decisions

Exports one CSV row per pull request that greenlight has recorded state for, so
its verdicts can be reviewed in a spreadsheet. Verdicts, PR status, human
reviews and PR size all come from one ClickHouse query; the size of the diff
each verdict actually judged comes from the GitHub compare API.

## Running

```bash
cd tools/torchci
pip install -r requirements.txt
pip install -e .
python -m torchci.greenlight_decisions
```

`pip install -e .` alone is not enough — `pyproject.toml` declares no
dependencies, so the ClickHouse driver comes from `requirements.txt`.

Runtime requirements:

- `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME`, `CLICKHOUSE_PASSWORD`. If your
  shell already defines `CLICKHOUSE_HOST` instead (the variable the greenlight
  tooling uses), pass `CLICKHOUSE_ENDPOINT="$CLICKHOUSE_HOST"`. The host must be
  reachable over HTTPS from wherever you run this.
- The `gh` CLI, authenticated. It is not in any requirements file because it is
  not a Python package. `--skip-loc` is the only mode that does not need it.

Everything the tool does is read-only.

| flag | default | effect |
| --- | --- | --- |
| `--repo` | `pytorch/pytorch` | repository to export |
| `--as-of` | now | bound **greenlight's verdicts** to this ISO-8601 instant. Bounds nothing else — see misreading 2 |
| `--output` | `greenlight_decisions_<as-of>.csv` | destination |
| `--skip-loc` | off | skip every GitHub call and leave the LOC columns blank |

The default output lands in the current directory. Run from inside the repo and
you get an untracked CSV in your working tree; `.gitignore` covers
`greenlight_decisions_*.csv`, but pointing `--output` somewhere outside the
checkout is tidier.

`--skip-loc` turns the export into a pure SQL read that finishes in seconds. A
full run makes one GitHub compare call per decided PR, plus a second only for
those whose head moved after the verdict — about 1.2 calls per PR today, two in
the worst case.

Exit codes: `0` success; `1` nothing was written (could not connect, query
failed, no rows, or the file could not be written); `3` the CSV was written but
more than half the attempted LOC measurements failed, so the LOC and
`verdict_staleness` columns describe the outage rather than the pull requests.
The output file is built beside its destination and moved into place, so a
failed or interrupted run never leaves a truncated CSV or destroys a previous
one.

## Four ways to misread this file

**1. `loc` is the size of what greenlight judged, not the size of what shipped.**
The diff is measured at `decision_head_sha`, the head the verdict covers. For PR
192258 greenlight judged 71 lines and 18 shipped. Summing `loc` over landed rows
does not give "lines greenlight approved into main"; it gives the size of the
diffs it looked at, which is a different number. `pr_loc` is the other question —
the PR's own current size — and the two are deliberately separate columns.

**2. `--as-of` bounds greenlight's verdicts and nothing else.** It applies
`version <= as_of` to `misc.greenlight_pr_state`. It does **not** bound:

- `pr_status` — the latest value in the `default.pull_request` mirror
- `landed` — derived from main's current history
- `reverted` — derived from main's current history
- `final_head_sha`, and therefore `verdict_staleness` — also the latest
  mirrored value

So replaying an old `--as-of` gives you the verdicts as they stood then, judged
against the world as it is now. A PR that was open at that instant and has since
landed and been reverted shows its old verdict beside `landed=true,
reverted=true`. That is usually the question people want — "what did greenlight
say, and what became of it" — but "as of" implies a snapshot and this is not
one.

**3. One row per PR keeps only one of a PR's verdicts.** greenlight re-reviews on
new pushes, so a PR accumulates verdicts and the row carries a single one. PR
192132 recorded fifteen terminal verdicts over about five days, spanning both
`LAND` and `NO_LAND` under two different reasons; its row shows one of them —
`NO_LAND` — on a pull request that landed.

The information lost is smaller than that suggests: most discarded verdicts
repeat the `(status, reason)` the surviving row already reports, and only a
small minority of PRs ever changed verdict at all. `verdict_flipped` marks those,
and `n_terminal_decisions` above 1 marks a row that summarises a sequence. Two
consequences hold regardless — a reason histogram from this CSV under-counts
distinct `(PR, status, reason)` combinations, so read it as a ranking rather
than a census; and no row should be quoted as "what greenlight said" about a PR
without checking those two columns first.

**4. `verdict_staleness = exact` does not guarantee greenlight approved what
shipped.** PR 194741 matched exactly, and mergebot's rebase still dropped half
the change because a sibling PR had bumped the same pin minutes earlier. The
comparison is between the judged head and the final head of *this* PR; a landrace
against a sibling is invisible to it. This tool cannot detect that class at all.

## How the verdict is chosen

A PR's row carries one terminal verdict (`LAND` or `NO_LAND`) out of however many
greenlight recorded. The winner is **the verdict whose head SHA matches the PR's
final head**, if one exists; otherwise the most recent verdict by run and
version. Head-match outranks recency deliberately — a verdict covering the code
as it now stands is more useful than a newer one that judged something else.
This is not last-writer-wins, and `verdict_staleness` tells you which case you
got.

## Columns

### Identity and outcome

- `repo`, `pr_number`, `pr_url` — which PR the row is about.
- `pr_status` — `open`, `closed-merged` or `closed-abandoned`. This is the PR's
  own state, **not** a did-this-ship predicate: pytorch reopens a PR when it is
  reverted, so a PR that landed can read `open`. Three do today (164128, 166813,
  185173 — landed, reverted, reopened). Use `landed` for that question. A PR
  closed as a duplicate reports as `closed-abandoned`, with no separate value,
  because closing as a duplicate is an issues-only action and GitHub's pull
  request object carries no `state_reason` to distinguish it.
- `landed` — whether the code reached `main`. True when GitHub reports the PR
  merged (the merge button, how release-branch PRs land) **or** when a commit on
  `main` carries the PR's `Pull Request resolved:` trailer (normal and ghstack
  landings, where mergebot rebases and pushes rather than pressing merge).
  Neither branch alone is complete. `closed-merged` holds exactly when
  `landed AND NOT open`.
- `base_ref` — the branch the PR targets: `main`, a `release/*` branch, or a
  `gh/<user>/<n>/base` branch for ghstack PRs. Different populations, worth
  splitting before drawing conclusions.
- `reverted` — whether the code was reverted off `main`, read from main's
  history and independent of which verdict the row selected. Every reverted PR
  is also `landed`. A `LAND` with `reverted = true` is a false approval, not a
  success.

### The verdict

See misreading 3 before treating any of these as "what greenlight said".

- `decision` — `LAND`, `NO_LAND`, or empty when greenlight never reached a
  verdict.
- `decision_reason` — greenlight's machine-readable reason code.
- `decision_summary` — the first sentence of `decision_message`, capped at 200
  characters. For scanning; quote the full message, not this.
- `decision_message` — greenlight's full prose. LLM-authored.
- `n_terminal_decisions` — how many terminal verdicts this PR accumulated.
  Above 1 means the row summarises a sequence.
- `verdict_flipped` — whether this PR's verdicts were not all the same status.
  This is the honest "greenlight changed its mind" signal;
  `n_terminal_decisions > 1` alone usually just means it repeated itself.
- `lifecycle_status` — `decided` (a verdict exists, almost every row), or why
  `decision` is empty: `never-reviewed`, `in-flight` (a review started and never
  finished), `failed` (the review errored).

### Human review

- `human_approvals` — how many humans have a live approval.
- `human_approvers` — their logins, **semicolon-separated**. Splitting on `,`
  silently yields one field. Dismissed approvals are excluded; counting them
  would overstate approval, the worst direction for a land gate to be wrong in.
  Bots are excluded. greenlight's own author appears here, which is a confound
  for "an independent human approved".
- `human_change_requesters` — logins with live requested changes, same
  separator and same exclusions.
- `human_changes_requested` — **was zero on every row as of 2026-09-03.** A
  column of zeros is the finding, not a broken column: no human had requested
  changes on any greenlight-reviewed PR.

### Size

- `additions` / `deletions` / `changed_files` — GitHub's own counters for the
  pull request as it currently stands.
- `pr_loc` — `additions + deletions`. The size of the PR.
- `loc` — **added plus removed lines** in the diff greenlight judged, measured
  at `decision_head_sha`. Not a net change, and not the same question as
  `pr_loc`; the two disagree whenever the head moved after the verdict. See
  misreading 1.
- `sig_loc` — `loc` minus blank lines, comment lines and documentation files.
  Tests count as code.

### Provenance and diagnostics

- `decision_head_sha` — the head greenlight judged.
- `final_head_sha` — the PR's head as of the last mirror sync, not a live read.
- `base_sha` — the base the diff was measured against.
- `verdict_staleness` — how far the final head drifted from the judged one. The
  measured values come from `loc.STALENESS_*`; this export adds `none` on top.
  Three of them are findings about the code: `exact` (same head), `rebase-only`
  (different head, byte-identical content), `content-changed` (greenlight never
  saw what shipped). Two are not findings at all and must not be counted as
  drift: `not-measured` means the comparison could not be made, which is a
  statement about the tool or an unreachable GitHub, and `none` means there was
  no verdict to be stale against. A blank is a third non-finding — the
  measurement was never attempted, which `--skip-loc` produces. And `exact` is
  weaker than it sounds; see misreading 4.
- `files_changed_after_verdict` — how many files differ between the judged and
  final diffs. Blank, not `0`, when the comparison was not made.
- `decision_run_id` — which greenlight run emitted the selected verdict.
- `decision_version` — when it was emitted, to millisecond precision. Feeding
  this value straight back as `--as-of` reproduces the state including that
  verdict; the milliseconds are load-bearing for that, since truncating to
  seconds excludes it and the PR then reads as never decided.
- `loc_status` — whether the LOC measurement can be trusted, and if not, why.
  **The emitted set is defined in code, not here:
  `loc.LOC_STATUSES_BY_SEVERITY`, ordered least to most severe.** Read that
  tuple rather than a list in prose, which goes stale. What the categories mean
  for a consumer: `ok` is a complete measurement; `binary_skipped` and
  `truncated` are partial, so `loc` understates the diff; `missing_sha` and
  `parse_failed` mean nothing was measured, so `loc` is blank rather than small.
  On top of that closed set the export can emit a free-form
  `error: <Type>: <message>` when a lookup raised — so the column is **not** a
  closed enum. Filter with a prefix match on `error:` plus membership in the
  tuple; do not assume you have seen every value. One PR failing never aborts
  the export; it gets blank LOC columns and a status here. If most rows carry a
  failure the run exits 3 and the whole column is describing the run.
- `snapshot_at` — the `--as-of` value, repeated on every row. Second precision;
  unlike `decision_version` it is not used to reproduce anything.

## CSV handling

Written with a UTF-8 BOM: `decision_message` is prose and carries non-ASCII
characters (em-dashes, today), which Excel on Windows renders as mojibake
without one.

Any cell whose text begins with `=`, `+`, `-` or `@` is prefixed with an
apostrophe so Excel and Sheets do not evaluate it. The check looks past leading
whitespace and control bytes, because spreadsheets strip those before deciding
whether a cell is a formula. `decision_message` is LLM-authored and can
legitimately open with a `-` bullet. No column in this schema is ever negative,
so the guard has no numeric false positives.
