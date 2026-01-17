-- Autorevert Events with Linked Revert Commits
-- Links autorevert_events_v2 to the actual revert commits via PR number and timestamp
-- Used for false positive detection

WITH autorevert_events AS (
    SELECT
        toString(a.commit_sha) AS reverted_sha,
        a.ts AS autorevert_time,
        a.workflows,
        a.source_signal_keys
    FROM misc.autorevert_events_v2 a FINAL
    WHERE
        a.repo = 'pytorch/pytorch'
        AND a.action = 'revert'
        AND a.dry_run = 0
        AND a.failed = 0
        AND a.ts >= toDateTime({startTime: DateTime64(3)}) - INTERVAL 1 DAY
        AND a.ts < toDateTime({stopTime: DateTime64(3)}) + INTERVAL 1 DAY
        -- Filter by workflow intersection
        AND hasAny(a.workflows, {workflowNames: Array(String)})
),

-- Get PR number from the reverted commit's message
autorevert_with_pr AS (
    SELECT
        a.reverted_sha,
        a.autorevert_time,
        a.workflows,
        a.source_signal_keys,
        p.head_commit.'message' AS reverted_message,
        -- Extract PR number from "Pull Request resolved: https://github.com/pytorch/pytorch/pull/XXXXX"
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

-- Find revert commits in the time range
revert_commits AS (
    SELECT
        push.head_commit.'id' AS revert_sha,
        push.head_commit.'timestamp' AS revert_time,
        push.head_commit.'message' AS revert_message,
        -- Extract mentioned PR numbers from revert message
        -- For nested reverts like 'Reapply "Back out "..." (#164939)" (#165910)" (#166812)',
        -- the actual PR is the LAST one mentioned in the title line (before newline)
        if(
            arrayElement(
                extractAll(
                    push.head_commit.'message',
                    'Reverted https://github.com/pytorch/pytorch/pull/(\\d+)'
                ), 1
            ) != '',
            arrayElement(
                extractAll(
                    push.head_commit.'message',
                    'Reverted https://github.com/pytorch/pytorch/pull/(\\d+)'
                ), 1
            ),
            -- Get the LAST PR number from title (use -1 for last element)
            arrayElement(
                extractAll(
                    -- Extract just the first line (title) to get the correct PR
                    arrayElement(
                        splitByChar('\n', push.head_commit.'message'), 1
                    ),
                    '#(\\d+)'
                ), -1
            )
        ) AS pr_reference
    FROM push
    WHERE
        push.ref IN ('refs/heads/master', 'refs/heads/main')
        AND push.repository.'full_name' = 'pytorch/pytorch'
        AND push.head_commit.'timestamp' >= {startTime: DateTime64(3)}
        AND push.head_commit.'timestamp' < {stopTime: DateTime64(3)}
        AND (
            push.head_commit.'message' LIKE 'Revert %'
            OR push.head_commit.'message' LIKE 'Reapply %'
            OR push.head_commit.'message' LIKE 'Back out%'
        )
),

-- Join on PR number only, then filter by time in WHERE clause
-- This avoids ClickHouse JOIN ON restrictions
matched_reverts AS (
    SELECT
        a.reverted_sha,
        a.autorevert_time,
        a.workflows,
        a.source_signal_keys,
        a.pr_number,
        substring(a.reverted_message, 1, 100) AS reverted_message_snippet,
        r.revert_sha,
        r.revert_time,
        substring(r.revert_message, 1, 100) AS revert_message_snippet
    FROM autorevert_with_pr a
    LEFT JOIN revert_commits r ON r.pr_reference = a.pr_number
    WHERE
        a.pr_number != ''
        AND (
            -- Keep autoreverts even if no linked revert found
            r.revert_sha IS NULL
            OR (
                r.revert_time > a.autorevert_time
                AND r.revert_time < a.autorevert_time + INTERVAL 1 HOUR
            )
        )
),

-- Take the first revert commit after the autorevert event for each PR
linked_autoreverts AS (
    SELECT
        *,
        row_number() OVER (
            PARTITION BY reverted_sha
            ORDER BY revert_time ASC NULLS LAST
        ) AS rn
    FROM matched_reverts
)

SELECT
    reverted_sha,
    autorevert_time,
    workflows,
    source_signal_keys,
    pr_number,
    reverted_message_snippet,
    revert_sha,
    revert_time,
    revert_message_snippet
FROM linked_autoreverts
WHERE rn = 1
ORDER BY autorevert_time DESC
