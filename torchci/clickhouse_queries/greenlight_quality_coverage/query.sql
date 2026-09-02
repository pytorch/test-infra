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
-- window_start clamps startTime up to the ledger's first row. GreenLight cannot hold a verdict from
-- before its ledger existed, so a picker widened past that point inflates the denominator of every
-- rate on this page while the numerator physically cannot follow. Every other query on the page
-- applies the same clamp; the UI renders the resulting window once, from here.
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
WITH
(
    SELECT min(version)
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
) AS ledger_min,
if(ledger_min > toDateTime64(0, 3), ledger_min, now64(3)) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end
SELECT
    uniqExactIf(pr_number, status != 'REVERTED') AS prs_evaluated,
    uniqExactIf(pr_number, status IN ('LAND', 'NO_LAND')) AS prs_with_verdict,
    countIf(status IN ('LAND', 'NO_LAND')) AS verdicts_total,
    uniqExactIf((pr_number, head_sha), status IN ('LAND', 'NO_LAND'))
        AS verdicts_distinct_pr_sha,
    countIf(status = 'LAND') AS land_verdicts,
    countIf(status = 'NO_LAND') AS no_land_verdicts,
    countIf(status IN ('CANCELLED', 'FAILED')) AS cancelled_failed,
    window_start AS effective_start,
    window_end AS effective_end
FROM misc.greenlight_pr_state
WHERE
    repo = {repo: String}
    AND version >= window_start
    AND version < window_end
