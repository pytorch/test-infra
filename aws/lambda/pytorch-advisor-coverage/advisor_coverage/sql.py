r"""ClickHouse queries for enumerating currently-UNCLASSIFIED trunk reds.

Reuses the exact CTE chain and the category=5 (unclassified) definition from
torchci `flaky_trunk_jobs/query.sql`: a red is unclassified when it has NO
attaching advisor verdict (related/revert/infra_issue/not_related/garbage) keyed
to the trunk head_sha AND is not structurally persistent (no adjacent hard-red
on the previous or next trunk commit). Two queries per window:

- QUERY_UNCLASSIFIED: category=5 reds collapsed to ONE row per NORMALIZED job
  (config kept; shard index + runner dropped), each with a representative failing
  run — so exactly one advisor is dispatched per normalized job, keyed
  `coverage_` + the native job signal_key the /flaky_trunk page joins on.
- QUERY_BASELINES:    recent GREEN runs of those normalized jobs (payload context).

Fragments are composed with `", \n".join(...)` (never str.format / f-strings)
so ClickHouse's `{name:Type}` parameter syntax passes through untouched. The
`/*WORKFLOW_FILTER*/` marker is replaced at runtime by the enumerator.

NOTE: the shard/runner-stripping regexes and the category logic are copied
verbatim from flaky_trunk_jobs so coverage keys off the SAME normalized job
identity the /flaky_trunk page joins on. advisor_agg itself is NOT verbatim: it
answers only "does ANY classifying verdict exist for this job?" (the outer
maxIf), so it reduces verdicts with a plain argMax(verdict, timestamp) grouped by
`suspect_commit, signal_key`. The page instead has to pick which verdict wins, so
it uses a native-preference argMax(verdict, (NOT startsWith coverage_, timestamp))
grouped by a coverage-stripped `base_key` — the lambda needs neither. advisor_agg
additionally strips a leading `coverage_` so an already-written coverage verdict
normalizes to (and classifies) the same red — the lambda's category=5 set then
matches the page's classified set. raw_jobs binds jobs by trunk-commit
membership, not a created_at window, so late retry attempts of a windowed commit
are still counted.
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
                        replaceRegexpOne(signal_key, '^coverage_', '')
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
        -- Bind to trunk-commit membership, not a created_at window: a commit's
        -- retries are separate rows created arbitrarily later, so a created_at
        -- window drops late attempts -- a retry-green then falls outside and the
        -- red is misread as persistent/unclassified. trunk_commits is already
        -- windowed on commit timestamp, so this stays scoped to the window.
        j.id IN (
            SELECT id
            FROM materialized_views.workflow_job_by_head_sha
            WHERE head_sha IN (SELECT head_sha FROM trunk_commits)
        )
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

# Total runs per normalized job over the enumeration window. Reuses the
# /flaky_trunk `HAVING total_runs >= minRuns` threshold, but over this window
# (far shorter than the page's default view) it is a STRICTER in-window filter,
# not the page's displayed set.
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

# One row per (commit, NORMALIZED job): the category=5 shards of a normalized job
# at a commit are collapsed to the normalized name so exactly ONE advisor is
# dispatched per normalized job. Its coverage_ verdict then classifies every shard
# of that job at the commit (the same normalized identity /flaky_trunk joins on),
# instead of one shard's verdict bleeding onto its siblings. The representative
# failing run (name/job_id/log) is the latest-attempt category=5 shard.
_SELECT_UNCLASSIFIED = r"""SELECT
    fj.head_sha AS head_sha,
    any(fj.commit_time) AS commit_time,
    fj.workflow_name AS workflow_name,
    argMax(rj.name, (rj.run_attempt_max, rj.started_at_pick, rj.job_id)) AS name,
    fj.norm_name AS norm_name,
    argMax(rj.job_id, (rj.run_attempt_max, rj.started_at_pick, rj.job_id)) AS job_id,
    argMax(rj.run_id, (rj.run_attempt_max, rj.started_at_pick, rj.job_id)) AS run_id,
    max(rj.run_attempt_max) AS run_attempt,
    argMax(rj.started_at_pick, (rj.run_attempt_max, rj.started_at_pick, rj.job_id)) AS started_at,
    argMax(rj.completed_at, (rj.run_attempt_max, rj.started_at_pick, rj.job_id)) AS completed_at
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
GROUP BY fj.head_sha, fj.workflow_name, fj.norm_name
ORDER BY commit_time DESC, workflow_name, norm_name"""

# Green baseline-before runs of the same NORMALIZED jobs: green shard-cells are
# collapsed to the normalized name (one representative green run per commit) so the
# baselines match the normalized red the advisor is asked about.
_SELECT_BASELINES = r"""SELECT
    c.workflow_name AS workflow_name,
    c.norm_name AS norm_name,
    c.head_sha AS head_sha,
    any(c.commit_time) AS commit_time,
    argMax(g.name, (g.run_attempt_max, g.started_at_pick, g.job_id)) AS name,
    argMax(g.job_id, (g.run_attempt_max, g.started_at_pick, g.job_id)) AS job_id,
    argMax(g.run_id, (g.run_attempt_max, g.started_at_pick, g.job_id)) AS run_id,
    max(g.run_attempt_max) AS run_attempt,
    argMax(g.started_at_pick, (g.run_attempt_max, g.started_at_pick, g.job_id)) AS started_at,
    argMax(g.completed_at, (g.run_attempt_max, g.started_at_pick, g.job_id)) AS completed_at
FROM consolidated c
INNER JOIN green_jobs g
    ON g.head_sha = c.head_sha
    AND g.workflow_name = c.workflow_name
    AND g.cons_name = c.cons_name
WHERE c.has_success AND NOT c.has_failure
    AND c.norm_name IN {normNames:Array(String)}
GROUP BY c.workflow_name, c.norm_name, c.head_sha
ORDER BY commit_time DESC"""


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
