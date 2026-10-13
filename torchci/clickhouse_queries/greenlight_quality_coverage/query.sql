-- GreenLight Quality page, coverage row: ledger totals for the effective window, as one row or as
-- one row per day or week (see granularity below).
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
-- the pairs partition by pr_number, which per_pr groups by, so no head SHA is counted under two
-- PRs. The equality rests on uniqExact being exact -- uniq in its place makes every group an
-- independent estimate, and summing estimates drifts from the true distinct count.
--
-- window_start clamps startTime up to the ledger's first row. GreenLight cannot hold a verdict from
-- before its ledger existed, so a picker widened past that point inflates the denominator of every
-- rate on this page while the numerator physically cannot follow. latency and merge_authority clamp
-- to the ledger's first row over every population, not the one shadowMode selects; effective_start
-- and effective_end report the window this one used.
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
-- filtered to LAND and NO_LAND: it is a PR's latest verdict inside the window (inside the bucket,
-- at day or week granularity), not its latest state. The canonical readers --
-- clickhouse_queries/greenlight_pr_states/query.sql and pages/api/greenlight/pr_state.ts -- rank
-- that same key over every status, so a PR whose newest row is REVERTED still counts under
-- prs_land here, and a caller must not present these two columns as current state. Statuses
-- outside the verdict pair leave pr_verdict at the empty string, which is what separates a PR
-- GreenLight ruled on from one it only dispatched.
--
-- shadowMode selects the population: 'enforcing' for PRs GreenLight ruled on for real,
-- 'shadow' for those it evaluated while withholding its approving review, anything else for
-- both. Unrecognised values fall through to both, because the API route hands the query
-- string to ClickHouse without validating it.
--
-- The flag is attributed per PR (per PR and bucket, at day or week granularity) by max(shadow) and
-- applied after the GROUP BY, never as a row filter. A PR carrying rows of both kinds -- which
-- eligibility changing mid-cycle produces -- would otherwise lose rows from its group and
-- be reconstructed wrong rather than excluded, silently moving it between populations instead of
-- out of one.
--
-- ledger_start carries the same filter, so the clamp describes the population being counted.
-- clickhouse_queries/greenlight_quality_reverts applies both filters the same way, so the two
-- resolve the same window in every mode -- which is what keeps prs_evaluated on the whole-window
-- row equal to that query's evaluated_prs_total.
--
-- granularity 'day' or 'week' returns one row per UTC day or Monday-starting week, each metric
-- counted over that bucket's part of the effective window; any other value, the default 'window'
-- included, returns the single whole-window row. effective_start and effective_end describe the
-- whole window on every row. Buckets come from toStartOfDay and toMonday under multiIf because
-- dateTrunc rejects 'window' as a unit even in a branch that is never taken.
--
-- is_shadow is taken per PR and bucket, so each bucket counts what the whole-window row would count
-- over that bucket alone. A PR carrying rows of both kinds can therefore fall in one population on
-- one bucket and in the other on the next, and in 'enforcing' and 'shadow' mode its row counts --
-- verdicts_total, land_verdicts, no_land_verdicts, cancelled_failed -- need not sum across buckets
-- to the window's, the same as merge_authority's counts for a PR re-landed in a later bucket.
-- The PR and (PR, head SHA) counts need not sum: a PR active on two days counts on both.
--
-- per_pr is LEFT JOINed onto a spine of bucket starts because GROUP BY emits no row for a bucket
-- without ledger rows, nor for an empty window, which still returns its one row. Such a bucket
-- joins a single default-filled row, which every total here -- a countIf or a sum -- counts as
-- zero, and the shadow filter sits in the ON clause because a WHERE would read that row's is_shadow
-- as false and drop the bucket in 'shadow' mode. The spine ends at window_end rounded up to the
-- second: range() stops short of its end, and a bucket starting inside window_end's last second
-- still belongs to the window.
--
-- The day and week spine is built only over a non-empty window. An empty one takes the one-bucket
-- spine instead, so it returns its one row, bucketed at window_start, at every granularity, and a
-- startTime past 2106, where toStartOfDay wraps back to 1970, returns that one row rather than
-- decades of buckets.
WITH
(
    SELECT if(min(version) > toDateTime64(0, 3), min(version), now64(3))
    FROM misc.greenlight_pr_state
    WHERE
        repo = {repo: String}
        AND (
            ({shadowMode: String} = 'enforcing' AND NOT shadow)
            OR ({shadowMode: String} = 'shadow' AND shadow)
            OR {shadowMode: String} NOT IN ('enforcing', 'shadow')
        )
) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
{granularity: String} AS granularity,

per_pr AS (
    SELECT
        multiIf(
            granularity = 'day', toStartOfDay(version),
            granularity = 'week', toMonday(version),
            window_start
        ) AS bucket,
        max(status != 'REVERTED') AS evaluated,
        max(shadow) AS is_shadow,
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
    GROUP BY pr_number, bucket
)

SELECT
    spine.bucket AS coverage_bucket,
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
FROM (
    SELECT
        arrayJoin(
            if(
                granularity IN ('day', 'week') AND window_end > window_start,
                CAST(
                    range(
                        toUInt32(
                            if(
                                granularity = 'day',
                                toStartOfDay(window_start),
                                toMonday(window_start)
                            )
                        ),
                        toUInt32(ceil(toFloat64(window_end))),
                        if(granularity = 'day', 86400, 604800)
                    ),
                    'Array(DateTime)'
                ),
                [window_start]
            )
        ) AS bucket
) AS spine
LEFT JOIN per_pr
    ON
        spine.bucket = per_pr.bucket
        AND (
            ({shadowMode: String} = 'enforcing' AND NOT per_pr.is_shadow)
            OR ({shadowMode: String} = 'shadow' AND per_pr.is_shadow)
            OR {shadowMode: String} NOT IN ('enforcing', 'shadow')
        )
GROUP BY coverage_bucket
ORDER BY coverage_bucket
