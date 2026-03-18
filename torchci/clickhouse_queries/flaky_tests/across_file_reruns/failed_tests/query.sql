select
    DISTINCT name,
    file,
    invoking_file,
    classname
from
    default .test_run_s3
where
    (
        LENGTH(failure) != 0
        or LENGTH(error) != 0
    )
    and file != ''
    and time_inserted > (CURRENT_TIMESTAMP() - interval {numHours: Int64} hour)
