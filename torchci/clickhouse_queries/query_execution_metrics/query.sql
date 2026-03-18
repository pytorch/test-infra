SELECT
    round(avg(query_duration_ms)) AS realTimeMSAvg,
    sum(query_duration_ms) as realTimeMSTotal,
    round(quantile(0.5)(query_duration_ms)) as realTimeMSP50,
    avg(memory_usage) as memoryBytesAvg,
    sum(memory_usage) as memoryBytesTotal,
    quantile(0.5)(memory_usage) as memoryBytesP50,
    count(*) as num,
    left(query_id, -37) as name
FROM
    clusterAllReplicas(default, default.all_query_logs)
where
    -- for partitioned tables
    toYYYYMM(event_date) >= toYYYYMM({startTime: DateTime64(3)})
    and toYYYYMM(event_date) <= toYYYYMM({stopTime: DateTime64(3)})
    -- utilize the table ordering
    and event_date >= toDate({startTime: DateTime64(3)})
    and event_date <= toDate({stopTime: DateTime64(3)})
    and event_time >= {startTime: DateTime64(3)}
    and event_time < {stopTime: DateTime64(3)}
    and initial_user = 'hud_user'
    and length(query_id) > 37
    and type = 'QueryFinish'
    and left(query_id, -37) != 'adhoc'
group by
    name
order by num desc
