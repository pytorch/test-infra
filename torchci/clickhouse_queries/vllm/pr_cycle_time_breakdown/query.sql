-- vLLM PR cycle time breakdown
-- Computes P50 and P90 (hours) for:
-- 1) Time to first (human) review: PR ready -> first human review
-- 2) Time to approval: first human review -> first approval
-- 3) Time in merge queue: first approval -> merge time
-- Notes:
-- - "Ready" is derived from the first time the 'ready' label was applied.
-- - Reviews excluded if state = 'DISMISSED' and if reviewer looks like a bot.
-- - Human review is approximated via author_association in an allowed set and reviewer != PR author.
-- - Metrics only consider merged PRs within the window [startTime, stopTime).

WITH prs AS (
    SELECT
        number AS pr_number,
        user.login AS author,
        parseDateTimeBestEffort(created_at) AS created_at_ts,
        parseDateTimeBestEffort(closed_at) AS merged_at_ts
    FROM default.pull_request
    WHERE
        dynamoKey LIKE concat({repo: String }, '%')
        AND state = 'closed'
        AND closed_at != ''
        AND parseDateTimeBestEffort(closed_at) >= {startTime: DateTime64(3) }
        AND parseDateTimeBestEffort(closed_at) < {stopTime: DateTime64(3) }
),

ready_events AS (
    SELECT
        ple.pr_number,
        minIf(
            ple.event_time,
            lowerUTF8(ple.label_name) = 'ready' AND ple.action = 'labeled'
        ) AS first_ready_ts
    FROM default.pull_label_event ple
    WHERE
        ple.repo_name = {repo: String }
    GROUP BY ple.pr_number
),

reviews_raw AS (
    SELECT
        toUInt32(
            extractGroups(review.'pull_request_url', 'pulls/([0-9]+)')[1]
        ) AS pr_number,
        review.'user'.'login' AS reviewer,
        review.'state' AS state,
        review.'author_association' AS author_association,
        review.'submitted_at' AS submitted_at_ts
    FROM default.pull_request_review
    WHERE
        dynamoKey LIKE concat({repo: String }, '%')
        AND review.'submitted_at' IS NOT NULL
),

-- Filter to human reviews and exclude dismissed ones and bot reviewers
human_reviews AS (
    SELECT
        r.pr_number,
        r.reviewer,
        r.state,
        r.author_association,
        r.submitted_at_ts
    FROM reviews_raw r
    WHERE
        lowerUTF8(r.state) != 'dismissed'
        AND r.author_association IN (
            'MEMBER', 'OWNER', 'COLLABORATOR', 'CONTRIBUTOR'
        )
        AND r.reviewer NOT LIKE '%[bot]'
        AND lowerUTF8(r.reviewer) NOT LIKE '%bot%'
),

first_human_review AS (
    SELECT
        pr.pr_number,
        -- Define "first review" as first non-approved human review (commented/changes_requested)
        minIf(
            hr.submitted_at_ts,
            hr.reviewer != pr.author
            AND lowerUTF8(hr.state) IN ('commented', 'changes_requested')
        ) AS first_review_ts
    FROM prs pr
    LEFT JOIN human_reviews hr ON pr.pr_number = hr.pr_number
    GROUP BY pr.pr_number
),

first_approval AS (
    SELECT
        pr.pr_number,
        -- Only count approvals from maintainers (exclude contributor approvals)
        minIf(
            hr.submitted_at_ts,
            lowerUTF8(hr.state) = 'approved'
            AND hr.reviewer != pr.author
            AND hr.author_association IN ('MEMBER', 'OWNER', 'COLLABORATOR')
        ) AS first_approval_ts
    FROM prs pr
    LEFT JOIN human_reviews hr ON pr.pr_number = hr.pr_number
    GROUP BY pr.pr_number
),

durations AS (
    SELECT
        pr.pr_number,
        coalesce(re.first_ready_ts, pr.created_at_ts) AS ready_ts,
        fr.first_review_ts,
        fa.first_approval_ts,
        pr.merged_at_ts,
        -- Durations in hours
        if(
            fr.first_review_ts IS NULL
            OR fr.first_review_ts
            < coalesce(re.first_ready_ts, pr.created_at_ts),
            NULL,
            dateDiff(
                'second',
                coalesce(re.first_ready_ts, pr.created_at_ts),
                fr.first_review_ts
            )
            / 3600.0
        ) AS time_to_first_review_hours,

        if(
            fa.first_approval_ts IS NULL
            OR fr.first_review_ts IS NULL
            OR fa.first_approval_ts < fr.first_review_ts,
            NULL,
            dateDiff('second', fr.first_review_ts, fa.first_approval_ts)
            / 3600.0
        ) AS time_to_approval_hours,

        if(
            fa.first_approval_ts IS NULL
            OR pr.merged_at_ts < fa.first_approval_ts,
            NULL,
            dateDiff('second', fa.first_approval_ts, pr.merged_at_ts) / 3600.0
        ) AS time_in_merge_queue_hours
    FROM prs pr
    LEFT JOIN ready_events re ON pr.pr_number = re.pr_number
    LEFT JOIN first_human_review fr ON pr.pr_number = fr.pr_number
    LEFT JOIN first_approval fa ON pr.pr_number = fa.pr_number
),

filtered AS (
    SELECT *
    FROM durations
    WHERE
        (
            time_to_first_review_hours IS NULL
            OR (
                time_to_first_review_hours >= 0
                AND time_to_first_review_hours < 24 * 30
            )
        )
        AND (
            time_to_approval_hours IS NULL
            OR (
                time_to_approval_hours >= 0 AND time_to_approval_hours < 24 * 30
            )
        )
        AND (
            time_in_merge_queue_hours IS NULL
            OR (
                time_in_merge_queue_hours >= 0
                AND time_in_merge_queue_hours < 24 * 30
            )
        )
)

SELECT
    round(quantile(0.5) (time_to_first_review_hours), 2)
        AS time_to_first_review_p50,
    round(quantile(0.9) (time_to_first_review_hours), 2)
        AS time_to_first_review_p90,
    round(quantile(0.5) (time_to_approval_hours), 2) AS time_to_approval_p50,
    round(quantile(0.9) (time_to_approval_hours), 2) AS time_to_approval_p90,
    round(quantile(0.5) (time_in_merge_queue_hours), 2)
        AS time_in_merge_queue_p50,
    round(quantile(0.9) (time_in_merge_queue_hours), 2)
        AS time_in_merge_queue_p90
FROM filtered
-- Quantiles ignore NULLs implicitly; if a column is entirely NULL in window, result will be NULL
