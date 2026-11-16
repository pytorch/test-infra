-- Latest automated PR review row per PR, batched across one Dr.CI sweep.
--
-- Each review attempt writes a `started` row and later a terminal one. The newest
-- workflow run wins, so a superseded run whose terminal row lands late cannot
-- replace the newer run's result; within one run the terminal row wins over
-- `started`.
SELECT
    pr_number,
    head_sha,
    status,
    verdict,
    summary,
    findings_count,
    extra['findings'] AS findings_json,
    review_run_id,
    trigger_run_id,
    -- Distinguishes a new capture attempt from an older review of the same
    -- request, even when the older terminal row arrives after the new capture.
    -- As in pr_review_head_verdicts_for_prs, a terminal-only attempt starts
    -- at its timestamp minus duration_ms, not at its completion time.
    if(
        countIf(phase = 'started') OVER attempt > 0,
        minIf(toUnixTimestamp64Milli(timestamp), phase = 'started') OVER attempt,
        min(toUnixTimestamp64Milli(timestamp) - duration_ms) OVER attempt
    ) AS started_at_ms,
    timestamp
FROM misc.pr_review_verdicts
WHERE
    repo = {repo: String}
    AND pr_number IN {prNumbers: Array(Int64)}
WINDOW attempt AS (PARTITION BY pr_number, review_run_id, review_run_attempt)
ORDER BY
    pr_number,
    review_run_id DESC,
    review_run_attempt DESC,
    phase = 'terminal' DESC,
    timestamp DESC
LIMIT 1 BY pr_number
