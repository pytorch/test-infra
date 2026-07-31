-- All add/remove events of the global autorevert killswitch label
-- (`ci: disable-autorevert`) on pytorch/pytorch issues, plus each
-- issue's `closed_at` (empty if still open). The caller folds the
-- event stream per-issue into [on_ts, off_ts] active intervals,
-- treating a `closed_at` as an implicit `unlabeled` (the autorevert
-- lambda only honors the label on OPEN issues). Events outside the
-- metrics window are needed to resolve intervals that span it.
WITH issue_close AS (
    SELECT
        number AS issue_number,
        argMax(closed_at, updated_at) AS closed_at_str
    FROM default.issues
    WHERE
        repository_url = 'https://api.github.com/repos/pytorch/pytorch'
    GROUP BY number
)

SELECT
    e.event_time AS event_time,
    e.action AS action,
    e.issue_number AS issue_number,
    coalesce(c.closed_at_str, '') AS issue_closed_at
FROM default.issues_label_event AS e
LEFT JOIN issue_close AS c ON c.issue_number = e.issue_number
WHERE
    e.repo_name = 'pytorch/pytorch'
    AND e.label_name = 'ci: disable-autorevert'
    AND e.event_time <= {stopTime: DateTime64(3)} + INTERVAL 1 DAY
ORDER BY e.issue_number, e.event_time
