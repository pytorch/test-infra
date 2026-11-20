-- Issues for the /triage/modules drill-down of a selection of labels: every
-- issue in the selection still in the queue, plus those fully triaged in the
-- last 30 days, for pytorch/pytorch issues created on or after {startDate}.
-- Each issue appears once, whatever number of the labels it has.
-- The selection: issues with any of {includeLabels} (the chosen labels and
-- all their descendants), or with one of {ownLabels} and none of the matching
-- {ownExcludes} (a parent label counted without its children). Both empty
-- selects every issue.
-- See issue_triage_labels for the definition of fully triaged.
WITH
    ['needs reproduction', 'needs research', 'needs design', 'actionable', 'won''t fix'] AS state_labels,
    toDateTime('2100-01-01 00:00:00') AS never
SELECT
    number,
    title,
    html_url,
    created,
    dateDiff('day', created, now()) AS age_days,
    in_queue,
    in_queue AND created < now() - INTERVAL 7 DAY AS overdue,
    reopened,
    has(names, 'high priority') AS high_priority,
    arrayFilter(
        l -> startsWith(l, 'module: ') OR startsWith(l, 'oncall: '), names
    ) AS tracked_labels,
    assignees,
    if(
        in_queue,
        '',
        if(has_state, arrayFirst(l -> has(state_labels, l), names), 'closed')
    ) AS outcome,
    if(full_at < never, full_at, NULL) AS triaged_at,
    if(
        full_at < never, dateDiff('hour', created, full_at) / 24, NULL
    ) AS days_to_triage
FROM (
    SELECT
        i.number AS number,
        i.title AS title,
        i.html_url AS html_url,
        i.names AS names,
        i.assignees AS assignees,
        parseDateTimeBestEffort(i.created_at) AS created,
        i.state = 'open' AS is_open,
        is_open AND i.state_reason = 'reopened' AS reopened,
        hasAny(i.names, state_labels) AS has_state,
        is_open AND NOT has_state AS in_queue,
        least(
            if(is_open, never, parseDateTimeBestEffort(i.closed_at)),
            if(e.first_state_at = 0, never, e.first_state_at)
        ) AS full_at
    FROM (
        SELECT
            number,
            title,
            html_url,
            created_at,
            closed_at,
            state,
            state_reason,
            labels.name AS names,
            assignees.login AS assignees
        FROM default.issues FINAL
        WHERE
            repository_url = 'https://api.github.com/repos/pytorch/pytorch'
            AND pull_request.url = ''
            AND created_at >= {startDate: String}
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
WHERE in_queue OR full_at >= now() - INTERVAL 30 DAY
ORDER BY in_queue DESC, if(in_queue, created, full_at) ASC
