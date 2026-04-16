/* Windowed per-build table (UTC), incl. PR & main builds, with queue totals, cost, and is_main_branch.
   WAIT: only attempts with started_at IS NOT NULL contribute wait (runnable → started).
   RUN: clip to [w_start, w_end]; 1-day zombie guard for open 'running' attempts.
   COST: 1.3232 * gpu_1_queue_run_hours + 4.602 * gpu_4_queue_run_hours (fixed).
*/

WITH
  parseDateTime64BestEffort({startTime:String}, 3) AS w_start,   -- inclusive (UTC)
  parseDateTime64BestEffort({stopTime:String},  3) AS w_end,     -- exclusive (UTC)
  toDateTime64(now(), 3)                       AS now64,
  (w_end - INTERVAL 1 DAY)                     AS zombie_cutoff,
  toDateTime64('2100-01-01 00:00:00', 3)       AS FAR_FUTURE,
  ['gpu_1_queue','gpu_4_queue', 'cpu_queue_premerge_us_east_1'] AS QUEUES

/* 1) All builds created within the window (+ branch/PR context) */
, builds_window AS (
  SELECT
    tupleElement(build,'id') AS build_id,

    argMax(tupleElement(build,'number'),    tupleElement(job,'created_at')) AS build_number,
    argMax(tupleElement(build,'web_url'),   tupleElement(job,'created_at')) AS build_url,
    concat(argMax(tupleElement(build,'web_url'), tupleElement(job,'created_at')), '/steps/table') AS steps_table_url,
    argMax(tupleElement(build,'commit'),    tupleElement(job,'created_at')) AS commit_sha,

    /* robust start/finish (fallback to job min/max if build-level fields are NULL) */
    coalesce(argMax(tupleElement(build,'started_at'),  tupleElement(job,'created_at')),
             min(tupleElement(job,'started_at')))  AS robust_start,
    coalesce(argMax(tupleElement(build,'finished_at'), tupleElement(job,'created_at')),
             max(tupleElement(job,'finished_at'))) AS robust_finish,

    countDistinct(tupleElement(job,'id')) AS steps_count,
    argMax(tupleElement(build,'state'), tupleElement(job,'created_at')) AS latest_build_state,

    /* repo + PR mapping (repo_slug may come from pipeline or PR repo) */
    coalesce(
      nullIf(extract(argMax(tupleElement(pipeline,'repository'),           tupleElement(job,'created_at')), 'github\\.com[:/]+([^/]+/[^/.]+)'), ''),
      nullIf(extract(argMax(tupleElement(build,'pull_request').repository, tupleElement(job,'created_at')), 'github\\.com[:/]+([^/]+/[^/.]+)'), ''),
      nullIf(extract(argMax(tupleElement(build,'pull_request').repository, tupleElement(job,'created_at')), '([^/]+/[^/.]+)'), '')
    ) AS repo_slug,
    coalesce(
      toInt64OrNull(argMax(tupleElement(build,'pull_request').id, tupleElement(job,'created_at'))),
      toInt64OrNull(extract(argMax(tupleElement(build,'branch'), tupleElement(job,'created_at')), 'pull/([0-9]+)'))
    ) AS pr_number,

    argMax(tupleElement(build,'created_at'), tupleElement(job,'created_at')) AS build_created_at_utc,
    argMax(tupleElement(build,'branch'),     tupleElement(job,'created_at')) AS branch_name
  FROM vllm.vllm_buildkite_jobs
  GROUP BY tupleElement(build,'id')
  HAVING build_created_at_utc >= w_start AND build_created_at_utc < w_end
)

/* 2) Agent-run attempts for those builds that can overlap the window */
, base_agent AS (
  SELECT
    tupleElement(build,'id')        AS build_id,
    tupleElement(job,'id')          AS job_id,
    tupleElement(job,'created_at')  AS created_at,
    tupleElement(job,'state')       AS state,
    tupleElement(job,'runnable_at') AS runnable_at,
    tupleElement(job,'started_at')  AS started_at,
    tupleElement(job,'finished_at') AS finished_at,
    replaceOne(arrayFirst(x -> startsWith(x,'queue='),
                          tupleElement(job,'agent_query_rules')), 'queue=', '') AS queue_key
  FROM vllm.vllm_buildkite_jobs
  INNER JOIN builds_window b ON tupleElement(build,'id') = b.build_id
  WHERE tupleElement(job,'type') IN ('script','command')
    AND (
      tupleElement(job,'runnable_at') < w_end OR
      tupleElement(job,'started_at')  < w_end OR
      ifNull(tupleElement(job,'finished_at'), FAR_FUTURE) >= w_start
    )
)

/* 3) Collapse to (build_id, job_id) and collect attempts keyed by queue */
, jobs_by_build AS (
  SELECT
    build_id,
    job_id,
    argMax(state, created_at) AS latest_state,
    max(created_at)           AS last_event_at,

    /* RUN attempts: (queue, start, finish) */
    arrayDistinct(arrayFilter(t -> t.2 IS NOT NULL,
      groupArray((queue_key, started_at, finished_at))
    )) AS run_triplets,

    /* WAIT attempts: (queue, runnable, start) — ONLY attempts that actually started */
    arrayDistinct(arrayFilter(t -> t.2 IS NOT NULL AND t.3 IS NOT NULL,
      groupArray((queue_key, runnable_at, started_at))
    )) AS wait_triplets
  FROM base_agent
  GROUP BY build_id, job_id
)

/* 4) RUN attempts → per build × queue (clip to window; zombie guard for open runs) */
, runs_scored AS (
  SELECT
    build_id,
    tupleElement(rt, 1) AS queue_key,
    greatest(tupleElement(rt, 2), w_start) AS s_clip,
    least(
      ifNull(
        tupleElement(rt, 3),
        if(latest_state = 'running' AND last_event_at < zombie_cutoff,
           least(last_event_at + INTERVAL 1 MINUTE, w_end),
           w_end)
      ),
      w_end
    ) AS e_clip
  FROM jobs_by_build
  ARRAY JOIN run_triplets AS rt
  WHERE tupleElement(rt, 1) IN QUEUES
)
, run_by_build AS (
  SELECT
    build_id, queue_key,
    sumIf(dateDiff('second', s_clip, e_clip), e_clip > s_clip) AS total_run_s
  FROM runs_scored
  GROUP BY build_id, queue_key
)

/* 5) WAIT attempts (runnable → started) → per build × queue (clip to window) */
, waits_scored AS (
  SELECT
    build_id,
    tupleElement(wt, 1) AS queue_key,
    greatest(tupleElement(wt, 2), w_start) AS ra_clip,
    least(tupleElement(wt, 3), w_end)      AS st_clip,
    greatest(0, dateDiff('second', greatest(tupleElement(wt, 2), w_start), least(tupleElement(wt, 3), w_end))) AS wait_s
  FROM jobs_by_build
  ARRAY JOIN wait_triplets AS wt
  WHERE tupleElement(wt, 1) IN QUEUES
)
, waits_p90_pivot AS (
  SELECT
    build_id,
    /* P90 per queue (approximate quantile; broadly supported) */
    quantileIf(0.9)(toFloat64(wait_s), queue_key = 'gpu_1_queue') AS gpu1_p90_s,
    quantileIf(0.9)(toFloat64(wait_s), queue_key = 'gpu_4_queue') AS gpu4_p90_s,
    quantileIf(0.9)(toFloat64(wait_s), queue_key = 'cpu_queue_premerge_us_east_1') AS cpu_p90_s,
    /* Combined P90 across both queues */
    quantile(0.9)(toFloat64(wait_s)) AS p90_combined_s
  FROM waits_scored
  WHERE wait_s > 0
  GROUP BY build_id
)

/* 6) Pivot per-build totals to hour columns */
, run_totals_by_build AS (
  SELECT
    build_id,
    round(sumIf(total_run_s, queue_key = 'gpu_1_queue') / 3600.0, 2) AS gpu_1_queue_run_hours,
    round(sumIf(total_run_s, queue_key = 'gpu_4_queue') / 3600.0, 2) AS gpu_4_queue_run_hours,
    round(sumIf(total_run_s, queue_key = 'cpu_queue_premerge_us_east_1') / 3600.0, 2) AS cpu_queue_run_hours
  FROM run_by_build
  GROUP BY build_id
)

/* 7) Final table (UTC) — includes both PR and main builds */
SELECT
  /* PR URL (NULL for non-PR builds) */
  if((b.pr_number IS NULL) OR (b.repo_slug IS NULL),
     NULL,
     concat('https://github.com/', b.repo_slug, '/pull/', toString(b.pr_number))
  ) AS pr_url,

  b.build_number AS build_number,
  b.build_id AS build_id,
  b.build_url AS build_url,
  b.steps_table_url AS steps_table_url,
  b.commit_sha AS commit_sha,

  b.robust_start  AS build_started_at,
  b.robust_finish AS build_finished_at,

  /* duration (hours) = finish − start (UTC) */
  multiIf(
    b.robust_start IS NULL OR b.robust_finish IS NULL,
    NULL,
    round(dateDiff('second', b.robust_start, b.robust_finish) / 3600.0, 2)
  ) AS duration_hours,

  b.steps_count AS steps_count,
  b.latest_build_state AS latest_build_state,

  /* Keep run hours for cost */
  ifNull(rt.gpu_1_queue_run_hours,  0) AS gpu_1_queue_run_hours,
  ifNull(rt.gpu_4_queue_run_hours,  0) AS gpu_4_queue_run_hours,
  ifNull(rt.cpu_queue_run_hours,    0) AS cpu_queue_run_hours,

  /* NEW: P90 wait hours (by queue + combined) */
  round(ifNull(wp.gpu1_p90_s, 0) / 3600.0, 2) AS gpu_1_queue_wait_p90_hours,
  round(ifNull(wp.gpu4_p90_s, 0) / 3600.0, 2) AS gpu_4_queue_wait_p90_hours,
  round(ifNull(wp.cpu_p90_s, 0) / 3600.0, 2) AS cpu_queue_wait_p90_hours,
  round(ifNull(wp.p90_combined_s, 0) / 3600.0, 2) AS wait_p90_hours,

  /* Fixed-rate cost */
  round(
    1.3232 * ifNull(rt.gpu_1_queue_run_hours, 0) +
    4.602  * ifNull(rt.gpu_4_queue_run_hours, 0),
    2
  ) AS cost,

  /* Mark if the build branch is literally 'main' */
  toUInt8(b.branch_name = 'main') AS is_main_branch

FROM builds_window AS b
LEFT JOIN run_totals_by_build AS rt ON rt.build_id = b.build_id
LEFT JOIN waits_p90_pivot    AS wp ON wp.build_id = b.build_id
ORDER BY b.build_created_at_utc ASC;
