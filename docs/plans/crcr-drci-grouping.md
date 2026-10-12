# Plan: group CRCR downstream failures by repo in the Dr. CI comment

Implements `docs/crcr-drci-integration-issue.md`. Replaces the flat `CRCR (non-blocking)` job list
with one nested `<details>` per downstream repo, and folds the on-call pin into that block instead of
a standalone per-repo pytorch-bot comment.

Decision taken up front: **the pin is delivered by the Dr. CI sweep only**, and `crcrOncallBot` is
deleted. The sweep already rebuilds the whole comment every 15 minutes, so it is the single writer
and the single renderer. Cost: the pin is up to 15 minutes late instead of webhook-immediate, and no
comment is created when the Dr. CI comment does not exist yet (same behavior `upsertPrStatusSection`
already has).

## Steps

1. **`lib/fetchRecentWorkflows.ts`** — `fetchCrcrWorkflows` currently filters to
   `conclusion IN ('failure','cancelled','timed_out')`. Drop the filter so the caller can compute the
   `M` in `N of M jobs failed`, and surface `downstreamRepo`, `checkRunId` and `workflowRunUrl` on
   each job. Verify: existing callers still get failures by filtering on `conclusion`.

2. **`lib/types.ts`** — add `downstreamRepo`, `checkRunId`, `workflowRunUrl` to
   `RecentWorkflowsData` next to the existing `downstreamLevel`. Verify: `tsc` clean.

3. **`lib/crcr/crcrComment.ts`** (new) — the only renderer:
   - `CRCR_SECTION_START` / `CRCR_SECTION_END` delimiters, so the section can be extracted and
     spliced the way `lib/prStatus.ts` does for the PR Status section.
   - `pinnedRepos(body)` — parse `<!-- crcr-pin:<repo> -->` markers out of an existing comment.
   - `renderCrcrSection({failedByRepo, totalByRepo, onCallsFor, pinned})` — one `<details>` per repo
     with failed jobs, sorted by repo then job name.
   - The pin rule: a repo whose marker is already in the old body renders its handles **without** the
     `@` prefix, so a rewritten comment never re-notifies. Keyed by repo, not by SHA — editing the
     comment re-evaluates every mention in it, so a SHA-keyed marker would re-page on every push.
   - Verify: `test/crcrComment.test.ts`.

4. **`pages/api/drci/drci.ts`** — group CRCR jobs by repo, load the allowlist once per sweep, pass the
   rendered section to `constructResultsComment` instead of the flat `crcrL3Jobs` section, and keep
   L4 flowing into `failedJobs` untouched. Verify: `test/drci.test.ts`.

5. **Delete `lib/bot/crcrOncallBot.ts`**, its registration in `lib/bot/index.ts`, and
   `test/crcrOncallBot.test.ts`. `pytorchBotHandler` imports `downstreamRepoFromCheckRunName` from
   that module, so move that helper to `lib/crcr/crcrUtils.ts`. Verify: `tsc` + `test/pytorchBot*`.

6. **Tests** — renderer unit tests, plus `drci.test.ts` coverage for a repo with on-calls, a repo
   without, and the no-re-pin case.

7. **Verify**: `yarn tsc`, `yarn lint`, `npx jest test/crcrComment.test.ts test/crcrOncallBot.test.ts
   test/drci.test.ts test/crcrBlockingFailures.test.ts`.

## Findings during review (fixed)

Two correctness problems surfaced while re-reviewing the finished change, both downstream of dropping
the query's `conclusion IN ('failure','cancelled','timed_out')` filter and of reading the table at PR
scope rather than commit scope:

1. **Re-runs were double-counted and could render stale red.** A re-run writes a new row rather than
   updating the old one, so a job that failed and was then re-run green had a red row and a green row.
   Fixed with `latestAttemptPerJob`, which keeps the highest `run_attempt` per (repo, workflow, job) —
   the same resolution the HUD's CRCR merge uses and the same thing GitHub's checks UI shows. This
   also fixes the `M` in `N of M jobs failed`, which was counting attempts rather than jobs.
2. **Superseded pushes leaked into the section.** The query is PR-scoped, so a failure from an older
   commit kept a red block alive in a comment that claims to describe the current commit. Rows are
   now filtered to `pr_info.head_sha`, matching how `getWorkflowJobsStatuses` scopes normal rows.

3. **The pin was keyed to the repo, which silently dropped paging for people who
   joined the on-call list later.** A repo-keyed marker meant the second sweep saw "already pinned"
   and rendered every handle bare -- including an on-call added after the first failure, who was
   therefore never notified. Markers are now per login, and a login listed by two repos in one sweep
   is mentioned once (`takeUnpaged` threads one global set through the blocks).
4. **`latestAttemptPerJob` broke ties by row order.** The relay defaults `run_attempt` to 1 when the
   downstream omits it, so two genuine attempts can both claim attempt 1 and the surviving row was
   whatever ClickHouse returned. Ties now prefer the failing row: a green row reported as red is
   noise, a red row reported as green is a missed page.

## Round 3 — challenger findings, fixed

6. **Markers were read from the whole comment body**, so a marker quoted anywhere on the PR (they are
   plain HTML comments in a comment maintainers discuss) silently suppressed a real page while the
   comment claimed the person had been notified. Under-notification, worse than the double-paging the
   design guards against. `notifiedHandles` now scans only the delimited section, via a new
   `extractCrcrSection` mirroring `extractPrStatusSection`.
7. **The login regex rejected team handles and underscores**, which the deleted bot accepted (it
   interpolated the allowlist value with no validation), so `pytorch/pytorch-dev-infra` was dropped
   and the block then misreported the reason as "No on-call is configured". Validation widened to
   match `prStatus.ts`'s reviewer pattern, and the "none configured" line now keys off an explicit
   flag rather than the raw list length.
8. **L4 failures stopped naming an owner.** The deleted bot pinned on L4 too; the section was L3-only,
   so a blocking failure was reported with nobody to act on it. L4 failures now get a block labelled
   `L4 (blocking)` as well as keeping their `NEW FAILURES` entry.

9. **Trailing separators in a handle.** `_` sat in the same regex alternation as the bare
   alphanumeric, so nothing forced a name to *end* alphanumeric: `a_`, `org/team_`, `a/b_` reached
   the comment as mentions and recorded pins. GitHub does not treat a trailing `-`/`_` as part of a
   login, so `@trail-` would page somebody who is not on the allowlist. The regex alone cannot
   express the rule (an earlier repetition shortens its match and eats the separator), so it is now
   an explicit `isSafeHandle` predicate; doubled interior separators are rejected with it.
10. **A blocking L4 pin told the on-call the failure was non-blocking** — the opposite of true, on the
    one level that holds the merge — and omitted the "reply here" call to action. The sentence is now
    level-aware and both arms carry the call to action.

## Out of scope

- No changes to the title counts: L3 stays in "Unrelated Failures". The section header and position
  are unchanged.
- L4 keeps its `NEW FAILURES` entry and stays blocking; the CRCR block only adds its owner.
- `docs/crcr-drci-integration-issue.md` is the issue text, not part of the change. Nothing is
  committed.
