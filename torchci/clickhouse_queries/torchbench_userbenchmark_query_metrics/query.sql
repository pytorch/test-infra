SELECT
    *
FROM
    benchmark.torchbench_userbenchmark
WHERE
    name = {userbenchmark: String }
    AND match(
        JSONExtractString(environ, 'pytorch_git_version') as pytorch_git_version,
        {commit: String }
    )
