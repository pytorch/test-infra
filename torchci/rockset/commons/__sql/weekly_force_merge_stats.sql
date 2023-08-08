-- Gets percentage of total force merges, force merges with failures, and force merges without failures (impatient)
-- Specifically this query tracks the force merges kpi and metric on HUD
--
-- Special params:
--   one_bucket: If set to false, bucketizes the results over the requested granularity
--               otherwise there is not bucketing
--   merge_type: If set, will return only data about the requested force merge type.
--               Can be one of: "All", "Impatience", "Failures", or " " (to get everything)

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
            AND m._event_time < PARSE_DATETIME_ISO8601(:stopTime)
        GROUP BY
            m.skip_mandatory_checks,
            m.failed_checks,
            m.ignore_current,
            m.is_failed,
            m.pr_num,
            m.merge_commit_sha,
            m.ignore_current_checks
    ),
    merges_identifying_force_merges AS (
        SELECT
            IF(
                (skip_mandatory_checks = true)
                OR (
                    ignore_current = true
                    AND is_failed = false
                    AND ignored_checks_count > 0 -- if no checks were ignored, it's not a force merge
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
            merges_identifying_force_merges
        ORDER BY
            date DESC
    ),
    bucketed_counts as (
        select
            IF(
                :one_bucket,
                'Overall',
                FORMAT_TIMESTAMP('%Y-%m-%d', DATE_TRUNC(:granularity, date))
            ) AS granularity_bucket,
            SUM(force_merge_with_failures) AS with_failures_cnt,
            SUM(force_merge) - SUM(force_merge_with_failures) as impatience_cnt,
            COUNT(*) as total,
            SUM(force_merge) as total_force_merge_cnt
        from
            results
        group by
            granularity_bucket
    ),
    rolling_raw_stats as (
        -- Average over the past buckets
        SELECT
            granularity_bucket,
            sum(with_failures_cnt) OVER(
                ORDER BY
                    granularity_bucket ROWS 1 PRECEDING
            ) as with_failures_cnt,
            sum(impatience_cnt) OVER(
                ORDER BY
                    granularity_bucket ROWS 1 PRECEDING
            ) as impatience_cnt,
            sum(total_force_merge_cnt) OVER(
                ORDER BY
                    granularity_bucket ROWS 1 PRECEDING
            ) as total_force_merge_cnt,
            sum(total) OVER(
                ORDER BY
                    granularity_bucket ROWS 1 PRECEDING
            ) as total,
        FROM
            bucketed_counts
    ),
    stats_per_bucket as (
        SELECT
            granularity_bucket,
            with_failures_cnt * 100.0 / total as with_failures_percent,
            impatience_cnt * 100.0 / total as impatience_percent,
            total_force_merge_cnt * 100.0 / total as force_merge_percent,
        from
            rolling_raw_stats
    ),
    final_table as (
        (
            select
                granularity_bucket,
                with_failures_percent as metric,
                'From Failures' as name
            from
                stats_per_bucket
        )
        UNION ALL
        (
            select
                granularity_bucket,
                impatience_percent as metric,
                'From Impatience' as name
            from
                stats_per_bucket
        )
        UNION ALL
        (
            select
                granularity_bucket,
                force_merge_percent as metric,
                'All Force Merges' as name
            from
                stats_per_bucket
        )
    ),
    filtered_result as (
        select
            *
        from
            final_table
        WHERE
            TRIM(:merge_type) = ''
            OR name like CONCAT('%', :merge_type, '%')
    )
select
    *
from
    filtered_result
order by
    granularity_bucket desc,
    name
