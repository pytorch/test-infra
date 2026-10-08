-- Newest finished automated PR review per (PR, head sha), for the Dr.CI ready
-- for review promotion.
--
-- Unlike pr_review_verdicts_for_prs, a newer run that has only written its
-- `started` row does not hide a finished one, and rows are kept per head sha so
-- the caller can pick the head it evaluated. started_at_ms is when the run's
-- `started` row was written; without one, the terminal row's timestamp minus
-- the run's duration.
SELECT
    t.pr_number AS pr_number,
    t.head_sha AS head_sha,
    t.status AS status,
    t.verdict AS verdict,
    toUnixTimestamp64Milli(
        if(
            s.has_started = 1,
            s.started_at,
            t.timestamp - toIntervalMillisecond(t.duration_ms)
        )
    ) AS started_at_ms
FROM (
    SELECT
        pr_number,
        head_sha,
        review_run_id,
        review_run_attempt,
        status,
        verdict,
        timestamp,
        duration_ms
    FROM misc.pr_review_verdicts
    WHERE
        repo = {repo: String}
        AND pr_number IN {prNumbers: Array(Int64)}
        AND phase = 'terminal'
    ORDER BY
        pr_number,
        head_sha,
        review_run_id DESC,
        review_run_attempt DESC,
        timestamp DESC
    LIMIT 1 BY pr_number, head_sha
) AS t
LEFT JOIN (
    SELECT
        pr_number,
        head_sha,
        review_run_id,
        review_run_attempt,
        min(timestamp) AS started_at,
        1 AS has_started
    FROM misc.pr_review_verdicts
    WHERE
        repo = {repo: String}
        AND pr_number IN {prNumbers: Array(Int64)}
        AND phase = 'started'
    GROUP BY pr_number, head_sha, review_run_id, review_run_attempt
) AS s
    ON t.pr_number = s.pr_number
    AND t.head_sha = s.head_sha
    AND t.review_run_id = s.review_run_id
    AND t.review_run_attempt = s.review_run_attempt
