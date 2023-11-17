WITH w AS (
  SELECT ARBITRARY(name) AS name, "torchbench-userbenchmark".environ.pytorch_git_version as pytorch_git_version,
  ARBITRARY("torchbench-userbenchmark".environ.pytorch_version) as pytorch_version,
  FROM torchbench."torchbench-userbenchmark"
  WHERE name = :userbenchmark
  GROUP BY "torchbench-userbenchmark".environ.pytorch_git_version
),
s AS (
  SELECT push._event_time as pytorch_commit_time, push.head_commit.id as sha from push
)
SELECT name, pytorch_git_version, pytorch_version, s.pytorch_commit_time FROM w
INNER JOIN s ON w.pytorch_git_version = s.sha
  ORDER BY s.pytorch_commit_time DESC;