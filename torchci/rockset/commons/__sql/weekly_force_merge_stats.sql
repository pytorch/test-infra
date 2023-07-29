-- gets percentage of total force merges, force merges with failures, and force merges without failures (impatient)
-- specifically this query tracks the force merges kpi on HUD
WITH
    issue_comments AS(
        SELECT
            issue_comment.user.login,
            issue_comment.author_association,
            issue_comment.body,
            issue_comment.issue_url,
            issue_comment.html_url,
            issue_comment.created_at,
            issue_comment._event_time,
            CAST(
                SUBSTR(
                    issue_comment.issue_url,
                    LENGTH(
                        'https://api.github.com/repos/pytorch/pytorch/issues/'
                    ) + 1
                ) as INT
            ) as pr_num
        FROM
            commons.issue_comment
        WHERE
            (
                issue_comment.body LIKE '%pytorchbot merge%'
                OR issue_comment.body LIKE '%pytorchmergebot merge%'
            ) -- AND _event_time >= PARSE_DATETIME_ISO8601(:startTime)
            -- AND _event_time < PARSE_DATETIME_ISO8601(:stopTime)
            AND issue_comment.user.login NOT LIKE '%pytorch-bot%'
            AND issue_comment.user.login NOT LIKE '%facebook-github-bot%'
            AND issue_comment.user.login NOT LIKE '%pytorchmergebot%'
            AND issue_comment.issue_url LIKE '%https://api.github.com/repos/pytorch/pytorch/issues/%'
    ),
    all_merges AS (
        SELECT
            DISTINCT m.skip_mandatory_checks,
            LENGTH(m.failed_checks) AS failed_checks_count,
            LENGTH(m.ignore_current_checks) as ignored_checks_count,
            m.ignore_current,
            m.is_failed,
            m.pr_num,
            m.merge_commit_sha,
            max(c._event_time) as time,
        FROM
            commons.merges m
            inner join issue_comments c on m.pr_num = c.pr_num
        WHERE
            m.owner = 'pytorch'
            AND m.project = 'pytorch'
            AND m.merge_commit_sha != '' -- only consider successful merges
            AND m._event_time >= PARSE_DATETIME_ISO8601(:startTime)
            AND m._event_time < PARSE_DATETIME_ISO8601(:stopTime) -- AND m.pr_num in 
        GROUP BY
            m.skip_mandatory_checks,
            m.failed_checks,
            m.ignore_current,
            m.is_failed,
            m.pr_num,
            m.merge_commit_sha,
            -- and m.pr_num = 104137
            m.ignore_current_checks
    ),
    force_merges_with_failed_checks AS (
        SELECT
            IF(
                (skip_mandatory_checks = true)
                OR (
                    ignore_current = true
                    AND is_failed = false
                ),
                1,
                0
            ) AS force_merge,
            failed_checks_count,
            pr_num,
            merge_commit_sha,
            ignore_current,
            ignored_checks_count,
            time,
        FROM
            all_merges
    ),
    results as (
        SELECT
            pr_num,
            merge_commit_sha,
            force_merge,
            IF(
                force_merge = 1
                AND (
                    failed_checks_count > 0
                    OR ignored_checks_count > 0
                ),
                1,
                0
            ) AS force_merge_with_failures,
            CAST(time as DATE) as date
        FROM
            force_merges_with_failed_checks
        ORDER BY
            date DESC
    ),
    stats_per_day as (
        select
            count(*) as total,
            sum(force_merge) as total_force_merge_cnt,
            sum(force_merge_with_failures) as with_failures_cnt,
            sum(force_merge) - sum(force_merge_with_failures) as impatience_cnt,
            date,
        from
            results
        GROUP BY
            date
        ORDER BY
            date DESC
    ),
    weekly_counts as (
        select
            FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(: granularity, date)) AS granularity_bucket,
            SUM(with_failures_cnt) with_failures_cnt,
            SUM(impatience_cnt) as impatience_cnt,
            SUM(total) as total,
            SUM(total_force_merge_cnt) as total_force_merge_cnt
        from
            stats_per_day
        group by
            granularity_bucket
    ),
    stats_per_week as (
        SELECT
            granularity_bucket,
            with_failures_cnt * 100 / total as with_failures_percent,
            impatience_cnt * 100 / total as impatience_percent,
            total_force_merge_cnt * 100 / total as force_merge_percent,
        from
            weekly_counts
    ),
    final_table as (
        (
            select
                granularity_bucket,
                with_failures_percent as metric,
                'force merges due to impatience' as name
            from
                stats_per_week
        )
        UNION ALL
        (
            select
                granularity_bucket,
                impatience_percent as metric,
                'force merges due to failed tests' as name
            from
                stats_per_week
        )
        UNION ALL
        (
            select
                granularity_bucket,
                force_merge_percent as metric,
                'all force merges' as name
            from
                stats_per_week
        )
    )
select
    *
from
    final_table
