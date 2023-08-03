-- Used to power the kpi dashboard. 
-- This collection is populated via the metrics.compute_ttrs_kpi lambda  

SELECT
    *
FROM
    pytorch_dev_infra_kpis.ttrs_percentile
WHERE 1 = 1
    AND DATE_PARSE(bucket, '%Y-%m-%d') >= PARSE_DATETIME_ISO8601(:startTime)
    AND DATE_PARSE(bucket, '%Y-%m-%d') <= PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY _event_time desc