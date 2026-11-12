"""The ClickHouse queries of main_failures.py (it runs them).

Every query is read-only (`readonly = 2`) and bounded in time and threads; values are
bound as parameters, never interpolated.
"""

from torchci.td.llm.events_sql import TD_SCOPE
from torchci.td.scorer.rows_sql import IS_FILE, JOB_COLUMNS, SETTINGS
from torchci.td.scorer.shards import NO_TD_BUILD_MARKERS


# Role i of a push is role_shas[i + 1]: 0 main before it, 1 its head, 2-4 the next heads.
NEW_FAILURES_SQL = rf"""
WITH
main_pushes AS (
    SELECT
        head_sha, pushed_at, n_commits, pr,
        arrayConcat(
            [before_sha, head_sha],
            groupArray(head_sha) OVER (
                ORDER BY pushed_at, head_sha ROWS BETWEEN 1 FOLLOWING AND 3 FOLLOWING
            )
        ) AS role_shas
    FROM (
        SELECT
            head_commit.id AS head_sha,
            before AS before_sha,
            toDateTime64(repository.pushed_at, 3) AS pushed_at,
            length(commits.id) AS n_commits,
            toInt64OrZero(extract(
                splitByChar('\n', tupleElement(head_commit, 'message'))[1],
                '\\(#(\\d+)\\)\\s*$'
            )) AS pr
        FROM default.push
        PREWHERE push.ref = 'refs/heads/main'
        WHERE push.repository.full_name = 'pytorch/pytorch'
            AND tupleElement(head_commit, 'timestamp')
                >= {{start: DateTime64(3)}} - INTERVAL 1 DAY
            AND tupleElement(head_commit, 'timestamp')
                < {{stop: DateTime64(3)}} + INTERVAL 2 DAY
        LIMIT 1 BY head_sha
    )
),
landings AS (
    SELECT head_sha, pushed_at, n_commits, pr, role_shas
    FROM main_pushes
    WHERE pushed_at >= {{start: DateTime64(3)}} AND pushed_at < {{stop: DateTime64(3)}}
),
evidence_shas AS (SELECT DISTINCT arrayJoin(role_shas) AS sha FROM landings),
jobs AS (
    SELECT
        id, head_sha, run_attempt, conclusion, workflow_name AS workflow, {JOB_COLUMNS},
        splitByString(', ', trimRight(np[2], ')')) AS test_args,
        concat(workflow, ' / ', build_env, ' / ', test_config) AS config,
        test_args[2] AS shard,
        toUInt32OrZero(test_args[3]) AS num_shards
    FROM default.workflow_job
    PREWHERE id IN (
        SELECT id FROM materialized_views.workflow_job_by_head_sha
        WHERE head_sha IN (SELECT sha FROM evidence_shas)
    )
    WHERE startsWith(dynamoKey, 'pytorch/pytorch/') AND status = 'completed'
        AND length(np) = 2 AND {TD_SCOPE}
        AND NOT arrayExists(x -> position(build_env, x) > 0, {list(NO_TD_BUILD_MARKERS)!r})
    ORDER BY _inserted_at DESC
    LIMIT 1 BY id
),
fails AS (
    SELECT DISTINCT job_id, replaceAll(invoking_file, '.', '/') AS test_file
    FROM default.failed_test_runs
    PREWHERE job_id IN (SELECT id FROM jobs)
    WHERE (failure.size0 > 0 OR error.size0 > 0) AND {IS_FILE}
),
evidence AS (
    SELECT
        j.head_sha AS sha,
        j.config AS config,
        max(j.num_shards) > 0
            AND uniqExactIf(
                j.shard,
                j.conclusion = 'success' OR (j.conclusion = 'failure' AND f.test_file != '')
            ) >= max(j.num_shards) AS completed,
        groupArrayIf(
            (f.test_file, j.run_attempt), j.conclusion = 'failure' AND f.test_file != ''
        ) AS fails,
        groupUniqArrayIf(f.test_file, f.test_file != '') AS failed_files
    FROM jobs AS j
    LEFT JOIN fails AS f ON j.id = f.job_id
    GROUP BY GROUPING SETS ((sha, config), (sha))
),
candidates AS (
    SELECT
        l.head_sha AS sha, l.pushed_at AS landed_at, l.n_commits AS n_commits, l.pr AS pr,
        e.config AS config,
        arrayJoin(arrayDistinct(arrayMap(x -> tupleElement(x, 1), e.fails))) AS test_file,
        arrayZip(range(length(l.role_shas)), l.role_shas) AS roles
    FROM landings AS l
    INNER JOIN evidence AS e ON e.sha = l.head_sha
    WHERE e.config != '' AND length(e.fails) > 0
),
failures AS (
    SELECT
        c.sha AS sha, any(c.landed_at) AS landed_at, any(c.n_commits) AS n_commits,
        any(c.pr) AS pr, c.config AS config, c.test_file AS test_file,
        maxIf(e.completed, c.role = 0 AND c.ev_config != '')
            AND NOT maxIf(has(e.failed_files, test_file), c.role = 0 AND c.ev_config = '')
            AS before_ok,
        length(arrayDistinct(arrayFlatten(groupArrayIf(
            arrayMap(
                x -> tupleElement(x, 2),
                arrayFilter(x -> tupleElement(x, 1) = test_file, e.fails)
            ),
            c.role = 1 AND c.ev_config != ''
        )))) AS failed_attempts,
        arraySort(groupArrayIf(
            (c.role, has(arrayMap(x -> tupleElement(x, 1), e.fails), test_file)),
            c.role >= 2 AND c.ev_config != '' AND e.completed
        )) AS nexts
    FROM (
        SELECT *,
            arrayJoin(arrayConcat(
                arrayMap(r -> (tupleElement(r, 1), tupleElement(r, 2), config), roles),
                [(0, tupleElement(roles[1], 2), '')]
            )) AS role_sha,
            tupleElement(role_sha, 1) AS role,
            tupleElement(role_sha, 2) AS ev_sha,
            tupleElement(role_sha, 3) AS ev_config
        FROM candidates
    ) AS c
    LEFT JOIN evidence AS e ON c.ev_sha = e.sha AND c.ev_config = e.config
    GROUP BY c.sha, c.config, c.test_file
    HAVING before_ok AND (failed_attempts >= 2 OR tupleElement(nexts[1], 2))
)
SELECT sha AS landing_sha, landed_at, n_commits, pr, config, test_file
FROM failures
ORDER BY landed_at, sha, config, test_file
{SETTINGS}
"""

MAIN_RUNS_SQL = f"""
SELECT id AS run_id, head_sha
FROM (
    SELECT id, head_sha, name AS workflow, event, head_branch
    FROM default.workflow_run
    WHERE id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN {{shas: Array(String)}}
        )
        AND repository.full_name = 'pytorch/pytorch'
    ORDER BY run_attempt DESC
    LIMIT 1 BY id
)
WHERE event = 'push' AND head_branch = 'main' AND {TD_SCOPE}
ORDER BY run_id
{SETTINGS}
"""
