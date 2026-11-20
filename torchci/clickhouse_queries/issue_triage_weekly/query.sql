-- Per creation week (Monday), how the pytorch/pytorch issues created that week
-- stand against the 7-day triage SLA. Every issue is in exactly one column:
--   in_sla: fully triaged within 7 days of creation;
--   out_of_sla_triaged: reached 7 days untriaged, fully triaged since;
--   out_of_sla_untriaged: reached 7 days untriaged, still not fully triaged;
--   in_window: younger than 7 days and not fully triaged yet.
-- Restricted to the selection.
-- The selection: issues with any of {includeLabels} (the chosen labels and
-- all their descendants), or with one of {ownLabels} and none of the matching
-- {ownExcludes} (a parent label counted without its children). Both empty
-- selects every issue.
-- Starts no earlier than 2025-04-03, when label-event history begins. Only the
-- last close of an issue is recorded, so an issue closed in time and reopened
-- is counted out of SLA.
-- See issue_triage_labels for the definition of fully triaged.
WITH
    ['needs reproduction', 'needs research', 'needs design', 'actionable', 'won''t fix'] AS state_labels,
    toDateTime('2100-01-01 00:00:00') AS never
SELECT
    toStartOfWeek(created, 1) AS week,
    count() AS issues_created,
    countIf(full_at <= created + INTERVAL 7 DAY) AS in_sla,
    countIf(
        full_at > created + INTERVAL 7 DAY AND full_at < never
    ) AS out_of_sla_triaged,
    countIf(
        full_at = never AND created < now() - INTERVAL 7 DAY
    ) AS out_of_sla_untriaged,
    countIf(
        full_at = never AND created >= now() - INTERVAL 7 DAY
    ) AS in_window
FROM (
    SELECT
        parseDateTimeBestEffort(i.created_at) AS created,
        least(
            if(i.state = 'open', never, parseDateTimeBestEffort(i.closed_at)),
            if(e.first_state_at = 0, never, e.first_state_at)
        ) AS full_at
    FROM (
        SELECT number, created_at, closed_at, state
        FROM default.issues FINAL
        WHERE
            repository_url = 'https://api.github.com/repos/pytorch/pytorch'
            AND pull_request.url = ''
            AND created_at >= greatest({startDate: String}, '2025-04-03')
            AND (
                (
                    empty({includeLabels: Array(String)})
                    AND empty({ownLabels: Array(String)})
                )
                OR hasAny(labels.name, {includeLabels: Array(String)})
                OR arrayExists(
                    (own, excluded) -> has(labels.name, own)
                    AND NOT hasAny(labels.name, excluded),
                    {ownLabels: Array(String)},
                    {ownExcludes: Array(Array(String))}
                )
            )
    ) AS i
    LEFT JOIN (
        SELECT issue_number, min(event_time) AS first_state_at
        FROM default.issues_label_event
        WHERE
            repo_name = 'pytorch/pytorch'
            AND action = 'labeled'
            AND label_name IN state_labels
        GROUP BY issue_number
    ) AS e ON e.issue_number = i.number
)
GROUP BY week
ORDER BY week
