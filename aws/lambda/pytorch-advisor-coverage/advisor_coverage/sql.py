r"""ClickHouse queries for enumerating currently-UNCLASSIFIED trunk reds.

Reuses the exact CTE chain and the category=5 (unclassified) definition from
torchci `flaky_trunk_jobs/query.sql`: a red is unclassified when it has NO
attaching advisor verdict (related/revert/infra_issue/not_related/garbage) keyed
to the trunk head_sha AND is not structurally persistent (no adjacent hard-red
on the previous or next trunk commit). Two queries per window:

- QUERY_UNCLASSIFIED: category=5 reds with the representative failing job row.
- QUERY_BASELINES:    recent GREEN runs of the involved jobs (payload context).

Fragments are composed with `", \n".join(...)` (never str.format / f-strings)
so ClickHouse's `{name:Type}` parameter syntax passes through untouched. The
`/*WORKFLOW_FILTER*/` marker is replaced at runtime by the enumerator.

NOTE: the shard/runner-stripping regexes and the category logic are copied
verbatim from flaky_trunk_jobs so coverage keys off the SAME normalized job
identity the /flaky_trunk page joins on.
"""

_CTE_TRUNK_COMMITS = r"""trunk_commits AS (
    SELECT
        tupleElement(head_commit, 'id') AS head_sha,
        min(tupleElement(head_commit, 'timestamp')) AS commit_time
    FROM default.push
    WHERE
        ref = 'refs/heads/main'
        AND tupleElement(repository, 'full_name') = {repo:String}
        AND tupleElement(head_commit, 'timestamp') >= {startTime:DateTime64(3)}
        AND tupleElement(head_commit, 'timestamp') < {stopTime:DateTime64(3)}
    GROUP BY head_sha
)"""

_CTE_ADVISOR_AGG = r"""advisor_agg AS (
    SELECT
        head_sha,
        adv_norm,
        maxIf(1, verdict IN ('related', 'revert')) AS advisor_real,
        maxIf(1, verdict = 'infra_issue') AS advisor_infra,
        maxIf(1, verdict IN ('not_related', 'garbage')) AS advisor_testflake
    FROM (
        SELECT
            toString(suspect_commit) AS head_sha,
            replaceRegexpOne(
                replaceRegexpOne(
                    if(
                        startsWith(signal_key, 'dr_ci_'),
                        arrayStringConcat(
                            arraySlice(splitByString(' / ', substring(signal_key, 7)), 2),
                            ' / '
                        ),
                        signal_key
                    ),
                    ' \\[[^\\]]+\\]$', ''
                ),
                ', [0-9]+, [0-9]+, .+\\)', ')'
            ) AS adv_norm,
            argMax(verdict, timestamp) AS verdict
        FROM misc.autorevert_advisor_verdicts
        WHERE
            repo = {repo:String}
            AND signal_source = 'job'
            AND timestamp >= {startTime:DateTime64(3)}
        GROUP BY suspect_commit, signal_key
    )
    GROUP BY head_sha, adv_norm
)"""

_CTE_RAW_JOBS = r"""raw_jobs AS (
    SELECT
        j.head_sha AS head_sha,
        tc.commit_time AS commit_time,
        j.workflow_name AS workflow_name,
        j.name AS name,
        replaceRegexpOne(j.name, ', ([0-9]+), ([0-9]+), [^)]+\\)$', ', \\1, \\2)') AS cons_name,
        j.conclusion AS conclusion,
        j.id AS job_id,
        j.run_id AS run_id,
        j.run_attempt AS run_attempt,
        j.started_at AS started_at,
        j.completed_at AS completed_at
    FROM default.workflow_job j
    INNER JOIN trunk_commits tc ON j.head_sha = tc.head_sha
    WHERE
        j.created_at >= {startTime:DateTime64(3)}
        AND j.created_at < {stopTime:DateTime64(3)}
        AND j.conclusion IN ('success', 'failure')
        AND j.name LIKE '%/%'
        AND j.name NOT LIKE '%rerun_disabled_tests%'
        AND j.name NOT LIKE '%mem_leak_check%'
        AND j.name NOT LIKE '%unstable%'
        /*WORKFLOW_FILTER*/
)"""

_CTE_CONSOLIDATED = r"""consolidated AS (
    SELECT
        head_sha,
        workflow_name,
        cons_name,
        any(commit_time) AS commit_time,
        replaceRegexpOne(cons_name, ', [0-9]+, [0-9]+\\)$', ')') AS norm_name,
        countIf(conclusion = 'success') > 0 AS has_success,
        countIf(conclusion = 'failure') > 0 AS has_failure
    FROM raw_jobs
    GROUP BY head_sha, workflow_name, cons_name
)"""

_CTE_JOB_SIGNALS = r"""job_signals AS (
    SELECT
        c.head_sha AS head_sha,
        c.workflow_name AS workflow_name,
        c.cons_name AS cons_name,
        c.norm_name AS norm_name,
        c.commit_time AS commit_time,
        toUInt8(c.has_success AND NOT c.has_failure) AS is_green,
        toUInt8(c.has_failure) AS is_red,
        toUInt8(c.has_failure AND NOT c.has_success) AS hard_red,
        COALESCE(aa.advisor_real, 0) AS adv_real,
        COALESCE(aa.advisor_infra, 0) AS adv_infra,
        COALESCE(aa.advisor_testflake, 0) AS adv_testflake
    FROM consolidated c
    LEFT JOIN advisor_agg aa ON aa.head_sha = c.head_sha AND aa.adv_norm = c.norm_name
)"""

_CTE_FINAL_JOBS = r"""final_jobs AS (
    SELECT
        head_sha, workflow_name, cons_name, norm_name, commit_time, is_red,
        multiIf(
            is_red = 0, 0,
            adv_real = 1, 1,
            adv_infra = 1, 4,
            adv_testflake = 1, 3,
            persistent = 1, 1,
            5
        ) AS category
    FROM (
        SELECT
            head_sha, workflow_name, cons_name, norm_name, commit_time, is_red,
            adv_real, adv_infra, adv_testflake,
            toUInt8(
                hard_red = 1
                AND (lagInFrame(hard_red) OVER w = 1 OR leadInFrame(hard_red) OVER w = 1)
            ) AS persistent
        FROM job_signals
        WINDOW w AS (
            PARTITION BY workflow_name, cons_name
            ORDER BY commit_time
            ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING
        )
    )
)"""

# Total runs per normalized job over the window — matches the /flaky_trunk
# HAVING total_runs >= minRuns, so coverage targets the same displayed set.
_CTE_JOB_COUNTS = r"""job_counts AS (
    SELECT
        workflow_name,
        norm_name,
        countIf(is_green = 1 OR is_red = 1) AS total_runs
    FROM job_signals
    GROUP BY workflow_name, norm_name
)"""

# Representative concrete job row per (commit, job): the latest failing attempt.
_CTE_RED_JOBS = r"""red_jobs AS (
    SELECT
        head_sha, workflow_name, cons_name,
        argMax(name, (run_attempt, started_at)) AS name,
        argMax(job_id, (run_attempt, started_at)) AS job_id,
        argMax(run_id, (run_attempt, started_at)) AS run_id,
        max(run_attempt) AS run_attempt_max,
        argMax(started_at, (run_attempt, started_at)) AS started_at_pick,
        argMax(completed_at, (run_attempt, started_at)) AS completed_at
    FROM raw_jobs
    WHERE conclusion = 'failure'
    GROUP BY head_sha, workflow_name, cons_name
)"""

_CTE_GREEN_JOBS = r"""green_jobs AS (
    SELECT
        head_sha, workflow_name, cons_name,
        argMax(name, (run_attempt, started_at)) AS name,
        argMax(job_id, (run_attempt, started_at)) AS job_id,
        argMax(run_id, (run_attempt, started_at)) AS run_id,
        max(run_attempt) AS run_attempt_max,
        argMax(started_at, (run_attempt, started_at)) AS started_at_pick,
        argMax(completed_at, (run_attempt, started_at)) AS completed_at
    FROM raw_jobs
    WHERE conclusion = 'success'
    GROUP BY head_sha, workflow_name, cons_name
)"""

_SELECT_UNCLASSIFIED = r"""SELECT
    fj.head_sha AS head_sha,
    fj.commit_time AS commit_time,
    fj.workflow_name AS workflow_name,
    rj.name AS name,
    fj.cons_name AS cons_name,
    rj.job_id AS job_id,
    rj.run_id AS run_id,
    rj.run_attempt_max AS run_attempt,
    rj.started_at_pick AS started_at,
    rj.completed_at AS completed_at
FROM final_jobs fj
INNER JOIN red_jobs rj
    ON fj.head_sha = rj.head_sha
    AND fj.workflow_name = rj.workflow_name
    AND fj.cons_name = rj.cons_name
INNER JOIN job_counts jc
    ON jc.workflow_name = fj.workflow_name
    AND jc.norm_name = fj.norm_name
WHERE fj.category = 5
    AND jc.total_runs >= {minRuns:Int32}
ORDER BY fj.commit_time DESC, fj.workflow_name, fj.cons_name"""

_SELECT_BASELINES = r"""SELECT
    c.workflow_name AS workflow_name,
    c.cons_name AS cons_name,
    c.head_sha AS head_sha,
    c.commit_time AS commit_time,
    g.name AS name,
    g.job_id AS job_id,
    g.run_id AS run_id,
    g.run_attempt_max AS run_attempt,
    g.started_at_pick AS started_at,
    g.completed_at AS completed_at
FROM consolidated c
INNER JOIN green_jobs g
    ON g.head_sha = c.head_sha
    AND g.workflow_name = c.workflow_name
    AND g.cons_name = c.cons_name
WHERE c.has_success AND NOT c.has_failure
    AND c.cons_name IN {consNames:Array(String)}
ORDER BY c.commit_time DESC"""


QUERY_UNCLASSIFIED = (
    "WITH\n"
    + ",\n".join(
        [
            _CTE_TRUNK_COMMITS,
            _CTE_ADVISOR_AGG,
            _CTE_RAW_JOBS,
            _CTE_CONSOLIDATED,
            _CTE_JOB_SIGNALS,
            _CTE_FINAL_JOBS,
            _CTE_JOB_COUNTS,
            _CTE_RED_JOBS,
        ]
    )
    + "\n"
    + _SELECT_UNCLASSIFIED
)

QUERY_BASELINES = (
    "WITH\n"
    + ",\n".join(
        [_CTE_TRUNK_COMMITS, _CTE_RAW_JOBS, _CTE_CONSOLIDATED, _CTE_GREEN_JOBS]
    )
    + "\n"
    + _SELECT_BASELINES
)

WORKFLOW_FILTER_MARKER = "/*WORKFLOW_FILTER*/"
WORKFLOW_FILTER_CLAUSE = "AND j.workflow_name IN {workflows:Array(String)}"
