# HUD API

`app/api/` holds the HUD API: endpoints built on `lib/api/` and described by
the generated [OpenAPI document](https://hud.pytorch.org/api/openapi.json).
Every route under `app/api/` except the document's own is in that document,
and every documented path is a route here. The endpoints under `pages/api/`
predate it: they are not in the OpenAPI document and follow none of the
conventions below. New endpoints go here, whatever their domain.

This file is for the people who work on the API: how to evolve it and where
things go. The OpenAPI document is the reference for parameters, defaults,
response fields and errors. It is generated from the zod schemas used by the
handlers; keep those descriptions current instead of repeating them here.

## Best Practice

The API is unversioned. Change an endpoint and its consumers together instead
of keeping the old behavior next to the new. The document changes with the
code, and its `info.version` names the deployed commit.

Cursors outlive deploys in open pages: clients treat them as opaque, so their
internals may change, but a cursor the current code cannot read must be
rejected with 400, never misread.

## Moving an endpoint here

A `pages/api/` endpoint joins the API by moving onto `lib/api/`: give it a
parameter registry, zod response schemas and a handler built on
`lib/api/handler.ts`, register it in `lib/api/openapi.ts`, and move its route
from `pages/api/<path>.ts` to `app/api/<path>/route.ts` so its URL stays the
same. Next.js refuses to build while both routers serve a path, so delete the
old route in the same change.

## Conventions for new endpoints

- A route is `app/api/<resource>/route.ts`, with a `[name]` folder for each
  path parameter, and only exports `GET` and `dynamic = "force-dynamic"`,
  which keeps Next.js from running it at build time. Next.js answers HEAD by
  running `GET` and dropping the body, OPTIONS with 204, and the other
  standard methods with an empty 405.
  Queries, schemas and handlers go in `lib/api/<resource>/`, so the library
  tree mirrors the routes without their path parameters:
  `lib/api/tests/test/runs/` implements `/api/tests/test/{test_id}/runs`.
- Name a path parameter after what it identifies and keep that name in every
  path that carries it: `test/[test_id]/route.ts` and
  `test/[test_id]/runs/route.ts` serve `/api/tests/test/{test_id}` and
  `/api/tests/test/{test_id}/runs`.
- Parameters are defined once in `lib/api/<resource>/parameters.ts`:
  validation, URL encoding, normalization, descriptions, and the allowed SQL
  column/type mappings. Shared mechanics in `lib/api/parameters.ts` build
  strict schemas, decode query values, normalize repeated values, validate
  sort syntax and generate OpenAPI serialization hints.
  Each resource keeps its own fields, defaults and descriptions in its registry,
  which also drives exact SQL predicates and cursor query identity. Add or
  rename a filter there; do not copy parameter lists into handlers or docs.
  Response schemas live in `types.ts`, with a `describe()` on every field.
  TypeScript types are inferred from the schemas, and
  `lib/api/<resource>/openapi.ts` contributes paths and schemas to
  `/api/openapi.json` through `lib/api/openapi.ts`. Component names are unique
  across the document; reuse a schema when endpoints return the same object,
  and tag each operation with its domain (`tests`).
- Public filter names map to ClickHouse columns through the parameter
  registry. 64-bit ids are decimal strings; timestamps are ISO 8601 in UTC.
- Validate every parameter and answer 400 with `{ "error": "..." }`, including
  the parameter path in validation messages; log and answer 500 with the same
  error shape and no details when a query fails. `lib/api/handler.ts` reads
  path and query parameters into one raw query (`requestQuery`), implements
  these responses and the paginated list flow, and its `errorResponses()`
  documents them; build handlers on it.
- Lists are cursor paginated with `limit` and `cursor` in, `next_cursor` out.
  Cursors bind the resource and normalized query, excluding page size;
  `lib/api/cursor.ts` holds the token format and that identity rule. Pages
  read current data, so changes between requests may skip or repeat entries;
  pagination does not enumerate a fixed snapshot.
- Tests mirror the code: `test/api/<resource>/<module>.test.ts` for each
  module, mocking `queryClickhouse`, with shared rows in a `fixtures.ts`
  beside them. Call a route's `GET` through `callRoute` in
  `test/api/routes.ts`. Add the endpoint to the list below.

## Endpoints

`GET /api/openapi.json` serves the generated OpenAPI 3.1 document from
`app/api/openapi.json/route.ts`. Register each new resource in
`lib/api/openapi.ts` so its paths and schemas appear in the document;
`test/api/openapi.test.ts` fails while a route is missing from it.

| Endpoint                                      | Scope                                                                           | Implementation             |
| --------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------- |
| `GET /api/tests`                              | Repository tests and configuration health in a selected window and code sources | `lib/api/tests/`           |
| `GET /api/tests/test/{test_id}`               | One catalog test, its owners, and all available configuration health            | `lib/api/tests/test/`      |
| `GET /api/tests/test/{test_id}/runs`          | Retained runs of one test, bundled with their attempts                          | `lib/api/tests/test/runs/` |
| `GET /api/tests/run/{run_id}`                 | One full run bundle, selected by any retained execution UUID                    | `lib/api/tests/run/`       |
| `GET /api/tests/commit/{sha}?repo=owner/name` | Retained run bundles across all tests on a repository commit                    | `lib/api/tests/commit/`    |

## Tests endpoints

The tests endpoints read the test hub tables from the database named by
`CI_DATABASE` in `lib/api/tests/database.ts`; never hardcode a database name
in a query.

### Test health

The list returns one entry per test, environment and env var set. Health
combines only the selected code sources for that configuration. Workflow-path
filtering selects configurations but does not narrow their aggregated health
to matching workflows. The detail endpoint reuses the catalog and health
shapes, returning every observed configuration, window and code source without
pagination. It keeps windows separate because they overlap, and keeps code
sources separate. A known test without health is distinct from an unknown test.

Health refresh timestamps come from the selected rows. An empty list performs
a separate lookup of the current refresh timestamp; this fallback does not
establish a snapshot. Existing cursors remain usable after a health refresh.

### Runs and attempts

The test-runs and commit-runs endpoints share parameter definitions, run record
schemas, filtering, sorting, pagination and metadata expansion in
`lib/api/tests/test/runs/`. Keep scope selection in each endpoint: a test ID
for one, and commit membership for the other. Their cursor resources remain
distinct, and commit pagination additionally uses the test ID to break ties
across tests.

One run record bundles executions with the same `tests_id`, `environments_id`,
`env_vars_id` and `github_workflow_job_id`. Its shared catalog and workflow
metadata appears once; `attempts` holds the initial execution and every subsequent
execution, including intentional repetitions. Each attempt keeps its execution
`id`, `report`, `rerun_number`, outcome, outcome summary and timestamps. Order
attempts by `started_at`, `ended_at` and `id` ascending. A bundle can span reports,
and the reporter's `rerun_number` can reset when a new report starts.

`GET /api/tests/run/{run_id}` accepts any retained `attempts[].id` and returns its
full bundle with the same attempts, catalog and workflow objects, plus query
timing. An unknown or expired execution UUID returns 404. The detail lookup and
both lists share metadata expansion in `test/runs/mapping.ts`.

Both lists reuse the test list's catalog shapes and owners. Form bundles before
pagination so `limit` counts bundles and a bundle never crosses a page boundary.
Outcome and `rerun_number` filters must match the same deduplicated execution;
return every attempt in a selected bundle, including those that do not match.
Configuration and workflow filters select bundles using their shared metadata.
For sorting, `started_at` is the earliest attempt start and `ended_at` the latest
attempt end; `outcome` and `rerun_number` come from the last attempt in chronological
order. Bundle identity fields break ties. Version 2 cursors encode this ordering;
reject version 1 cursors with 400 because they paginated individual executions.

Return each execution as `FINAL` would: mutable outcome, end-time and cursor
predicates must apply after replacement deduplication so an older version cannot
reappear. Missing catalog or workflow metadata must not remove a bundle unless
a requested filter excludes it.

After selecting a page, a batched request loads all attempts for only the returned
bundles, excluding the pagination lookahead. Catalog and workflow details are
loaded in two concurrent batched requests. An empty page skips all three requests.
The detail endpoint first resolves an execution UUID, then loads its bundle's
attempts and shared metadata. The commit endpoint also aggregates total
and per-outcome counts into `stats` for every retained individual execution in the requested
repository and commit. One independent request starts concurrently with the page
query and shares its commit membership and replacement deduplication rules; it
classifies the executions in a single pass, so no execution is counted twice.
Statistics count the initial execution and every attempt, rather than bundles.
Search, run filters including outcome, cursor, limit and ordering affect only
the runs list. Statistics and the page can observe different data during updates.
Both endpoints measure `query_duration_ms` as the sum of their individually
rounded request durations, including commit statistics and client, network and
decoding overhead. Overlapping requests mean this sum can exceed wall-clock time.
SQL construction, mapping, cursor encoding and API transport are outside that
measurement.

Expanded catalogs and owners reflect current data. Workflow metadata uses the
latest retained record for each job or workflow run; workflow path and SHA are
shared across attempts, while the job URL and name identify the job that
produced the run. Metadata is assembled into the shared `github_workflow`
object. Preserve the partial-metadata behavior when changing the batch lookups:
known job information remains available even if the workflow run record is
missing.

### Commit membership and performance

Commit membership follows `default.workflow_run.head_sha` and repository through
workflow job associations. A pull-request job may record a different merge SHA,
so do not additionally filter by its SHA. Include all matching workflow and job
attempts, without a branch, event or arbitrary time restriction.

The commit query computes job IDs in a scalar subquery reused within the request.
A named table CTE would expand at each reference and repeat expensive metadata
scans; this is not an application cache, and every request discovers current
membership.

The runs table's `by_job` projection stores every replacement version and cannot
be read with `FINAL`. Bundle selection can use it when replacements cannot change
group membership or ordering: group IDs, the earliest start, catalog and workflow
fields, and matching a `rerun_number` filter. Outcome filters and ordering by
outcome, end time or the last attempt's number require `FINAL`. Attempt expansion
always uses `FINAL`; statistics retain their exact replacement resolution by test
start. Grouping by configuration and job must not merge different test IDs or
silently drop attempts from separate reports.
Page selection and attempt expansion are separate reads of current data, so newly
ingested attempts or replacements may change a bundle between those reads.

The live service runs the old analyzer. It materializes a tuple-typed scalar as
one value, which fails above 1,000,000 elements, so return arrays from scalar
subqueries. It copies the WITH clause into every subquery, so keep each IN set
one subquery level deep and keep predicate pushdown from copying page filters
into union branches. Do not ask a `by_job` read for DISTINCT `tests_id`, which
reads the main table in its sorting-key order instead.

Use [Tests API SQL validation](../../lib/api/tests/query-validation.md) for
current defaults, checked-in query evidence and the reproducible validation
command. The [commit notes](../../lib/api/tests/commit/query-validation.md)
and other notes beside the queries record earlier design experiments; their
measurements are historical. Preserve the correctness guarantees and measure
working-tree SQL with fixed, nonempty inputs when evaluating a rewrite.
