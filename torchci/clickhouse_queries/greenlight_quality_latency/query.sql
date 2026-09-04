-- GreenLight Quality page: the latency row's two reported clocks and a third interval measured
-- only to count how often the in-progress signal was visible, plus the review-run row's two
-- counts of how often a review cycle ended badly or ran long.
--
--   e2e       push receipt -> first LAND/NO_LAND, per (pr_number, head_sha)
--   dispatch  push receipt -> first AI_REVIEW_DISPATCHED, per (pr_number, head_sha)
--   review    AI_REVIEW_DISPATCHED -> LAND/NO_LAND, per review cycle; counted, never summarised
--   run       AI_REVIEW_STARTED -> terminal status, per review cycle; counted, never summarised
--
-- A review cycle is (pr_number, head_sha, eval_hash). That key is not one dispatch->verdict pass: a
-- cycle can carry several dispatches and several verdicts, so its clock takes the earliest of each.
-- (pr_number, head_sha) is not unique across cycles either, since a re-dispatch usually mints a
-- fresh eval_hash. The two push-anchored clocks are therefore per head_sha and take that SHA's
-- earliest event, because the push timestamp they measure from is a property of the SHA and
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
-- A review run is a review cycle that reached a terminal status, and n_review_runs counts those
-- whose terminal status lands in the window. It is a wider population than n_review, which is
-- verdict-only and additionally requires a usable dispatch anchor, so the two denominators are
-- never interchangeable. Which status is terminal follows the same rule the latency clocks use: a
-- cycle carrying both a verdict and a CANCELLED/FAILED attempt is a verdict. The remaining cycles --
-- dispatched, no terminal status yet -- are in flight and enter neither numerator nor denominator.
--
-- n_review_runs_failed counts FAILED and NOT CANCELLED. A cancelled run is the design working: the
-- reviewer workflow runs in a singleton concurrency group and the scan cron supersedes an in-flight
-- run when a newer dispatch arrives, so counting cancellations would report routine supersession as
-- breakage and would dominate the figure -- all-time the ledger holds 15 cancelled cycles against 1
-- that ended FAILED. Cancelled runs stay in the denominator, because CI did attempt them.
--
-- The numerator is per cycle, not per FAILED row, and the two differ by a lot: a cycle that keeps
-- failing is re-emitted on every retry, so the 7 FAILED rows the ledger holds all-time are 3 cycles,
-- one of which carries 5 of them. Two of those 3 went on to a verdict and are therefore verdicts,
-- not failures. Counting rows here would report 7 where 1 run failed.
--
-- A cycle that recorded both CANCELLED and FAILED and no verdict counts as failed: a written error
-- is a real fault, and reading it as supersession would hide it behind the concurrency group. The
-- ledger has never yet held such a cycle, so this rule is a decision rather than an observation.
--
-- The run clock anchors on AI_REVIEW_STARTED and falls back to AI_REVIEW_DISPATCHED, the opposite
-- of the dispatch clock's choice, because it answers the opposite question: the dispatch clock
-- measures how long GreenLight took to act on a SHA, so it wants the earliest mark, while this one
-- measures how long the reviewer workflow ran once it was running, and STARTED is written at that
-- moment. It is the ledger's own view of the run, not the GitHub Actions job duration -- nothing
-- here joins default.workflow_run -- so it carries whatever gap the ledger writes around the job.
--
-- n_review_runs_timed is a denominator of its own rather than a reuse of n_review_runs: a cycle
-- with no STARTED and no DISPATCHED row has no clock to measure, and counting it in the
-- denominator of a duration share would score an unmeasurable run as a fast one.
--
-- review_runtime_cutoff_s is a reporting cutoff, hardcoded for the same reason as the two above and
-- emitted as a column so the caller renders it instead of naming a duration of its own. It is not
-- read from any workflow timeout; nothing downstream of the ledger enforces it.
--
-- ClickHouse re-executes a named subquery at every reference site instead of materializing it once,
-- so anchored is read exactly once: both push-anchored clocks and all five drop counters are
-- conditional aggregates over that single pass. Splitting them back into separate SELECTs -- one per
-- clock, or a subquery for the counters -- re-runs sha_units, pushes and the join underneath each
-- time. The review clock aggregates separately because it is a different grain, and cycles is read
-- exactly once for the same reason: its two clocks and all six counters are conditional aggregates
-- over one pass, with the window and anchor tests carried as per-row flags rather than as a WHERE
-- that would admit only one of them. The two one-row results are cross-joined; neither side groups,
-- so each yields exactly one row even when the window is empty.
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
-- CANCELLED and FAILED never form a latency observation: only LAND/NO_LAND counts as a verdict, and
-- every clock reported above ends on one. A cycle that failed an attempt and then reached a real
-- verdict keeps that verdict's latency. The run counters are where they are read at all, as terminal
-- marks rather than verdicts, which is what makes that population the wider one.
--
-- min(version) over an empty set returns 1970-01-01 rather than NULL, so ledger_start falls back to
-- now64(3) for a repo with no ledger rows, collapsing the window to empty. The clamp has to fail
-- closed: repo is caller-supplied, and an open clamp scans all of history. window_end clamps to
-- now64(3) because the page snaps stopTime up to the next bucket, always landing in the future.
--
-- Both clocks anchor on push-receipt time -- the moment GitHub took delivery of the SHA -- and
-- never on the commit's authored timestamp. An authored timestamp is written by the contributor's
-- own machine, so it counts however long a commit sat unpushed, and ingestion records it with the
-- UTC offset discarded: 4% of this repo's pushes carry an authored timestamp that postdates the
-- push delivering it, by a full 8 hours for a +08:00 author.
--
-- No one table carries that receipt for every head SHA, so pushes takes the earliest of two
-- GitHub-side clocks. repository.pushed_at is the receipt itself, but default.push only holds a
-- SHA pushed to a ref in this repo -- a fork PR's head reaches it via a later ciflow tag, or not
-- at all. workflow_run.created_at reaches those, and trails the receipt by however long Actions
-- takes to create the run: seconds usually, 21 minutes when the queue is backed up. Both err late
-- and only late, so the earlier of the two is the closer bound on the receipt.
--
-- The default.push branch resolves each SHA to its authored timestamp through push_by_sha solely
-- to prune the primary key, default.push being ORDER BY (head_commit.timestamp, head_commit.id);
-- that timestamp reaches no clock. The other branch reads the two head_sha- and created_at-keyed
-- views instead of default.workflow_run, which is ORDER BY (id, dynamoKey) and carries no index
-- on head_sha. Its head_sha -> id rename stays in the outermost SELECT: ClickHouse resolves a
-- WHERE-clause identifier to a same-SELECT alias ahead of the table's own column, so writing that
-- rename alongside a predicate on workflow_run's id empties the branch and returns no error.
--
-- A SHA pushed before GreenLight's ledger began belonged to an already-open PR the gate first saw
-- at rollout. The interval it anchors is that backlog -- how old the PR was when the gate arrived
-- -- and not latency GreenLight caused, so those observations are excluded rather than allowed to
-- dominate the upper tail.
--
-- join_use_nulls = 0 on this cluster, so a LEFT JOIN miss yields 1970-01-01 rather than NULL and an
-- unguarded subtraction produces a ~56.7-year duration. The two sources together still do not cover
-- every GreenLight head SHA, so every observation is gated on a real timestamp and the misses are
-- counted out instead of being silently absorbed. e2e_secs and dispatch_secs are computed for every
-- row, including those misses; the _ok flags are what keep the garbage out of the aggregates.
--
-- n_e2e_unanchored and n_dispatch_unanchored are each clock's own count of head SHAs that fell in
-- the window and went unmeasured, whatever the reason. They are what the page reports beside n, so
-- a reader can tell a clock measuring most of its population from one measuring half. The three
-- excluded_ counters below instead partition those drops by cause and never double-count one:
-- excluded_no_push_ts is a missing anchor, excluded_push_after_event is an anchor postdating the
-- event it anchors -- with a receipt-time anchor that is a data fault rather than a category --
-- and excluded_pre_ledger is rollout backlog. They span both clocks at once, since a head SHA can
-- enter the window on either, which is why neither tile can be sourced from them.
--
-- Neither source is keyed one row per SHA: default.push holds a row per push event carrying the
-- SHA as head_commit, and a workflow run exists per workflow. Aggregating to one row per id before
-- the join is what keeps a single commit from contributing its latency to the quantiles more than
-- once.
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
toFloat64(1800) AS e2e_cutoff_s,
toFloat64(480) AS dispatch_cutoff_s,
toFloat64(900) AS review_visible_after_s,
toFloat64(1980) AS review_runtime_cutoff_s,

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
        minIf(version, status = 'AI_REVIEW_STARTED') AS started_at,
        minIf(version, status IN ('LAND', 'NO_LAND')) AS verdict_at,
        minIf(version, status IN ('CANCELLED', 'FAILED')) AS aborted_at,
        minIf(version, status = 'FAILED') AS failed_at
    FROM misc.greenlight_pr_state
    WHERE repo = {repo: String}
    GROUP BY pr_number, head_sha, eval_hash
),

pushes AS (
    SELECT
        id,
        min(pushed_at) AS pushed_at
    FROM (
        SELECT
            tupleElement(head_commit, 'id') AS id,
            toDateTime64(
                min(tupleElement(repository, 'pushed_at')), 3
            ) AS pushed_at
        FROM default.push
        WHERE
            tupleElement(head_commit, 'timestamp') IN (
                SELECT timestamp
                FROM materialized_views.push_by_sha
                WHERE
                    id IN (
                        SELECT DISTINCT head_sha
                        FROM misc.greenlight_pr_state
                        WHERE repo = {repo: String}
                    )
            )
            AND tupleElement(head_commit, 'id') IN (
                SELECT DISTINCT head_sha
                FROM misc.greenlight_pr_state
                WHERE repo = {repo: String}
            )
        GROUP BY id

        UNION ALL

        SELECT
            h.head_sha AS id,
            toDateTime64(min(c.created_at), 3) AS pushed_at
        FROM materialized_views.workflow_run_by_created_at AS c
        INNER JOIN (
            SELECT
                id,
                head_sha
            FROM materialized_views.workflow_run_by_head_sha
            WHERE
                head_sha IN (
                    SELECT DISTINCT head_sha
                    FROM misc.greenlight_pr_state
                    WHERE repo = {repo: String}
                )
        ) AS h ON h.id = c.id
        GROUP BY h.head_sha
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
        countIf(verdict_in_window AND NOT e2e_ok) AS n_e2e_unanchored,
        countIf(
            dispatch_in_window AND NOT dispatch_ok
        ) AS n_dispatch_unanchored,
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
        countIf(review_ok) AS n_review,
        countIf(
            review_ok AND review_secs > review_visible_after_s
        ) AS n_review_over_threshold,
        countIf(run_in_window) AS n_review_runs,
        countIf(run_in_window AND run_failed) AS n_review_runs_failed,
        countIf(run_timed) AS n_review_runs_timed,
        countIf(
            run_timed AND run_secs > review_runtime_cutoff_s
        ) AS n_review_runs_over_runtime
    FROM (
        SELECT
            (
                verdict_at >= window_start
                AND verdict_at < window_end
                AND dispatch_at > epoch
                AND verdict_at >= dispatch_at
            ) AS review_ok,
            (verdict_at > epoch) AS has_verdict,
            (NOT has_verdict AND failed_at > epoch) AS run_failed,
            if(has_verdict, verdict_at, aborted_at) AS terminal_at,
            if(started_at > epoch, started_at, dispatch_at) AS run_start_at,
            (
                terminal_at > epoch
                AND terminal_at >= window_start
                AND terminal_at < window_end
            ) AS run_in_window,
            (
                run_in_window
                AND run_start_at > epoch
                AND terminal_at >= run_start_at
            ) AS run_timed,
            dateDiff('millisecond', dispatch_at, verdict_at)
            / 1000.0 AS review_secs,
            dateDiff('millisecond', run_start_at, terminal_at)
            / 1000.0 AS run_secs
        FROM cycles
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
    r.n_review_runs AS n_review_runs,
    r.n_review_runs_failed AS n_review_runs_failed,
    r.n_review_runs_timed AS n_review_runs_timed,
    r.n_review_runs_over_runtime AS n_review_runs_over_runtime,
    review_runtime_cutoff_s,
    p.n_dispatch AS n_dispatch,
    p.dispatch_p50_s AS dispatch_p50_s,
    p.n_dispatch_within_cutoff AS n_dispatch_within_cutoff,
    dispatch_cutoff_s,
    p.n_e2e_unanchored AS n_e2e_unanchored,
    p.n_dispatch_unanchored AS n_dispatch_unanchored,
    p.excluded_no_push_ts AS excluded_no_push_ts,
    p.excluded_push_after_event AS excluded_push_after_event,
    p.excluded_pre_ledger AS excluded_pre_ledger
FROM push_clocks AS p
CROSS JOIN review_clock AS r
