-- Summary tiles and outcome breakdown for /triage/modules: distinct
-- pytorch/pytorch issues created on or after {startDate} in the selection.
-- The selection: issues with any of {includeLabels} (the chosen labels and
-- all their descendants), or with one of {ownLabels} and none of the matching
-- {ownExcludes} (a parent label counted without its children). Both empty
-- selects every issue.
-- See issue_triage_labels for the definition of fully triaged.
WITH
[
    'needs reproduction',
    'needs research',
    'needs design',
    'actionable',
    'won''t fix'
] AS state_labels,
toDateTime('2100-01-01 00:00:00') AS never
SELECT
    count() AS issues_created,
    countIf(created < now() - INTERVAL 7 DAY) AS sla_eligible,
    countIf(
        created < now() - INTERVAL 7 DAY AND full_at <= created + INTERVAL 7 DAY
    ) AS met_sla,
    -- medianExactIf returns 0, not NULL, when no issue is triaged yet.
    if(
        countIf(full_at < never) = 0,
        NULL,
        medianExactIf(dateDiff('hour', created, full_at), full_at < never) / 24
    ) AS median_days_to_triage,
    countIf(in_queue AND has_tracked) AS queue_size,
    countIf(
        in_queue AND has_tracked AND created < now() - INTERVAL 7 DAY
    ) AS overdue,
    countIf(in_queue AND NOT has_tracked) AS no_queue,
    countIf(in_queue AND has(names, 'triage review')) AS triage_review,
    countIf(outcome = 'actionable') AS actionable,
    countIf(outcome = 'needs reproduction') AS needs_reproduction,
    countIf(outcome = 'needs research') AS needs_research,
    countIf(outcome = 'needs design') AS needs_design,
    countIf(outcome = 'won''t fix') AS wont_fix,
    countIf(NOT is_open AND outcome = '') AS closed
FROM (
    SELECT
        i.names AS names,
        parseDateTimeBestEffort(i.created_at) AS created,
        i.state = 'open' AS is_open,
        hasAny(i.names, state_labels) AS has_state,
        -- The most decided state label, so an issue with several counts once.
        arrayFirst(s -> has(i.names, s), arrayReverse(state_labels)) AS outcome,
        is_open AND NOT has_state AS in_queue,
        arrayExists(
            l -> startsWith(l, 'module: ') OR startsWith(l, 'oncall: '), i.names
        ) AS has_tracked,
        least(
            if(is_open, never, parseDateTimeBestEffort(i.closed_at)),
            if(e.first_state_at = 0, never, e.first_state_at)
        ) AS full_at
    FROM (
        SELECT
            number,
            created_at,
            closed_at,
            state,
            labels.name AS names
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
        SELECT
            issue_number,
            min(event_time) AS first_state_at
        FROM default.issues_label_event
        WHERE
            repo_name = 'pytorch/pytorch'
            AND action = 'labeled'
            AND has(state_labels, label_name)
        GROUP BY issue_number
    ) AS e ON e.issue_number = i.number
)
