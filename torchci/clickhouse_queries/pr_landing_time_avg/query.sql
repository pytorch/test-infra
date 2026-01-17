-- Query to calculate average PR landing time for recent period
-- Landing time = time from first "Merge started" comment to when PR was merged
WITH
-- Find the first "Merge started" comment for each PR
merge_started AS (
    SELECT
        toUInt32(extractGroups(issue_url, 'issues/([0-9]+)')[1]) AS pr_number,
        MIN(created_at) AS first_merge_attempt
    FROM default.issue_comment
    WHERE
        -- Use trailing slash to avoid matching pytorch/pytorch-integration-testing
        dynamoKey LIKE 'pytorch/pytorch/%'
        AND user.login = 'pytorchmergebot'
        AND body LIKE '%Merge started%'
        AND created_at >= {startTime: DateTime64(3)}
        AND created_at <= {stopTime: DateTime64(3)}
    GROUP BY pr_number
),

-- Find when PRs were merged (closed with Merged label)
merged_prs AS (
    SELECT
        number AS pr_number,
        parseDateTimeBestEffort(closed_at) AS merge_time
    FROM default.pull_request
    WHERE
        -- Use trailing slash to avoid matching pytorch/pytorch-integration-testing
        dynamoKey LIKE 'pytorch/pytorch/%'
        AND state = 'closed'
        AND arrayExists(x -> x.'name' = 'Merged', labels)
        AND closed_at != ''
        AND parseDateTimeBestEffort(closed_at) >= {startTime: DateTime64(3)}
        AND parseDateTimeBestEffort(closed_at) <= {stopTime: DateTime64(3)}
),

-- Calculate landing time for each PR
pr_landing_times AS (
    SELECT
        ms.pr_number,
        DATE_DIFF('minute', ms.first_merge_attempt, mp.merge_time)
        / 60.0 AS landing_time_hours
    FROM merge_started ms
    INNER JOIN merged_prs mp ON ms.pr_number = mp.pr_number
    WHERE
        -- Ensure merge happened after merge attempt
        mp.merge_time > ms.first_merge_attempt
        AND landing_time_hours < 168  -- Exclude outliers > 1 week
        AND landing_time_hours > 0   -- Exclude negative times
)

-- Return average landing time in hours
SELECT ROUND(AVG(landing_time_hours), 2) AS avg_hours
FROM pr_landing_times
