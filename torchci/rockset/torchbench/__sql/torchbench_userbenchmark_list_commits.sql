WITH w AS (
  SELECT ARBITRARY(name) AS name, "torchbench-userbenchmark".environ.pytorch_git_version as pytorch_git_version,
  ARBITRARY("torchbench-userbenchmark".environ.pytorch_version) as pytorch_version,
  FROM torchbench."torchbench-userbenchmark"
  WHERE name = :userbenchmark
  AND "torchbench-userbenchmark".environ.pytorch_version IS NOT NULL
  GROUP BY "torchbench-userbenchmark".environ.pytorch_git_version
)
SELECT name, pytorch_git_version, pytorch_version, REGEXP_EXTRACT(pytorch_version, 'dev([0-9]+)', 1) AS pytorch_nightly_date FROM w
  ORDER BY pytorch_nightly_date DESC;