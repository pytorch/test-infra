## torchci ClickHouse queries

When you work on a ClickHouse query in the top-level `torchci/` directory
(`clickhouse_queries/` or SQL inline in code), ALWAYS invoke the `pytorch-clickhouse`
skill first. If you cannot invoke it, read `.claude/skills/pytorch-clickhouse/SKILL.md`
at the repository root.

When you change a query's SQL, you MUST also:

- Optimise it. EXPLAIN it and time the SQL from your working tree over several
  alternating runs, before and after each rewrite. Named-query tools run the deployed
  version, not yours. Stop when no rewrite beats run-to-run noise.
- IMPORTANT: never trade correctness for speed. No new approximate functions, no
  narrower time ranges. Show that the optimised query returns the same rows as the
  baseline (the original query plus only the functional change you were asked for) on
  fixed parameters that return rows. If they differ, keep the baseline and say so.
- If you cannot run queries, make only the requested change and say it is unoptimised
  and unverified. Never claim a speedup or an equivalence you did not measure.
