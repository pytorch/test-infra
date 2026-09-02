-- GreenLight Quality page, latency row: one row holding two reported clocks and a third interval
-- that is measured only to count how often the in-progress signal was visible.
--
--   e2e       commit timestamp -> first LAND/NO_LAND, per (pr_number, head_sha)
--   dispatch  commit timestamp -> first AI_REVIEW_DISPATCHED, per (pr_number, head_sha)
--   review    AI_REVIEW_DISPATCHED -> LAND/NO_LAND, per review cycle; counted, never summarised
--
-- A review cycle is (pr_number, head_sha, eval_hash). That key is not one dispatch->verdict pass: a
-- cycle can carry several dispatches and several verdicts, so its clock takes the earliest of each.
-- (pr_number, head_sha) is not unique across cycles either, since a re-dispatch usually mints a
-- fresh eval_hash. The two push-anchored clocks are therefore per head_sha and take that SHA's
-- earliest event, because the commit timestamp they measure from is a property of the SHA and
-- re-dispatches would otherwise count it repeatedly.
--
-- The upper tail is reported as a count under a fixed cutoff, never as a p90. Both push-anchored
-- distributions are bimodal with an empty band separating the fast and slow modes, and the p90 index
-- falls inside that band, so one extra observation drags the reported value clear across the gap. A
-- fixed cutoff moves smoothly with the data instead. The cutoffs MUST stay hardcoded literals --
-- deriving one from the distribution would reintroduce precisely the instability they exist to
-- remove -- and each is emitted as a column so the caller renders the threshold from the query
-- rather than repeating it in prose that can drift out of step with the SQL.
--
-- n_review_over_threshold counts review cycles outliving Dr. CI's render cron, the soonest an author
-- could see the in-progress marker at all. It bounds how often the signal was visible rather than
-- measuring latency. The 900 is that cron: .github/workflows/update-drci-comments.yml schedules
-- "*/15 * * * *" and carries pytorch/pytorch in its matrix. If that schedule changes, this constant
-- has to follow it. review_visible_after_s is emitted so the caller renders the threshold from data
-- rather than naming a duration of its own, keeping the figure on the page tied to the value that
-- produced it.
--
-- ClickHouse re-executes a named subquery at every reference site instead of materializing it once,
-- so anchored is read exactly once: both push-anchored clocks and all three exclusion counters are
-- conditional aggregates over that single pass. Splitting them back into separate SELECTs -- one per
-- clock, or a subquery for the counters -- re-runs sha_units, pushes and the join underneath each
-- time. The review clock aggregates separately because it is a different grain, and the two one-row
-- results are cross-joined; both sides are unconditional aggregates, so each yields exactly one row
-- even when the window is empty.
--
-- The dispatch clock anchors on AI_REVIEW_DISPATCHED, not AI_REVIEW_STARTED. DISPATCHED is written
-- by the scan the instant it fires the reviewer workflow; STARTED is written once that workflow is
-- already running, and so always lands later. DISPATCHED is the earlier and truer mark for the
-- moment GreenLight first acts on a SHA.
--
-- Dispatch and verdict rows are NEVER paired on run_id: an AI_REVIEW_DISPATCHED row carries a
-- synthetic counter (max(run_id) + 1 at write time, so 1 for a PR's first dispatch) rather than the
-- workflow run that serves it. Pairing is on (pr_number, head_sha, eval_hash) only.
--
-- The ledger is append-only -- emit_id terminates the sort key, so FINAL and argMax collapse
-- nothing. Duplicate emissions of the same (cycle, status) are collapsed here with min(version),
-- which takes the first complete pass and keeps a re-emission from entering the aggregates twice.
--
-- CANCELLED and FAILED never form an observation: only LAND/NO_LAND counts as a verdict. A cycle
-- that failed an attempt and then reached a real verdict keeps that verdict's latency.
--
-- min(version) over an empty set returns 1970-01-01 rather than NULL, so ledger_start falls back to
-- now64(3) for a repo with no ledger rows, collapsing the window to empty. The clamp has to fail
-- closed: repo is caller-supplied, and an open clamp scans all of history. window_end clamps to
-- now64(3) because the page snaps stopTime up to the next bucket, always landing in the future.
--
-- push_by_sha.timestamp is commit-AUTHORED time, not push-receipt time. When a SHA was authored
-- before GreenLight's ledger began, the interval it anchors is rollout backlog -- how old an
-- already-open PR was when the gate first saw it -- and not latency GreenLight caused. Those
-- observations are excluded rather than allowed to dominate the upper tail.
--
-- join_use_nulls = 0 on this cluster, so a LEFT JOIN miss yields 1970-01-01 rather than NULL and an
-- unguarded subtraction produces a ~56.7-year duration. push_by_sha does not cover every GreenLight
-- head SHA, so every push-anchored observation is gated on a real timestamp and the misses are
-- counted out instead of being silently absorbed. e2e_secs and dispatch_secs are computed for every
-- row, including those misses; the _ok flags are what keep the garbage out of the aggregates.
--
-- The three exclusion counters partition the dropped head SHAs and never double-count the same one:
-- excluded_no_push_ts is a missing anchor, excluded_push_after_event is an anchor that postdates the
-- event it anchors, excluded_pre_ledger is rollout backlog.
--
-- push_by_sha is not keyed one row per SHA (ORDER BY id, plain MergeTree): a SHA can carry several
-- rows bearing the same timestamp. Aggregating to one row per id before the join is what keeps a
-- single commit from contributing its latency to the quantiles more than once.
--
-- A percentile over an empty set is NULL, not 0. A window with no observations has no latency, and
-- rendering 0.0s there asserts a measurement that was never taken. The counts stay 0, so callers
-- gate every tile on its own n_ column.
WITH
(
    SELECT min(version)
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
) AS ledger_min,
if(ledger_min > toDateTime64(0, 3), ledger_min, now64(3)) AS ledger_start,
greatest({startTime: DateTime64(3)}, ledger_start) AS window_start,
least({stopTime: DateTime64(3)}, now64(3)) AS window_end,
toDateTime64(0, 3) AS epoch,
toFloat64(10800) AS e2e_cutoff_s,
toFloat64(10800) AS dispatch_cutoff_s,
toFloat64(900) AS review_visible_after_s,

sha_units AS (
    SELECT
        pr_number,
        head_sha,
        minIf(version, status IN ('LAND', 'NO_LAND')) AS first_verdict_at,
        minIf(version, status = 'AI_REVIEW_DISPATCHED') AS first_dispatch_at
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
    GROUP BY pr_number, head_sha
),

cycles AS (
    SELECT
        minIf(version, status = 'AI_REVIEW_DISPATCHED') AS dispatch_at,
        minIf(version, status IN ('LAND', 'NO_LAND')) AS verdict_at
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
    GROUP BY pr_number, head_sha, eval_hash
),

pushes AS (
    SELECT
        id,
        min(timestamp) AS pushed_at
    FROM materialized_views.push_by_sha
    WHERE
        id IN (
            SELECT DISTINCT head_sha
            FROM misc.greenlight_pr_state
            WHERE repo = {repo: String}
        )
    GROUP BY id
),

anchored AS (
    SELECT
        p.pushed_at AS pushed_at,
        (
            u.first_verdict_at >= window_start
            AND u.first_verdict_at < window_end
        ) AS verdict_in_window,
        (
            u.first_dispatch_at >= window_start
            AND u.first_dispatch_at < window_end
        ) AS dispatch_in_window,
        (verdict_in_window OR dispatch_in_window) AS considered,
        (
            (verdict_in_window AND p.pushed_at > u.first_verdict_at)
            OR (dispatch_in_window AND p.pushed_at > u.first_dispatch_at)
        ) AS push_after_event,
        (
            verdict_in_window
            AND p.pushed_at > epoch
            AND p.pushed_at >= ledger_start
            AND u.first_verdict_at >= p.pushed_at
        ) AS e2e_ok,
        (
            dispatch_in_window
            AND p.pushed_at > epoch
            AND p.pushed_at >= ledger_start
            AND u.first_dispatch_at >= p.pushed_at
        ) AS dispatch_ok,
        dateDiff('millisecond', p.pushed_at, u.first_verdict_at)
        / 1000.0 AS e2e_secs,
        dateDiff('millisecond', p.pushed_at, u.first_dispatch_at)
        / 1000.0 AS dispatch_secs
    FROM sha_units AS u
    LEFT JOIN pushes AS p ON p.id = u.head_sha
),

push_clocks AS (
    SELECT
        countIf(e2e_ok) AS n_end_to_end,
        if(
            countIf(e2e_ok) = 0,
            NULL,
            quantileExactIf(0.5) (e2e_secs, e2e_ok)
        ) AS e2e_p50_s,
        countIf(e2e_ok AND e2e_secs <= e2e_cutoff_s) AS n_e2e_within_cutoff,
        countIf(dispatch_ok) AS n_dispatch,
        if(
            countIf(dispatch_ok) = 0,
            NULL,
            quantileExactIf(0.5) (dispatch_secs, dispatch_ok)
        ) AS dispatch_p50_s,
        countIf(
            dispatch_ok AND dispatch_secs <= dispatch_cutoff_s
        ) AS n_dispatch_within_cutoff,
        countIf(considered AND pushed_at <= epoch) AS excluded_no_push_ts,
        countIf(
            considered
            AND pushed_at > epoch
            AND push_after_event
        ) AS excluded_push_after_event,
        countIf(
            considered
            AND pushed_at > epoch
            AND NOT push_after_event
            AND pushed_at < ledger_start
        ) AS excluded_pre_ledger
    FROM anchored
),

review_clock AS (
    SELECT
        count() AS n_review,
        countIf(secs > review_visible_after_s) AS n_review_over_threshold
    FROM (
        SELECT dateDiff('millisecond', dispatch_at, verdict_at) / 1000.0 AS secs
        FROM cycles
        WHERE
            verdict_at >= window_start
            AND verdict_at < window_end
            AND dispatch_at > epoch
            AND verdict_at >= dispatch_at
    )
)

SELECT
    p.n_end_to_end AS n_end_to_end,
    p.e2e_p50_s AS e2e_p50_s,
    p.n_e2e_within_cutoff AS n_e2e_within_cutoff,
    e2e_cutoff_s,
    r.n_review AS n_review,
    r.n_review_over_threshold AS n_review_over_threshold,
    review_visible_after_s,
    p.n_dispatch AS n_dispatch,
    p.dispatch_p50_s AS dispatch_p50_s,
    p.n_dispatch_within_cutoff AS n_dispatch_within_cutoff,
    dispatch_cutoff_s,
    p.excluded_no_push_ts AS excluded_no_push_ts,
    p.excluded_push_after_event AS excluded_push_after_event,
    p.excluded_pre_ledger AS excluded_pre_ledger
FROM push_clocks AS p
CROSS JOIN review_clock AS r
