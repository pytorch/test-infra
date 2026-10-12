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
    timestamp
FROM misc.pr_review_verdicts
WHERE
    repo = {repo: String}
    AND pr_number IN {prNumbers: Array(Int64)}
ORDER BY
    pr_number,
    review_run_id DESC,
    review_run_attempt DESC,
    phase = 'terminal' DESC,
    timestamp DESC
LIMIT 1 BY pr_number
