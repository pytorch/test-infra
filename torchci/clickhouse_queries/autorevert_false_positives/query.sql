-- Autorevert False Positive Candidates
-- Finds autoreverted commits that were later re-landed
-- NOTE: This is a preliminary list. True false positives require GitHub API verification:
--   - If PR is still OPEN (not relanded) → revert was LEGIT
--   - If PR had commits after revert before reland → revert was LEGIT (author fixed something)
--   - If PR was relanded with NO changes → revert was FALSE POSITIVE

WITH autorevert_events AS (
    SELECT
        toString(a.commit_sha) AS reverted_sha,
        min(a.ts) AS revert_time
    FROM misc.autorevert_events_v2 a FINAL
    WHERE
        a.repo = 'pytorch/pytorch'
        AND a.action = 'revert'
        AND a.dry_run = 0
        AND a.failed = 0
        AND a.ts >= toDateTime({startTime: DateTime64(3)}) - INTERVAL 7 DAY
        AND a.ts < toDateTime({stopTime: DateTime64(3)}) + INTERVAL 7 DAY
    GROUP BY reverted_sha
),

-- Get original commit details and extract PR number
autorevert_with_pr AS (
    SELECT
        a.reverted_sha,
        a.revert_time,
        p.head_commit.'message' AS original_message,
        arrayElement(
            extractAll(
                p.head_commit.'message',
                'Pull Request resolved: https://github.com/pytorch/pytorch/pull/(\\d+)'
            ), 1
        ) AS pr_number
    FROM autorevert_events a
    JOIN push p ON p.head_commit.'id' = a.reverted_sha
    WHERE p.repository.'full_name' = 'pytorch/pytorch'
),

-- Find all commits in the time range
all_commits AS (
    SELECT
        push.head_commit.'id' AS sha,
        push.head_commit.'timestamp' AS time,
        push.head_commit.'message' AS message
    FROM push
    WHERE
        push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.'full_name' = 'pytorch/pytorch'
        AND push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        AND push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
),

-- Find Reland commits
reland_commits AS (
    SELECT
        sha AS reland_sha,
        time AS reland_time,
        message AS reland_message,
        -- Extract the original PR being relanded (first PR number mentioned)
        arrayElement(extractAll(message, '#(\\d+)'), 1) AS primary_mentioned_pr
    FROM all_commits
    WHERE
        message LIKE 'Reland%'
        OR message LIKE '[Reland]%'
        OR message LIKE 'Re-land%'
),

-- Match autoreverts to relands, deduplicated by original PR
-- Take the first reland for each autoreverted PR
matched_relands AS (
    SELECT
        a.reverted_sha,
        a.revert_time,
        a.pr_number AS original_pr,
        substring(a.original_message, 1, 100) AS original_message_snippet,
        r.reland_sha,
        r.reland_time,
        substring(r.reland_message, 1, 100) AS reland_message_snippet,
        dateDiff('hour', a.revert_time, r.reland_time) AS hours_to_reland,
        row_number() OVER (PARTITION BY a.pr_number ORDER BY r.reland_time ASC) AS rn
    FROM autorevert_with_pr a
    JOIN reland_commits r ON r.primary_mentioned_pr = a.pr_number
    WHERE
        a.pr_number != ''
        AND r.reland_time > a.revert_time
        AND r.reland_time < a.revert_time + INTERVAL 30 DAY
)

SELECT
    original_pr,
    reverted_sha,
    revert_time,
    original_message_snippet,
    reland_sha,
    reland_time,
    reland_message_snippet,
    hours_to_reland,
    'needs_verification' AS status
FROM matched_relands
WHERE rn = 1  -- Only first reland per PR
ORDER BY revert_time DESC
