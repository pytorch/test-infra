-- !!! Query is not converted to CH syntax yet.  Delete this line when it gets converted
SELECT * FROM torchbench."torchbench-userbenchmark"
  WHERE name = :userbenchmark 
  AND REGEXP_LIKE("torchbench-userbenchmark".environ.pytorch_git_version, :commit);