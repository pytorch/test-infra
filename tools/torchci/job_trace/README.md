# job_trace

Writes a [Perfetto](https://ui.perfetto.dev) trace (Chrome Trace Event JSON) of
CI test jobs from `ci.runs`. Each job is a process with a `job` track (the job
and its steps) and `lane N` tracks holding test processes, nested
file > suite > case.

## Usage

```bash
cd tools
python -m torchci.job_trace 124753274485 124753274451 -o trace.json.gz --open
```

- Job ids are `workflow_job.id`, the number after `/job/` in a job link. Pass
  several, separated by spaces (e.g. `$(cat ids.txt)`); they share one timeline,
  one process each, in the order given.
- `--owner X` keeps only files whose `ci.owners` entry lists `X` (e.g.
  `inductor`). Report slices always carry an `owners` arg.
- `--open` serves the trace once on `127.0.0.1:9001` and opens it in
  ui.perfetto.dev, which processes it in the browser. Don't use the UI's share
  button: it uploads the trace.
- Needs `CLICKHOUSE_ENDPOINT`, `CLICKHOUSE_USERNAME` and `CLICKHOUSE_PASSWORD`.
  `ci.runs` keeps 14 days.

## Reading the trace

- A lane holds one test process (`report_uuid`) at a time, so a job has as many
  lanes as it ran processes at once. A process whose tests overlap (C++
  binaries, xdist) is split into one slice per test, with `file` and `suite`
  as args.
- Test case slices have their outcome as category. Paste `test_cases.sql` into
  the Query (SQL) page for a `test_cases` view, e.g.
  `select * from test_cases where seconds > 300 order by dur desc`.
- Times are whole milliseconds. Events tied within one are spread 1 µs apart so
  slices nest; tests under 1 ms show as a few µs.
- Not drawn: process startup and collection, and processes that ran no test.

## Tests

`cd tools/torchci && pytest tests/job_trace`. The traces in
`tests/job_trace/fixtures/` are toy examples you can open in Perfetto.
