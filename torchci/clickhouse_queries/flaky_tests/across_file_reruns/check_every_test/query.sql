select
    name,
    classname as suite,
    file,
    invoking_file,
    job_id,
    1 as numGreen,
    SUM(LENGTH(rerun)) as numRed,
    any(rerun[1].'text') as sampleTraceback
FROM
    default.test_run_s3
where
    name = {name: String}
    and classname = {classname: String}
    and invoking_file = {invoking_file: String}
    and file = {file: String}
    and LENGTH(skipped) = 0
    and time_inserted > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
GROUP BY
    name,
    suite,
    file,
    invoking_file,
    job_id
HAVING
    -- succeded at least once
    MIN(LENGTH(failure) + LENGTH(error)) = 0
    -- failed completely at least once
    and MAX(LENGTH(failure) + LENGTH(error)) != 0
