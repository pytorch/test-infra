-- GreenLight Quality page, coverage row: one row of ledger totals for the effective window.
--
-- misc.greenlight_pr_state is append-only. emit_id terminates the sort key, so the underlying
-- ReplacingMergeTree collapses nothing and FINAL would be pure cost.
--
-- verdicts_total is deliberately raw emitted rows -- a re-emitted verdict is a verdict GreenLight
-- published twice -- while verdicts_distinct_pr_sha collapses re-emissions down to the head SHAs
-- actually ruled on. The two differ by a wide margin, so a caller that describes its tile as
-- "per (PR, head SHA)" must read the distinct column and not this one.
--
-- Summing a per-PR uniqExactIf(head_sha) is exactly a global uniqExactIf((pr_number, head_sha)):
-- the pairs partition by pr_number, which is the GROUP BY key, so no head SHA is counted under two
-- PRs. The equality rests on uniqExact being exact -- uniq in its place makes every group an
-- independent estimate, and summing estimates drifts from the true distinct count.
--
-- window_start clamps startTime up to the ledger's first row. GreenLight cannot hold a verdict from
-- before its ledger existed, so a picker widened past that point inflates the denominator of every
-- rate on this page while the numerator physically cannot follow. Every other query on the page
-- applies the same clamp; effective_start and effective_end report the window this one used.
--
-- min(version) over an empty set returns 1970-01-01 rather than NULL, so a repo with no ledger rows
-- would clamp to nothing and let any startTime through to scan all of history. ledger_start falls
-- back to now64(3) in that case, which collapses the window to empty instead -- the clamp has to
-- fail closed, since the repo parameter is caller-supplied.
--
-- window_end clamps to now64(3): the page snaps stopTime up to the next bucket boundary, so it is
-- always slightly in the future, and an unclamped far-future stopTime overflows DateTime64.
--
-- REVERTED is excluded from prs_evaluated: GreenLight's revert guard writes that marker against PRs
-- it never reviewed, so counting them as evaluated overstates coverage. Excluding the one known
-- non-evaluation marker, rather than allow-listing evaluation statuses, keeps future statuses
-- counted without an edit here. prs_with_verdict is the stricter reading -- PRs GreenLight actually
-- ruled on -- and is the honest denominator when the caller needs "PRs that got a verdict".
--
-- pr_verdict, and so prs_land and prs_no_land, ranks by (run_id, version) over rows already
-- filtered to LAND and NO_LAND: it is a PR's latest verdict inside the window, not its latest
-- state. The canonical readers -- clickhouse_queries/greenlight_pr_states/query.sql and
-- pages/api/greenlight/pr_state.ts -- rank that same key over every status, so a PR whose newest
-- row is REVERTED still counts under prs_land here, and a caller must not present these two
-- columns as current state. Statuses outside the verdict pair leave pr_verdict at the empty
-- string, which is what separates a PR GreenLight ruled on from one it only dispatched.
WITH
(
    SELECT min(version)
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
) AS ledger_min,
if(ledger_min > toDateTime64(0, 3), ledger_min, now64(3)) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,

per_pr AS (
    SELECT
        max(status != 'REVERTED') AS evaluated,
        countIf(status IN ('LAND', 'NO_LAND')) AS n_verdicts,
        uniqExactIf(head_sha, status IN ('LAND', 'NO_LAND')) AS n_verdict_shas,
        countIf(status = 'LAND') AS n_land,
        countIf(status = 'NO_LAND') AS n_no_land,
        countIf(status IN ('CANCELLED', 'FAILED')) AS n_cancelled_failed,
        argMaxIf(status, (run_id, version), status IN ('LAND', 'NO_LAND'))
            AS pr_verdict
    FROM misc.greenlight_pr_state
    WHERE
        repo = {repo: String}
        AND version >= window_start
        AND version < window_end
    GROUP BY pr_number
)

SELECT
    countIf(evaluated) AS prs_evaluated,
    countIf(pr_verdict != '') AS prs_with_verdict,
    sum(n_verdicts) AS verdicts_total,
    sum(n_verdict_shas) AS verdicts_distinct_pr_sha,
    sum(n_land) AS land_verdicts,
    sum(n_no_land) AS no_land_verdicts,
    sum(n_cancelled_failed) AS cancelled_failed,
    countIf(pr_verdict = 'LAND') AS prs_land,
    countIf(pr_verdict = 'NO_LAND') AS prs_no_land,
    window_start AS effective_start,
    window_end AS effective_end
FROM per_pr
