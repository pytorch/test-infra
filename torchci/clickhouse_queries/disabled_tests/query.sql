-- This query returns the list of DISABLED tests together with their labels.  This powers
-- the disabled tests dashboard, contributing them to their owners.
with tests as (
    select
        argMax(t.name, timestamp) as name,
        argMax(t.issueNumber, timestamp) as issueNumber,
        argMax(t.platforms, timestamp) as platforms
    from
        misc.disabled_tests_historical t
    group by
        t.name
)
select
    i.number,
    t.name,
    i.assignee. 'login' AS assignee,
    i.html_url,
    i.updated_at,
    arrayMap(x -> x. 'name', i.labels) as labels,
    i.body
from
    default .issues i final
    join tests t on i.number = t.issueNumber
where
    (
        i.state = {state: String }
        OR {state: String } = ''
    )
    and (
        {platform: String } = ''
        OR arrayExists(
            x -> x like CONCAT('%', {platform: String }, '%'),
            t.platforms
        )
    )
    and (
        {label: String } = ''
        OR arrayExists(l -> l. 'name' = {label: String }, i.labels)
    )
    AND (
        {triaged: String } = ''
        OR (
            {triaged: String } = 'yes'
            AND arrayExists(l -> l. 'name' = 'triaged', i.labels)
        )
        OR (
            {triaged: String } = 'no'
            AND NOT arrayExists(l -> l. 'name' = 'triaged', i.labels)
        )
    )
    and i.html_url like '%pytorch/pytorch%'
ORDER BY
    i.updated_at DESC
