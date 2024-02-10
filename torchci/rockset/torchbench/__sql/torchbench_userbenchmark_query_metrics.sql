SELECT * FROM torchbench."torchbench-userbenchmark"
  WHERE name = :userbenchmark 
  AND REGEXP_LIKE("torchbench-userbenchmark".environ.pytorch_git_version, :commit);