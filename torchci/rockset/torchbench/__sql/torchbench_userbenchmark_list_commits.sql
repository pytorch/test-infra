SELECT *, name, environ 
FROM torchbench."torchbench-userbenchmark"
WHERE name = :userbenchmark;
