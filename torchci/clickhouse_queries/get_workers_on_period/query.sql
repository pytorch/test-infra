SELECT
    DISTINCT(qts.machine_type) AS machine_type
FROM
    misc.queue_times_24h_stats qts
WHERE
    qts.time >= Date('2023-11-08')
    AND qts.time < Date('2024-11-08')
    AND qts.machine_type != ''
ORDER BY
    qts.machine_type ASC
