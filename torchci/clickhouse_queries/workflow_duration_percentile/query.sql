-- IMO not the best way to calculate this metric, as it should be max across
-- workflow names grouped by sha and then take percentile, but this matches the
-- Rockset query most closely
with tts as (
    SELECT
        DATE_DIFF(
            'second',
            workflow.created_at,
            workflow.updated_at
        ) as duration_sec,
        name,
    FROM
        default.workflow_run workflow final
    WHERE
        conclusion = 'success'
        AND lower(workflow.name) in {workflowNames: Array(String)}
        AND workflow.created_at >= {startTime: DateTime64(3)}
        AND workflow.created_at < {stopTime: DateTime64(3)}
        AND workflow.run_attempt = 1
), tts_by_name as (
  SELECT
    quantileExact({percentile: Float32})(tts.duration_sec) as duration_sec
  FROM tts
  group by name
)
select max(duration_sec) as duration_sec from tts_by_name
