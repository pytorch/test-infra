# Runs grouped by commit: SQL validation

`GET /api/tests/test/{test_id}/runs?group_by=commit` answers one grouped read
of a test's runs (`buildRunGridQuery` in `grid-query.ts`): the runs by their
primary key through `FINAL`, every key-column filter in `PREWHERE` so each
selected attempt keeps every version, joined to the latest retained
`workflow_job` and `workflow_run` rows of the selected jobs, read as the
bundle pages read them (`workflow-query.ts`: `FINAL`, newest first, one row
per id), and grouped by commit, calling workflow path, environment, env var
set and job: one row per job's chain of attempts, with the job's own URL and
name (`any()`, exact since the jobs read keeps one row per id), its attempts
in chronological order, its final outcome by the bundle rule and its executed
and passed time. The handler folds a cell's jobs (`foldCell` in `grid.ts`):
jobs of one name are a retry sequence, jobs of different names are siblings
and the worst decides, the passed time is the mean over the sequences that
passed. The lanes' catalog records come from one batched bundle catalog
lookup (`lookupRunCatalog` in `catalog.ts`) covering each distinct
configuration.

The `ran_on` filter classifies a job's runs as the health view does in
`clickhouse_db_schema/ci/000002-health-materialized-view.sql`: a push or
schedule on `main` is main; a pull request, or a push to a `ciflow/` tag, is a
pull request's; a `rerun_disabled_tests` job and anything else is neither.
Measured on 2026-10-28 for the test below, 80 of the 108 timed-out
inductor.yml pushes in a week were ciflow tag pushes, so a client cannot read
main off `github_workflow.event`; the classification has to happen here. The
`window` holds jobs, not attempts: the jobs whose first attempt of the test
started in it, with every attempt of those jobs, as the health table assigns
a run to its windows (`A run counts when refreshed_at - duration <=
first_attempt.started_at`). Its start is bound as a Unix millisecond
timestamp the handler computes from the request time, so the statement
itself is deterministic and replays; the chains are read from a day before
it (`chains_since`, `CHAIN_REACH_MS`), far enough back for every attempt of
a job that has one in the window, and the jobs whose first attempt is older
go in `HAVING`.

The [evidence bundle](grid-query-validation.json) records three cases on test
`10798099672608881194` (`test/inductor/test_flex_decoding.py`,
`TestFlexDecodingCPU`, 13 configurations over four workflows): main over
seven days, every code source over three days, and main over seven days
narrowed to two workflows, two Python versions and two configs. For each,
the raw request, the fixed window start, the generated SQL and bindings, the
`EXPLAIN indexes = 1` and `EXPLAIN ESTIMATE` plans, four alternating rounds
of timing against the one rewrite considered, and a summary of the rows:
their count in chains and in cells, their commits, a digest, and each lane's
chains by their job's final outcome.

## The window holds jobs (2026-10-29)

Until 2026-10-29 the window bounded the attempts: every read, the two job
discoveries and the chains read, kept the attempts that started at or after
the window's start. A job whose first attempt started before the window and
whose rerun started inside it was then read from its rerun alone, a cut
chain. On the recorded test, with the window started at 06:00:09 on
2026-10-27, between the attempts of two jobs that had hung for thirty
minutes and skipped on their rerun, the cut statement answered both as
`skipped` with one attempt, so the page would have drawn a skip where the
test had timed out; the same cut would read a job that failed and passed on
its rerun as a plain pass, and left the failed attempt out of the whole
spend. The statement now finds the jobs with an attempt in the window as
before (the two metadata reads are unchanged), reads the chains from a day
before the window, since a job's attempts span hours at most (GitHub ends a
job after six hours on its own runners, the repository's longest after ten),
and drops the jobs whose first attempt is older in `HAVING`: a chain is whole
or absent, and the window counts a run where the health table counts it.

The change was checked against the statement it replaced on the three
recorded cases with the recorded window starts, both chains reads bounded
above by the same instant a day back: the rows were identical, 3,055, 8,738
and 1,530 chains, since no job of the test straddled those window starts;
on the boundary case above, the new statement left out exactly the two cut
chains and nothing else (5,163 of the old 5,165 rows, the two shown whole by
the statement without its `HAVING` as `timed_out, skipped` starting before
the window). Four alternating rounds timed the two statements within the
run-to-run spread of a busy server (0.52 to 2.0 s old against 0.57 to 1.9 s
new for the week of main, 0.54 to 1.6 against 0.59 to 3.5 s for three days
of every source, 0.70 to 3.3 against 0.75 to 4.0 s narrowed), reading the
same rows and bytes (3,588,533 rows for the week of main both ways, 2.8%
more for three days of every source) at the same peak memory. Two shapes
were rejected on the way: reading the chains from the retention's start
instead of a day before the window lost the partition pruning (every part
considered against 53 of 102) and took half as long again; and a third read
of the window's job ids in the chains read's `PREWHERE`, so the `FINAL` read
kept only their attempts before the join, read 18% more rows and was slower
than letting the inner join to the `jobs` read keep them.

## One row per job (2026-10-29)

Until 2026-10-29 the statement grouped by commit, workflow path and
configuration alone, folding every job's attempts into one chronological
list with a job count and the decisive attempt's job. On commit `b8c7d2c25`
that read `timed_out, skipped, skipped` for the Python 3.13 inductor_core
lane: shard 2 hung for thirty minutes and its rerun skipped, and shard 1, a
sibling job, skipped on its own in between, which the page drew as a timeout
rerun twice. Both inductor_core shards run the same tests (pytorch's
`test_inductor_core` passes no `--shard`), so 240 of that lane's 241 cells
fold two jobs. The grouping now keeps each job's chain apart and the handler
decides the cell from the chains.

The change was checked against the statement it replaced on the three
recorded cases, both bounded above by the same instant a day back (a test's
rows land when its job ends, hours after it ran, so two open-ended reads
seconds apart differ by the rows that landed between them; ten minutes back
was not enough). Folding the new rows by the old rules, the last executed
attempt across every job, the summed times, the job count and that attempt's
job, reproduced every old row: 2,401, 6,024 and 1,114 cells, of which 566,
2,221 and 374 fold two or more jobs, and every single-job cell's attempt
list in the same order. Four alternating rounds timed the old statement at
0.76 to 1.00 s against the new at 0.64 to 0.94 s for the week of main (peak
memory 168 against 208 MB, the extra groups), 0.49 to 0.56 s against 0.54 to
0.67 s for three days of every source, and 0.85 to 2.52 s against 0.71 to
1.59 s narrowed, all inside the run-to-run spread, so no rewrite of the new
statement was sought beyond the one below. That comparison was a one-off
against the superseded builder and is not in the bundle, which records only
the kept statement against the FINAL-less rewrite; its timings are from an
earlier run than the Measurements section's.

## Measurements (2026-10-29, ClickHouse Cloud 26.6.1)

The chains read prunes to the test: 161 of 653,924 granules of `ci.runs` for
a week of main, by `tests_id` and `started_at`. The two metadata reads prune
by id set: 334 of 32,435 granules of `workflow_job` and 167 of 14,795 of
`workflow_run`. Server time for the week of main, 3,055 chains in 2,474
cells over 196 commits, was 0.52 to 0.86 s over four alternating rounds,
reading about 3.6 million rows, peak memory 186 MB; 0.49 to 0.58 s for
three days of every source (8,775 chains, 6,332 cells, 1,047 commits) and
0.57 to 0.70 s narrowed (1,530 chains, 1,147 cells).

One rewrite was measured: the two metadata reads without `FINAL`, since their
`ORDER BY _inserted_at DESC ... LIMIT 1 BY id` already keeps one newest row
per id. It returned the same rows in every case (equal digests, asserted by
the replay) and lowered peak memory (186 to 95 MB for the week of main), but
its time, 0.51 to 0.73 s against 0.52 to 0.86 s there and 0.45 to 0.65
against 0.49 to 0.58 s and 0.59 to 0.61 against 0.57 to 0.70 s elsewhere, is
inside the run-to-run spread. The `FINAL` version is kept so the grid reads
a job's metadata exactly as the bundle pages read it; the replay keeps
comparing the two.

The query is not tagged with the heavy-query profile: it answers in about a
second at a few threads, far under the ten CPU-seconds the profile is for
(`app/api/README.md`, Heavy queries).

## Reproduce

Run from `torchci/`:

```sh
node scripts/validateRunGridQuery.cjs
node scripts/validateRunGridQuery.cjs --live > grid-validation.json
```

Without `--live` the script regenerates each case from the working-tree
builder and fails when the SQL or bindings differ from the bundle; `yarn test`
runs it that way. With `--live` it needs `CLICKHOUSE_HUD_USER_*` in
`.env.local`, records the working tree's SQL and writes a new bundle to
replace the checked-in one after a query change. The statements it times and
compares are bounded above by one instant a day before the run (`until_ms`
in each case) wherever they bound the attempts below, the two job reads and
the chains read, so the two variants read the same rows; the recorded SQL is
the production statement, open-ended as the handler sends it.
