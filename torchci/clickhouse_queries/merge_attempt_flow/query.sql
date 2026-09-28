-- Sankey links for user-initiated pytorch/pytorch merge attempts.
--
-- Cohort: non-updatebot PRs *created* in the selected range that have at least
-- one trymerge record. All their attempts are kept, including paths that never
-- landed. Runs sharing a comment_id collapse into one attempt, preferring a
-- successful outcome.
--
-- The range filters PR creation date, not attempt date, so trailing windows are
-- right-censored: PRs created late in the range may not have attempted a merge
-- yet, and retries still to come have not happened. Short windows therefore
-- skew toward first-attempt successes, and a window's shape keeps shifting
-- until it settles.
--
-- '-f' and '-i' are the raw trymerge fields skip_mandatory_checks and
-- ignore_current, not the HUD force-merge definition in
-- clickhouse_queries/weekly_force_merge_stats, which also requires that
-- something was actually skipped or ignored.
--
-- Links are emitted in a single pass over `cohort`. Five UNION ALL branches
-- each reading `cohort` re-ran the whole pipeline five times, since ClickHouse
-- inlines CTEs rather than materialising them.
WITH created_prs AS (
    SELECT number AS pr_num
    FROM default.pull_request FINAL
    WHERE
        dynamoKey LIKE 'pytorch/pytorch/%'
        AND parseDateTimeBestEffort(created_at) >= {startTime: DateTime64(3)}
        AND parseDateTimeBestEffort(created_at) < {stopTime: DateTime64(3)}
        AND user.login != 'pytorchupdatebot'
),

merge_attempts AS (
    SELECT
        pr_num,
        comment_id,
        max(skip_mandatory_checks) AS used_force,
        max(ignore_current) AS used_ignore_current,
        max(merge_commit_sha != '') AS passed,
        max(is_failed) AS failed
    FROM default.merges FINAL
    WHERE
        owner = 'pytorch'
        AND project = 'pytorch'
        AND dry_run = false
    GROUP BY
        pr_num,
        comment_id
),

-- `merges` carries no timestamp, so attempt order comes from the triggering
-- comment. FINAL is load-bearing here: duplicate comment rows would otherwise
-- inject phantom attempts into the path.
--
-- trymerge normally writes a record only after the attempt is over. Keep an
-- explicit unknown outcome anyway so unexpected or partially ingested records
-- remain visible instead of silently disappearing from the cohort.
merge_events AS (
    SELECT
        m.pr_num,
        m.comment_id,
        c.created_at,
        multiIf(
            m.used_force = 1, '-f',
            m.used_ignore_current = 1, '-i',
            'default'
        ) AS action,
        multiIf(
            m.passed = 1, 'passed',
            m.failed = 1, 'failed',
            'unknown'
        ) AS outcome
    FROM merge_attempts m
    INNER JOIN (
        SELECT
            id,
            created_at
        FROM default.issue_comment FINAL
        WHERE dynamoKey LIKE 'pytorch/pytorch/%'
    ) c ON m.comment_id = c.id
),

pr_paths AS (
    SELECT
        pr_num,
        arraySort(groupArray((created_at, comment_id, action, outcome)))
            AS attempts
    FROM merge_events
    GROUP BY pr_num
),

cohort AS (
    SELECT p.attempts
    FROM pr_paths p
    INNER JOIN created_prs c ON p.pr_num = c.pr_num
),

-- Each PR contributes one link per stage it reaches: entry, the initial
-- command's outcome, then one per retry it took. Paths stop after a successful
-- merge; attempts beyond retry 3 collapse into a single overflow node.
--
-- "No further attempt" is not the same as "gave up": it also covers PRs still
-- in flight and PRs that landed by another route (internal diff import, or as
-- a member of a stack merged from its top PR).
link_rows AS (
    SELECT
        arrayJoin(arrayConcat(
            -- Entry to the first command.
            [(
                'Merging PRs',
                concat('Initial: ', attempts[1] .3),
                toUInt8(0), toUInt8(1)
            )],

            -- Initial command outcome or first retry choice.
            [(
                concat('Initial: ', attempts[1] .3),
                multiIf(
                    attempts[1] .4 = 'passed', 'Landed on initial attempt',
                    attempts[1] .4 = 'failed' AND length(attempts) > 1,
                    concat('Retry 1: ', attempts[2] .3),
                    attempts[1] .4 = 'failed',
                    'No further attempt after initial',
                    'Unknown outcome after initial'
                ),
                toUInt8(1), toUInt8(2)
            )],

            -- First retry outcome or second retry choice.
            if(
                length(attempts) >= 2
                AND attempts[1] .4 = 'failed',
                [(
                    concat('Retry 1: ', attempts[2] .3),
                    multiIf(
                        attempts[2] .4 = 'passed', 'Landed on retry 1',
                        attempts[2] .4 = 'failed' AND length(attempts) > 2,
                        concat('Retry 2: ', attempts[3] .3),
                        attempts[2] .4 = 'failed',
                        'No further attempt after retry 1',
                        'Unknown outcome after retry 1'
                    ),
                    toUInt8(2), toUInt8(3)
                )],
                CAST([], 'Array(Tuple(String, String, UInt8, UInt8))')
            ),

            -- Second retry outcome or third retry choice.
            if(
                length(attempts) >= 3
                AND attempts[1] .4 = 'failed'
                AND attempts[2] .4 = 'failed',
                [(
                    concat('Retry 2: ', attempts[3] .3),
                    multiIf(
                        attempts[3] .4 = 'passed', 'Landed on retry 2',
                        attempts[3] .4 = 'failed' AND length(attempts) > 3,
                        concat('Retry 3: ', attempts[4] .3),
                        attempts[3] .4 = 'failed',
                        'No further attempt after retry 2',
                        'Unknown outcome after retry 2'
                    ),
                    toUInt8(3), toUInt8(4)
                )],
                CAST([], 'Array(Tuple(String, String, UInt8, UInt8))')
            ),

            -- Third retry outcome. Longer paths are grouped into one overflow node.
            if(
                length(attempts) >= 4
                AND attempts[1] .4 = 'failed'
                AND attempts[2] .4 = 'failed'
                AND attempts[3] .4 = 'failed',
                [(
                    concat('Retry 3: ', attempts[4] .3),
                    multiIf(
                        attempts[4] .4 = 'passed', 'Landed on retry 3',
                        attempts[4] .4 = 'failed' AND length(attempts) > 4,
                        'More than 3 retries',
                        attempts[4] .4 = 'failed',
                        'No further attempt after retry 3',
                        'Unknown outcome after retry 3'
                    ),
                    toUInt8(4), toUInt8(5)
                )],
                CAST([], 'Array(Tuple(String, String, UInt8, UInt8))')
            )
        )) AS link
    FROM cohort
)

SELECT
    link .1 AS source,
    link .2 AS target,
    count() AS value,
    link .3 AS source_depth,
    link .4 AS target_depth
FROM link_rows
GROUP BY
    source,
    target,
    source_depth,
    target_depth
ORDER BY
    source_depth,
    source,
    value DESC,
    target
