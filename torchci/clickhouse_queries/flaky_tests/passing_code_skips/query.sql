-- Code skips that cleared the same bar used to close a DISABLED issue:
-- last 7 days, at least {min_num_green} greens, summed reds = 0, and no
-- individual failing row (num_red > 0) in that window.
-- A row is a pass when num_green > 0 and num_red = 0, a fail when num_red > 0,
-- and still skipped when both are 0. Still-skipped rows add nothing.
--
-- Sums are named total_* inside the grouping query so HAVING/WHERE cannot
-- confuse them with the per-row num_green / num_red columns.
SELECT
    name,
    classname,
    filename,
    code_skips,
    total_green AS num_green,
    total_red AS num_red
FROM
    (
        SELECT
            name,
            classname,
            filename,
            groupUniqArray(code_skip) AS code_skips,
            sum(num_green) AS total_green,
            sum(num_red) AS total_red,
            countIf(num_red > 0) AS failing_rows
        FROM
            (
                SELECT
                    r.name AS name,
                    r.classname AS classname,
                    r.filename AS filename,
                    r.code_skip AS code_skip,
                    r.num_green AS num_green,
                    r.num_red AS num_red
                FROM
                    default.rerun_disabled_code_skips AS r
                    LEFT JOIN default.workflow_run AS w FINAL ON r.workflow_id = w.id
                WHERE
                    w.created_at > CURRENT_TIMESTAMP() - INTERVAL 7 DAY
            )
        GROUP BY
            name,
            classname,
            filename
    )
WHERE
    total_green >= {min_num_green: Int64}
    AND total_red = 0
    AND failing_rows = 0
