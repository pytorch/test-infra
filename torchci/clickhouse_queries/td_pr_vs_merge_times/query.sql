-- Per-merge PR<->trunk commit mapping + pull/trunk wall-time comparison between
-- the PR's last (pre-merge) commit and the squashed commit that landed on trunk.
--
-- Context: a PR's pre-merge runs use Target Determination (a test subset); the
-- landed commit runs the full suite post-merge. Comparing pull/trunk durations
-- (longest run's min(job created)->max(job completed) = the Gantt formula; see
-- durs) on the two commits shows TD's realized time impact. We also surface
-- whether trunk ran on the exact PR head pre-merge (trunk_coverage; ciflow-tag
-- trunk runs whose head_sha = last_commit_sha) and how the PR was merged
-- (clean / force / ignore-current).
--
-- This is the FAST query (no test-result tables): ~4s for a 7-day window.
WITH range_merges AS (
    -- Commits that landed on the branch within the window (drives the row set).
    SELECT
        p.head_commit.id AS merge_sha,
        p.head_commit.timestamp AS merge_time,
        p.head_commit.message AS message
    FROM default.push p
    WHERE
        p.repository.full_name = {repo: String }
        AND p.ref = {ref: String }
        AND p.head_commit.timestamp >= {startTime: DateTime64(3) }
        AND p.head_commit.timestamp <= {stopTime: DateTime64(3) }
),

mg AS (
    -- One row per landed merge commit (keyed on merge_commit_sha).
    -- last_commit_sha = the PR head CI ran on; merge_commit_sha = the squashed
    -- commit that landed. FINAL dedups the ReplacingMergeTree. NOTE: a single
    -- pr_num can appear on multiple rows if the PR was reverted and re-landed in
    -- the window (each re-land is a distinct merge_commit_sha).
    SELECT
        m.merge_commit_sha AS merge_sha,
        m.last_commit_sha AS pr_head,
        m.pr_num AS pr,
        m.author AS author,
        m.skip_mandatory_checks AS force,
        m.ignore_current AS ign
    FROM default.merges m FINAL
    WHERE
        m.owner = {owner: String }
        AND m.project = {project: String }
        AND m.merge_commit_sha IN (SELECT merge_sha FROM range_merges)
        AND m.last_commit_sha != ''
),

durs AS (
    -- Duration of a commit's workflow = the LONGEST single execution's wall time,
    -- computed from JOBS as min(created_at) -> max(completed_at) over one
    -- (run_id, run_attempt)'s jobs. This IS the commit-page Gantt formula, so it
    -- matches the Gantt exactly for single-run commits.
    --
    -- We compute from workflow_job, NOT straight from workflow_run, because the run
    -- row is unreliable here: (a) workflow_run keeps only the latest attempt for
    -- many reruns (earlier full runs have jobs but no run row), and (b) a run still
    -- at status='in_progress' has a frozen updated_at, so run_started_at->updated_at
    -- understates it (often by hours) versus the jobs' min(created)->max(completed)
    -- span, which is what the Gantt shows; once the run completes the two converge.
    --
    -- Robustness:
    --   * created_at -> completed_at, NOT started_at: rerun JOBS carry a stale
    --     started_at copied from the prior attempt (started<created for ~160/166
    --     jobs on some commits), inflating started->completed into the tens-to-
    --     hundreds of hours (19h+, up to ~700h historically); job created_at is
    --     per-attempt correct, so created->completed is right (e.g. ad548d48ba
    --     pull att2: started->completed 19.48h vs created->completed 1.86h).
    --   * per (run_id, run_attempt) then max(): never spans across re-fires/reruns,
    --     and picks the longest real execution (avoids a short degenerate rerun,
    --     e.g. ad548 pull run 28912476488: max() keeps att1 2.26h over att2 1.86h,
    --     or an early-cancelled attempt).
    -- Event/name filters mirror commit_jobs_query's job branch, with these
    -- deliberate differences: we restrict wr.name IN ('pull','trunk') (which makes
    -- the 'Upload test stats while running' exclusion redundant -- that name is
    -- pytorch-only), exclude conclusion='skipped' (instantaneous jobs; changes a
    -- span by <=2s), and guard created_at/completed_at against epoch-zero. We match
    -- jobs by job.id (workflow_job_by_head_sha) and intentionally OMIT the
    -- workflow_run_by_head_sha filter on workflow.id, because that MV keeps only the
    -- latest run_attempt and would hide earlier full attempts we want to measure
    -- (they share run_id, so the job set still matches the Gantt).
    SELECT
        head_sha,
        wf,
        max(exec_dur) AS dur
    FROM (
        SELECT
            head_sha,
            wf,
            run_id,
            run_attempt,
            dateDiff('second', min(created_at), max(completed_at)) AS exec_dur
        FROM (
            SELECT
                wj.head_sha AS head_sha,
                wr.name AS wf,
                wj.run_id AS run_id,
                wj.run_attempt AS run_attempt,
                wj.created_at AS created_at,
                wj.completed_at AS completed_at
            FROM default.workflow_job wj FINAL
            INNER JOIN default.workflow_run wr FINAL ON wr.id = wj.run_id
            WHERE
                wj.id IN (
                    SELECT id FROM materialized_views.workflow_job_by_head_sha
                    WHERE head_sha IN (
                        SELECT pr_head FROM mg
                        UNION ALL
                        SELECT merge_sha FROM mg
                    )
                )
                AND tupleElement(wr.repository, 'full_name') = {repo: String }
                AND wr.name IN ('pull', 'trunk')
                AND wj.name NOT IN ('ciflow_should_run', 'generate-test-matrix')
                AND wr.event NOT IN ('workflow_run', 'repository_dispatch')
                AND NOT (
                    wr.event = 'workflow_dispatch'
                    AND wr.head_branch LIKE 'trunk/%'
                )
                AND wj.conclusion != 'skipped'
                AND wj.created_at > toDateTime('2020-01-01 00:00:00')
                AND wj.completed_at > toDateTime('2020-01-01 00:00:00')
        )
        GROUP BY head_sha, wf, run_id, run_attempt
    )
    GROUP BY head_sha, wf
),

trunk_on_pr AS (
    -- Did trunk run on the exact PR head that merged, and with what conclusion?
    -- trunk PR-time runs are ciflow-tag pushes whose head_sha = last_commit_sha.
    -- argMaxIf over completed runs ignores an in-progress rerun's empty conclusion,
    -- which would otherwise mislabel a head that DID complete trunk as 'absent'.
    SELECT
        wr.head_sha AS head_sha,
        argMaxIf(wr.conclusion, wr.created_at, wr.status = 'completed') AS concl
    FROM default.workflow_run wr
    WHERE
        wr.id IN (
            SELECT id FROM materialized_views.workflow_run_by_head_sha
            WHERE head_sha IN (SELECT pr_head FROM mg)
        )
        AND wr.name = 'trunk'
    GROUP BY head_sha
)

SELECT
    mg.pr AS pr_num,
    mg.pr_head AS pr_head,
    mg.merge_sha AS merge_sha,
    rm.merge_time AS merge_time,
    substring(rm.message, 1, 100) AS title,
    mg.author AS author,
    multiIf(mg.force, 'force', mg.ign, 'ignore', 'clean') AS merge_type,
    multiIf(
        tp.concl = 'success', 'green',
        tp.concl = '', 'absent',
        tp.concl
    ) AS trunk_coverage,
    pull_pr.dur AS pull_pr_s,
    pull_mc.dur AS pull_merge_s,
    trunk_pr.dur AS trunk_pr_s,
    trunk_mc.dur AS trunk_merge_s
FROM mg
INNER JOIN range_merges rm ON rm.merge_sha = mg.merge_sha
LEFT JOIN trunk_on_pr tp ON tp.head_sha = mg.pr_head
LEFT JOIN durs pull_pr ON pull_pr.head_sha = mg.pr_head AND pull_pr.wf = 'pull'
LEFT JOIN
    durs pull_mc
    ON pull_mc.head_sha = mg.merge_sha AND pull_mc.wf = 'pull'
LEFT JOIN
    durs trunk_pr
    ON trunk_pr.head_sha = mg.pr_head AND trunk_pr.wf = 'trunk'
LEFT JOIN
    durs trunk_mc
    ON trunk_mc.head_sha = mg.merge_sha AND trunk_mc.wf = 'trunk'
ORDER BY rm.merge_time DESC
