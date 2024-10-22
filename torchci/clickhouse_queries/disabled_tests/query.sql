-- This query returns the list of DISABLED tests together with their labels.  This powers
-- the disabled tests dashboard, contributing them to their owners.
WITH issues_with_labels AS (
    SELECT
        i.number,
        i.title,
        i.body,
        groupArrayArray(i.labels. 'name') AS labels,
        i.assignee.login AS assignee,
        i.html_url,
        i.updated_at
    FROM
        default .issues i FINAL
    WHERE
        (
            i.state = {state: String }
            OR {state: String } = ''
        )
        AND i.repository_url = CONCAT('https://api.github.com/repos/', { repo: String })
        AND i.title LIKE '%DISABLED%'
        AND (
            {platform: String } = ''
            OR i.body LIKE CONCAT('%', {platform: String }, '%')
            OR (NOT i.body LIKE '%Platforms: %')
        )
    GROUP BY
        i.number,
        i.title,
        i.body,
        i.assignee.login,
        i.html_url,
        i.updated_at
)
SELECT
    *
FROM
    issues_with_labels
WHERE
    has(issues_with_labels.labels, 'skipped')
    AND (
        {label: String } = ''
        OR has(issues_with_labels.labels, {label: String })
    )
    AND (
        {triaged: String } = ''
        OR (
            {triaged: String } = 'yes'
            AND has(issues_with_labels.labels, 'triaged')
        )
        OR (
            {triaged: String } = 'no'
            AND NOT has(issues_with_labels.labels, 'triaged')
        )
    )
ORDER BY
    issues_with_labels.updated_at DESC
