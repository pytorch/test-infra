WITH w AS (
    SELECT
        any(name) as name,
        JSONExtractString(environ, 'pytorch_git_version') as pytorch_git_version,
        any(JSONExtractString(environ, 'pytorch_version')) as pytorch_version
    FROM
        benchmark.torchbench_userbenchmark
    WHERE
        benchmark.torchbench_userbenchmark.name = {userbenchmark: String }
    GROUP BY
        pytorch_git_version
),
s AS (
    SELECT
        push.head_commit.timestamp as pytorch_commit_time,
        push.head_commit.id as sha
    from
        default .push
)
SELECT
    name,
    pytorch_git_version,
    pytorch_version,
    s.pytorch_commit_time
FROM
    w
    INNER JOIN s ON w.pytorch_git_version = s.sha
ORDER BY
    s.pytorch_commit_time DESC
