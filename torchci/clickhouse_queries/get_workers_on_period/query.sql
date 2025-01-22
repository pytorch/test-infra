SELECT DISTINCT qts.machine_type AS machine_type
FROM
    misc.queue_times_24h_stats qts
WHERE
    qts.time >= TODATETIME({startTime: DateTime64(3)}, {timezone: String})
    AND qts.time < TODATETIME({stopTime: DateTime64(3)}, {timezone: String})
    AND qts.machine_type != ''
ORDER BY
    qts.machine_type ASC
