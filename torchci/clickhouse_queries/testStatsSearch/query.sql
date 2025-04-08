SELECT
    t.name,
    t.classname,
    t.file,
    t.invoking_file,
    maxMerge(t.last_run) AS last_run
FROM
    tests.distinct_names t
WHERE
    t.name LIKE {name: String}
    AND t.classname LIKE {suite: String}
    AND t.file LIKE {file: String}
GROUP BY
    t.name,
    t.classname,
    t.file,
    t.invoking_file
ORDER BY
    t.name, t.classname, t.file, t.invoking_file
LIMIT
    {per_page: Int}
    OFFSET
    {offset: Int}
