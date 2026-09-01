-- OSDC migration status for every workflow file in a repo that ran CI in the window.
--
-- A job's fleet is decided by the runner that actually executed it:
--   legacy EC2     -> runner_name is an EC2 instance id (i-0abc...)
--   OSDC ARC       -> runner_group_name is an OSDC cluster (see osdc/clusters.yaml)
--   other          -> GitHub-hosted or partner hardware (ROCm / XPU / TPU), out of scope
-- runner_name, not the label or the runner group: GitHub's larger runners share the
-- `default` group with legacy EC2, and some carry linux.* labels (linux.24_04.4x), so
-- both of those signals would misclassify them as legacy.
--
-- Only Linux legacy jobs count as unmigrated: Windows and macOS have no ARC runners yet.
-- (macOS runners are mac*.metal EC2 instances, so they match the i- pattern too.)
--
-- File granularity comes from workflow_run.path, which is the *calling* workflow file --
-- the one a repo owner edits, even when the runner is picked by a reusable workflow.
--
-- Mainline = any run whose workflow definition comes from the repo's merged history:
-- default-branch pushes, nightly, release tags, schedules. PR-scoped runs (pull_request,
-- and pytorch's ciflow/* tags) instead execute the definition from the PR branch, so a
-- long-lived branch keeps replaying pre-migration YAML long after main is clean --
-- pytorch/pytorch has ~155 legacy jobs from branches predating map_ec2_to_arc.py.
--
-- Deliberately NOT "pushes to main only": that would also drop nightly and v*-rc tags,
-- which run current YAML and hold pytorch/pytorch's remaining ~190 real legacy jobs
-- (docker-release.yml -> test-infra/validate-docker-images.yml -> linux_job_v2.yml).
-- Splitting the counters lets the page answer "is the merged state migrated?" separately
-- from "is anything still hitting EC2?".
--
-- Caveat: this only sees files that ran in the window. A file with no CI activity is
-- absent entirely, so the page pairs this with the repo's real workflow file list.
SELECT
    workflowFile,
    legacyJobs,
    osdcJobs,
    otherJobs,
    legacyMainline,
    osdcMainline,
    legacyLabels,
    -- one bucket per day, index 0 = most recent day in the window
    arrayMap(
        d -> toUInt32(countEqual(legacyDayOffsets, toUInt16(d))),
        range(toUInt32(dateDiff('day', {startTime: DateTime64(3) }, {stopTime: DateTime64(3) })))
    ) AS legacyByDay,
    arrayMap(
        d -> toUInt32(countEqual(legacyMainlineDayOffsets, toUInt16(d))),
        range(toUInt32(dateDiff('day', {startTime: DateTime64(3) }, {stopTime: DateTime64(3) })))
    ) AS legacyMainlineByDay,
    lastLegacyRun,
    lastLegacyMainlineRun,
    lastRun,
    if(legacyJobs + osdcJobs = 0, 0, legacyJobs / (legacyJobs + osdcJobs)) AS legacyShare,
    multiIf(
        legacyJobs = 0 AND osdcJobs = 0, 'out_of_scope',
        legacyJobs = 0, 'migrated',
        osdcJobs = 0, 'unmigrated',
        'partial'
    ) AS status
FROM
(
    SELECT
        workflowFile,
        countIf(isLegacy) AS legacyJobs,
        countIf(isOsdc) AS osdcJobs,
        count() - legacyJobs - osdcJobs AS otherJobs,
        countIf(isLegacy AND isMainline) AS legacyMainline,
        countIf(isOsdc AND isMainline) AS osdcMainline,
        arraySort(groupUniqArrayIf(label, isLegacy)) AS legacyLabels,
        groupArrayIf(dayOffset, isLegacy) AS legacyDayOffsets,
        groupArrayIf(dayOffset, isLegacy AND isMainline) AS legacyMainlineDayOffsets,
        maxIf(createdAt, isLegacy) AS lastLegacyRun,
        maxIf(createdAt, isLegacy AND isMainline) AS lastLegacyMainlineRun,
        max(createdAt) AS lastRun
    FROM
    (
        SELECT
            run.path AS workflowFile,
            job.labels[1] AS label,
            job.created_at AS createdAt,
            toUInt16(dateDiff('day', toDate(job.created_at), toDate({stopTime: DateTime64(3) }))) AS dayOffset,
            match(job.runner_name, '^i-[0-9a-f]{8,}$')
                AND startsWith(job.labels[1], 'linux') AS isLegacy,
            match(job.runner_group_name, '^(meta|lf)-(prod|staging)-aws-') AS isOsdc,
            NOT (
                run.event = 'pull_request'
                OR (run.event = 'push' AND startsWith(run.head_branch, 'ciflow/'))
            ) AS isMainline
        FROM default.workflow_job AS job
        INNER JOIN default.workflow_run AS run ON job.run_id = run.id
        WHERE
            job.created_at >= {startTime: DateTime64(3) }
            AND job.created_at < {stopTime: DateTime64(3) }
            -- widen the run side by a day so runs created just before the window still join
            AND run.created_at >= {startTime: DateTime64(3) } - INTERVAL 1 DAY
            AND run.created_at < {stopTime: DateTime64(3) }
            AND job.repository_full_name = {repo: String }
            AND run.repository.'full_name' = {repo: String }
            -- drop jobs that never got a runner (queued / cancelled / skipped)
            AND job.runner_name != ''
    )
    GROUP BY workflowFile
)
ORDER BY legacyJobs DESC, osdcJobs DESC, workflowFile ASC
