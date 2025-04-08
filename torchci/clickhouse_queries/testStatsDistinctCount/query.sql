SELECT count(DISTINCT *) AS count
FROM
    tests.distinct_names t
WHERE
    t.name LIKE {name: String}
    AND t.classname LIKE {suite: String}
    AND t.file LIKE {file: String}
