-- Alert when a viable/strict blocking job has been failing for 3 or more
--   consecutive commits on main.
-- This query is used by these Grafana alerts. They use the same query but have
--   different thresholds for alerting:
--   - https://pytorchci.grafana.net/alerting/grafana/eewi8oa4ccef4e/view [HUD is broken - 3 commits in a row (<=5 jobs failing)]
--   - https://pytorchci.grafana.net/alerting/grafana/ceyyxwjkgjbb4e/view [HUD is badly broken - Likely infra related (>5 jobs failing)]

-- This subtable does two things:
--   1. Collect the jobs that we actually care about for this alert.
--   2. Merge the sharded jobs into a single logical job, so that if a test
--      moves from one shard to another, we still see it as the same job.
WITH raw_jobs AS (
    SELECT
        j.head_sha,
        j.workflow_name,
        -- Collapse shard numbers in "... / test (default, <shard>, <total>, ...)"
        replaceRegexpAll(j.job_name, ',\\s*\\d+\\s*,\\s*\\d+', '') AS job_group,
        j.commit_time,
        j.status,
        j.conclusion,
        j.commit_message
    FROM materialized_views.workflow_jobs_on_main j
    WHERE
       -- Filter down to the viable/strict blocking jobs we care about
       (
            j.workflow_name IN ('pull', 'trunk')
            OR j.workflow_name like 'linux-binary-%'
       )
       and j.job_name not like '%rerun_disabled_tests%'
       and j.job_name not like '%unstable%'
       and j.job_name not like '%mem_leak_check%'
       AND j.conclusion IN ('success', 'failure')
),

-- Shards add funniness to how we handle jobs completions.  If two
--   shards of a job are completed, but one is still pending, we
--   don't want to accidentally assume that the job is green (which would
--   delay a potential alert firing)
--
-- We follow these rules to merge the shards in a sane way:
--   - if any shard failed             ⇒ 'failure'
--   - else if any shard not completed ⇒ 'pending'
--   - else                            ⇒ 'success'
merged_jobs AS (
    SELECT
        workflow_name,
        job_group,
        head_sha,
        commit_time,
        anyHeavy(commit_message) AS commit_message,
        countIf(conclusion = 'failure')                    AS failures,
        countIf(status != 'completed')                     AS incomplete,
        multiIf(
            countIf(conclusion = 'failure') > 0, 'failure',
            countIf(status != 'completed')  > 0, 'pending',
            'success'
        ) AS merged_conclusion
    FROM raw_jobs
    GROUP BY workflow_name, job_group, head_sha, commit_time
),

-- Step 1: Create a clean timeline of each job's success/failure history
-- We ignore 'pending' jobs since we only care about definitive outcomes.
-- This bit can be translated as:
--   "For each job type, show me the last N commits and
--    whether they passed or failed"
-- row_num=1 = most recent commit, row_num=2 = second most recent, etc.
job_timeline AS (
    SELECT
        workflow_name,
        job_group,
        head_sha,
        commit_time,
        commit_message,
        merged_conclusion AS conclusion,
        ROW_NUMBER() OVER (
            PARTITION BY workflow_name, job_group
            ORDER BY commit_time DESC
        ) AS row_num
    FROM merged_jobs
    WHERE merged_conclusion IN ('success', 'failure')
),

-- Step 2: Find consecutive runs of the same result (success or failure)
-- This is the tricky part. We need to identify when a job goes from:
--   commit 1: failure, commit 2: failure, commit 3: success  ← 2 failures in a row
--   commit 4: success, commit 5: failure, commit 6: failure  ← 2 more failures in a row
--
-- We use a math trick: if we number failures [1,2,3...] and also number ALL commits [1,2,3...],
-- then subtract them, consecutive failures will have the same difference.
-- Real example: [F,F,S,F,F] → failure_nums=[1,2,_,3,4], all_nums=[1,2,3,4,5]
--               → differences=[0,0,_,1,1] ← same diff = same streak!
streak_groups AS (
    SELECT
        *,
        row_num - ROW_NUMBER() OVER (
            PARTITION BY workflow_name, job_group, conclusion
            ORDER BY row_num
        ) AS group_id
    FROM job_timeline
),

-- Step 3: Count how long each failure streak is, and keep only the ones
--         that exceed our threshold (≥3 failures)
-- For each streak, we also track when it started and ended.
failure_streaks AS (
    SELECT
        workflow_name,
        job_group,
        group_id,
        count() AS streak_length,
        min(commit_time) AS first_commit_time,
        max(commit_time) AS last_commit_time,
        argMin(head_sha, commit_time) AS first_commit_sha,
        argMax(head_sha, commit_time) AS last_commit_sha,
        argMin(commit_message, commit_time) AS first_commit_message,
        argMax(commit_message, commit_time) AS last_commit_message
    FROM streak_groups
    WHERE conclusion = 'failure'
    GROUP BY workflow_name, job_group, group_id
    HAVING count() >= 3
),

-- Look at the most recent row per (workflow, job_group) to
--  tell if the streak is ongoing
latest AS (
    SELECT
        workflow_name,
        job_group,
        group_id AS latest_group,
        conclusion AS latest_conclusion
    FROM streak_groups
    WHERE row_num = 1 -- most recent
)

-- This final SELECT statement returns the number of jobs that are currenty
--   experiencing a failure streak of 3 or more commits.
-- The wrapper SELECT COUNT(*) is required by Grafana to give it data
-- in the shape it can use.
--   See: https://grafana.com/docs/grafana/latest/alerting/fundamentals/alert-rules/queries-conditions/#data-source-queries
-- I left the inner query as-is for easier future debugging, it creates a useful view.
--  Comment out the outer select to see the actual data.
SELECT COUNT(*)
FROM (
  SELECT
      concat(fs.workflow_name, ' → ', fs.job_group) AS failing_job,
      fs.streak_length AS consecutive_failures,
      fs.first_commit_sha AS first_failure_commit,
      fs.first_commit_time AS first_failure_time,
      fs.last_commit_sha AS last_failure_commit,
      fs.last_commit_time AS last_failure_time,
      substring(fs.first_commit_message, 1, 60) AS first_failure_message,
      (l.latest_conclusion = 'failure' AND l.latest_group = fs.group_id) AS is_ongoing
  FROM failure_streaks AS fs
  JOIN latest AS l
    ON fs.workflow_name = l.workflow_name
  AND fs.job_group    = l.job_group
  WHERE TRUE
    AND (l.latest_conclusion = 'failure' AND l.latest_group = fs.group_id) -- Is ongoing
    AND fs.last_commit_time >= now() - INTERVAL 24 HOURS
  ORDER BY fs.first_commit_time DESC, fs.streak_length DESC
)