-- Two rows per `module: *` / `oncall: *` label: the label's module-level
-- triage queue and how fast its issues were fully triaged, for pytorch/pytorch
-- issues created on or after {startDate}. An issue is fully triaged once it is
-- closed or has one of the state labels below; full_at is the earlier of the
-- two. Powers the table on /triage/modules.
--
-- Labels nest (label_parents in pytorch/pytorch's OWNERSHIP.yaml), passed as
-- the (descendant, ancestor) pairs of the hierarchy's transitive closure:
--   include_children = 1: issues with the label or any of its descendants. An
--     issue's ancestors are worked out here, since older issues may only carry
--     the child label;
--   include_children = 0: issues with the label and none of its descendants.
-- For a label without children both rows are the same.
WITH
    ['needs reproduction', 'needs research', 'needs design', 'actionable', 'won''t fix'] AS state_labels,
    toDateTime('2100-01-01 00:00:00') AS never,
    {descendants: Array(String)} AS closure_descendants,
    {ancestors: Array(String)} AS closure_ancestors
SELECT
    label_mode.1 AS label,
    label_mode.2 AS include_children,
    countIf(in_queue) AS queue_size,
    countIf(in_queue AND created < now() - INTERVAL 7 DAY) AS overdue,
    max(if(in_queue, dateDiff('day', created, now()), 0)) AS oldest_days,
    countIf(in_queue AND has(names, 'high priority')) AS high_pri_in_queue,
    count() AS issues_created,
    countIf(created < now() - INTERVAL 7 DAY) AS sla_eligible,
    countIf(
        created < now() - INTERVAL 7 DAY AND full_at <= created + INTERVAL 7 DAY
    ) AS met_sla,
    quantileExactIf(0.5)(
        dateDiff('hour', created, full_at), full_at < never
    ) / 24 AS median_days_to_triage,
    countIf(has(names, 'actionable')) AS actionable,
    countIf(has(names, 'needs reproduction')) AS needs_reproduction,
    countIf(has(names, 'needs research')) AS needs_research,
    countIf(has(names, 'needs design')) AS needs_design,
    countIf(has(names, 'won''t fix')) AS wont_fix,
    countIf(NOT is_open AND NOT has_state) AS closed
FROM (
    SELECT
        i.names AS names,
        arrayFilter(
            l -> startsWith(l, 'module: ') OR startsWith(l, 'oncall: '), i.names
        ) AS tracked,
        parseDateTimeBestEffort(i.created_at) AS created,
        i.state = 'open' AS is_open,
        hasAny(i.names, state_labels) AS has_state,
        is_open AND NOT has_state AS in_queue,
        least(
            if(is_open, never, parseDateTimeBestEffort(i.closed_at)),
            if(e.first_state_at = 0, never, e.first_state_at)
        ) AS full_at
    FROM (
        SELECT number, created_at, closed_at, state, labels.name AS names
        FROM default.issues FINAL
        WHERE
            repository_url = 'https://api.github.com/repos/pytorch/pytorch'
            AND pull_request.url = ''
            AND created_at >= {startDate: String}
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
ARRAY JOIN
    arrayConcat(
        -- With children: the issue's labels and all their ancestors.
        arrayMap(
            l -> (l, 1),
            arrayDistinct(
                arrayConcat(
                    tracked,
                    arrayFilter(
                        (a, d) -> has(tracked, d),
                        closure_ancestors,
                        closure_descendants
                    )
                )
            )
        ),
        -- Parent only: the issue's labels with none of their descendants on it.
        arrayMap(
            l -> (l, 0),
            arrayFilter(
                l -> NOT arrayExists(
                    (d, a) -> a = l AND has(tracked, d),
                    closure_descendants,
                    closure_ancestors
                ),
                tracked
            )
        )
    ) AS label_mode
GROUP BY label, include_children
ORDER BY overdue DESC, queue_size DESC, label, include_children DESC
