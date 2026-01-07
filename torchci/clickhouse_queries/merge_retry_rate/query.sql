-- Query to calculate average merge retry rate for recent period
-- Merge retry rate = average number of merge attempts before first successful merge
-- Only counts attempts up to when the PR was closed/merged (proxy for dev friction)
-- Filters by PR creation date
-- Excludes pytorchupdatebot PRs to avoid skewing metrics with stuck bot updates
WITH
merged_prs AS (
    SELECT
        number AS pr_number,
        parseDateTimeBestEffort(closed_at) AS merge_time,
        parseDateTimeBestEffort(created_at) AS created_time,
        user.login AS author
    FROM default.pull_request
    WHERE
        -- Use trailing slash to avoid matching pytorch/pytorch-integration-testing
        dynamoKey LIKE 'pytorch/pytorch/%'
        AND state = 'closed'
        AND arrayExists(x -> x.'name' = 'Merged', labels)
        AND closed_at != ''
        -- Filter by PR creation date
        AND parseDateTimeBestEffort(created_at) >= {startTime: DateTime64(3)}
        AND parseDateTimeBestEffort(created_at) <= {stopTime: DateTime64(3)}
        -- Exclude pytorchupdatebot PRs (often stuck with many attempts)
        AND user.login != 'pytorchupdatebot'
),

all_merge_attempts AS (
    SELECT
        toUInt32(extractGroups(issue_url, 'issues/([0-9]+)')[1]) AS pr_number,
        created_at
    FROM default.issue_comment
    WHERE
        -- Use trailing slash to avoid matching pytorch/pytorch-integration-testing
        dynamoKey LIKE 'pytorch/pytorch/%'
        AND user.login = 'pytorchmergebot'
        AND body LIKE '%Merge started%'
),

attempts_per_pr AS (
    SELECT
        mp.pr_number,
        COUNT(*) AS attempt_count
    FROM merged_prs mp
    CROSS JOIN all_merge_attempts ama
    WHERE
        ama.pr_number = mp.pr_number
        AND ama.created_at <= mp.merge_time
    GROUP BY mp.pr_number
)

SELECT ROUND(AVG(attempt_count), 2) AS avg_retry_rate
FROM attempts_per_pr
