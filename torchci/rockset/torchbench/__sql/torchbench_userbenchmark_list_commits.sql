SELECT ARBITRARY(name) AS name, "torchbench-userbenchmark".environ.pytorch_git_version as pytorch_git_version
  FROM torchbench."torchbench-userbenchmark"
  WHERE name = :userbenchmark
  GROUP BY "torchbench-userbenchmark".environ.pytorch_git_version;
