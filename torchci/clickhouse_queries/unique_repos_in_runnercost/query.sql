SELECT DISTINCT rc.group_repo AS repo
-- count(rc.group_repo) as count
FROM
    misc.runner_cost rc
WHERE
    rc.date > {startTime: DateTime64(9)}
    AND rc.date < {stopTime: DateTime64(9)}
GROUP BY
    repo
ORDER BY
    count(rc.group_repo) DESC
