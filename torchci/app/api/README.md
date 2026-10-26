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

## Authentication

Every route under `app/api/` except the OpenAPI document is behind the shared
HUD GitHub gate in `lib/auth/githubAuth.ts`, the one `gcx-token` uses: the
caller's GitHub token must belong to a user with write access to
pytorch/pytorch, or on the allow list in `lib/auth/allowList.json`. The token
comes from an `Authorization: Bearer <token>` header, else from the HUD
session a signed-in browser sends. `lib/api/auth.ts` implements this: a route
exports `GET = requireGithubWriteAccess(handler)`, a token that passed is
remembered for five minutes, and `test/api/auth.test.ts` checks that every
route refuses an anonymous request. The gate answers 401 `unauthenticated`
with a `WWW-Authenticate: Bearer` challenge and 403 `forbidden`, and remembers
a refusal for a minute so bad tokens do not become GitHub requests; GitHub
rate limiting HUD is 503 `unavailable` with `Retry-After`, and GitHub being
otherwise unreachable 500 `internal_error`. On a preview deployment the
preview login's session passes the gate, since that login has no GitHub token
and the preview password is the gate there. Under `next dev` the gate stands
open, so a local checkout works without a sign-in, for whoever can reach the
dev server (bind it with `-H 127.0.0.1` on a shared machine);
`HUD_API_REQUIRE_AUTH=1` enforces it locally, any value but an explicit no
does, and a production build always does. Its refusals are `no-store`, and it marks
every handler answer `private` (or `no-store` when the handler set no
`Cache-Control`), so a shared cache never serves one caller's answer to the
next; a handler that wants the browser to keep its answer says `private` and
`Vary: Authorization, Cookie` itself, as `/api/tests/options` does. The document declares the scheme once
under `security`, and `errorResponses()` documents the statuses on every
operation.

CLI and agent callers that the Vercel bot challenge blocks use the same path
under `/api/authed/` (`pages/api/authed/[...path].ts`), which runs the same
gate from the same memory and forwards the request, token included, naming
the caller's path in `x-forwarded-path` so that `handleList` builds page links
under `/api/authed/` for them; the answer comes back with its cache, challenge
and retry headers.

## Moving an endpoint here

A `pages/api/` endpoint joins the API by moving onto `lib/api/`: give it a
parameter registry, zod response schemas and a handler built on
`lib/api/handler.ts`, register it in `lib/api/openapi.ts`, and move its route
from `pages/api/<path>.ts` to `app/api/<path>/route.ts` so its URL stays the
same. Next.js refuses to build while both routers serve a path, so delete the
old route in the same change.

## Conventions for new endpoints

- A route is `app/api/<resource>/route.ts`, with a `[name]` folder for each
  path parameter, and only exports `GET`, the handler wrapped in
  `requireGithubWriteAccess`, and `dynamic = "force-dynamic"`, which keeps
  Next.js from running it at build time. Next.js answers HEAD by
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
- Every documented error includes a human-readable `error` string and a stable
  `code`. Clients branch on `code`, not message wording. The gate's
  `unauthenticated` and `forbidden` come before any parameter is read. Validate every parameter
  and answer 400 with `code: "invalid_parameters"` and
  `issues: [{ "path": ["parameter", 0], "message": "..." }]`. Each issue path
  contains parameter or nested field names and numeric array indexes; an empty
  path describes the request as a whole. Return all collected validation issues,
  while preserving the first issue, including its path, in `error`. Malformed
  JSON or another parameter-decoding error can stop validation before other
  invalid parameters are examined.
- Answer 400 with `invalid_cursor` when a cursor cannot be decoded or is for
  another resource, and `cursor_query_mismatch` when its normalized query does
  not match the request. Use `not_found` for 404. Log query failures and answer
  500 with `internal_error` and a generic message. These errors omit `issues`.
  `lib/api/handler.ts` reads path and query parameters into one raw query
  (`requestQuery`), implements these responses, the paginated list flow
  (`handleList`) and the detail flow (`handleDetail`), and its
  `errorResponses()` documents them; build handlers on it.
- Lists are cursor paginated with `limit` and `cursor` in, and
  `pagination: { "next": { "cursor": "...", "url": "..." }, "previous": null }`
  out. Both directions are always present: `previous` is null at the beginning,
  and `next` is null at the end. Clients can follow either link's relative `url`,
  resolved against the response URL, or pass its `cursor` with the same filters
  and ordering. Build each URL from the request's path and query, retaining
  repeated parameters and page size while replacing only `cursor`.
  Cursors encode their direction and bind the resource and normalized query,
  excluding page size; `lib/api/cursor.ts` holds the token format and identity
  rule; `lib/api/seek.ts` builds the keyset predicate and `ORDER BY` from a
  list's sort keys, and `queryPage` in `lib/api/pagination.ts` runs the page
  query with its boundary probe. Clients may change `limit` in either direction. A previous-page request
  returns up to that many entries immediately before the cursor boundary;
  responses always retain the requested sort order.
  Pages read current data, so changes between requests may skip or repeat
  entries; pagination does not enumerate a fixed snapshot. An empty page has
  both links null; omit `cursor` to restart from the beginning.
- Tests mirror the code: `test/api/<resource>/<module>.test.ts` for each
  module, mocking `queryClickhouse`, with shared rows in a `fixtures.ts`
  beside them. Call a route's `GET` through `callRoute` in
  `test/api/routes.ts`. Add the endpoint to the list below. The offline
  replay of every SQL evidence bundle runs under jest too
  (`test/scripts/validateQueries.test.ts`); a query change re-records its
  bundle, as the validation notes describe.

## Endpoints

`GET /api/openapi.json` serves the generated OpenAPI 3.1 document from
`app/api/openapi.json/route.ts`. Register each new resource in
`lib/api/openapi.ts` so its paths and schemas appear in the document;
`test/api/openapi.test.ts` fails while a route is missing from it.

| Endpoint                                      | Scope                                                                              | Implementation             |
| --------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| `GET /api/tests`                              | Repository tests and configuration health in a selected window and code sources    | `lib/api/tests/`           |
| `GET /api/tests/options`                      | The values the list offers a reader: fixed choices and catalog values, with labels | `lib/api/tests/options/`   |
| `GET /api/tests/test/{test_id}`               | One catalog test, its owners, and all available configuration health               | `lib/api/tests/test/`      |
| `GET /api/tests/test/{test_id}/runs`          | Retained runs of one test, bundled with their attempts                             | `lib/api/tests/test/runs/` |
| `GET /api/tests/run/{run_id}`                 | One full run bundle, selected by any retained execution UUID                       | `lib/api/tests/run/`       |
| `GET /api/tests/commit/{sha}?repo=owner/name` | Retained run bundles across all tests on a repository commit                       | `lib/api/tests/commit/`    |

## Tests endpoints

The tests endpoints read the test hub tables from the database named by
`CI_DATABASE` in `lib/api/tests/database.ts`; never hardcode a database name
in a query.

Use `env_vars: { id, values, first_seen_at }` for the shared env-var catalog
record across health and run responses. Keep variable names and their string
values inside `values`, separate from the record's metadata. A known empty set
has `values: {}`; unavailable catalog metadata has `env_vars: null`.

### Options

`GET /api/tests/options` publishes, for the list parameters a person chooses
from, the accepted values, each with a label for running text, and the default
that applies when the parameter is absent. The fixed choices (`window`,
`ran_on`, `language` and `status`) read `WINDOWS`, `RAN_ONS`, `LANGUAGES`,
`HEALTH_STATUSES` and the
defaults from `lib/api/tests/parameters.ts`, the same definitions that
validate `GET /api/tests`, so the two cannot disagree; their labels live
beside them in `lib/api/tests/options/options.ts`, typed by the value sets, so
a new value without a label does not compile. The catalog choices, the eleven
environment fields and `test_config`, are the distinct values of the
`environments` and `env_vars` catalogs, read on each request with one query
per catalog (`groupUniqArray` per column, no `FINAL`: rows sharing an id are
identical in these columns) and put in natural order, versions by number;
`workflow_path` is every calling workflow path the `health` table has seen in
its longest window on either code source (`groupUniqArrayArray` over the two
`14d` partitions, about 0.2 s), and `owner` every label of the `owners`
catalog (read with `FINAL`, since a file's row is replaced whole when its
owners change), both read concurrently with them. A value is its
own label except the proper names the catalogs spell in lowercase (`cuda` is
`CUDA`, `linux` is `Linux`, `gcc` is `GCC`), a workflow, labelled by its
file (`.github/workflows/pull.yml` is `pull.yml`), and the empty value,
labelled `none`; their default is always empty, no filter. The
tests check every offered value against the list's parser. The endpoint takes
no parameters, answers 500 with `internal_error` when a source cannot be
read, and is served with the same short cache lifetime as the OpenAPI
document. HUD's tests page builds every choice in its title from it instead
of spelling a value out.

### Test health

The list returns one entry per test, environment and env var set. Health
combines only the selected code sources for that configuration. `test_config`
is the env var set's `TEST_CONFIG`, read out of the map
(`env_vars['TEST_CONFIG']`, the empty string for a set without it) so that it
can be offered by the options, filtered on and sorted on like a column; the
`env_vars` filter still matches any variable. Workflow-path
filtering selects configurations but does not narrow their aggregated health
to matching workflows. The detail endpoint reuses the catalog and health
shapes, returning every observed configuration, window and code source without
pagination. It keeps windows separate because they overlap, and keeps code
sources separate. A known test without health is distinct from an unknown test.

`health.status` says in a word how a configuration's runs went, from the
combined counts: `failing` when a run's last attempt failed (`failed_runs`
exceeds `flaky_runs`, which counts the failing runs that passed on retry),
`flaky` when every failing run passed on retry, `healthy` when no run failed,
and `skipped` when there are no runs. Nothing is stored for it: the health
view has a row only for a configuration with attempts or skips in the window,
and the status is derived at query time in `COMBINED_HEALTH_SQL` from the
summed counts, so the field, the `status` filter (repeatable, applied to the
combined rows like `workflow_path`) and the sort cannot disagree. Sorting by
`status` uses a rank derived the same way, healthy 0, flaky 1, failing 2, so
`-status` puts the worst first; `skipped` has no rank and sorts last either
way, as the rates of a configuration without runs do.

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
both lists share metadata expansion in `test/runs/mapping.ts`. `runs.id` is
neither a key column nor indexed, so the lookup first scans the UUID column of
every retained run to find the run's primary-key prefix, then reads that prefix
with `FINAL`. Its latency grows with retention: about 0.2 s of server time over
191 million rows on 2026-10-24. An id-keyed lookup table filled by a
materialized view is the remedy if that cost becomes a problem; it was deferred.

Both lists reuse the test list's catalog shapes and owners. Form bundles before
pagination so `limit` counts bundles and a bundle never crosses a page boundary.
Outcome and `rerun_number` filters must match the same deduplicated execution;
return every attempt in a selected bundle, including those that do not match.
`last_attempt_outcome` independently filters the last retained attempt, ordered
by `started_at`, `ended_at` and execution UUID string. It applies before pagination
and can be repeated to match any supplied outcome. For example,
`outcome=failed&last_attempt_outcome=passed` selects bundles containing a failure
whose last retained attempt passed. Adding `rerun_number=0` requires the failure
to have execution number zero; it does not constrain the last attempt's number.
The last retained attempt does not establish that a retry chain is complete.
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
and per-outcome bundle counts into `stats` for the requested repository and
commit. Retries are flattened: a bundle counts once under its final outcome, the
outcome of its last executed attempt in `started_at`, `ended_at` and `id` order,
or `skipped` when every attempt was skipped. A skip never overrides an executed
attempt: a test that timed out or failed and was then skipped in its rerun did
not recover, so that bundle keeps its `timed_out` or `failed` outcome, as the
health view's retry chains count it. This is the one way the final outcome
differs from the `last_attempt_outcome` filter, which reads the last attempt as
recorded.
One independent request starts concurrently with the page query and shares its
commit membership and replacement deduplication rules; it groups the commit's
rows by job and test once, so no bundle is counted twice. Search, run filters
including `outcome` and `last_attempt_outcome`, cursor, limit and ordering affect
only the runs list. Statistics and the page can observe different data during
updates.
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

`github_workflow.event` records the trigger, such as `pull_request`,
`pull_request_target`, `push`, `schedule` or `workflow_dispatch`.
`github_workflow.pull_request` exposes the unique recorded PR as a nullable
`{ number, url }` object. Its base repository ID must match the workflow's
repository ID. This keeps contributor PRs targeting the workflow's repository
and excludes PRs syncing upstream changes into other forks. Duplicate records
of the same PR collapse into one object. The value is `null` when no matching PR
is recorded, required metadata is unavailable, or multiple distinct matches make
the association ambiguous. Use the event to identify a PR trigger: push runs can
have an associated PR, and GitHub can omit associations for PR-triggered runs.
These fields share the latest retained workflow record across attempts and do
not infer PRs from branch names or a commit's current PR membership.

### Commit membership and performance

Commit membership follows `default.workflow_run.head_sha` and repository through
workflow job associations. A pull-request job may record a different merge SHA,
so do not additionally filter by its SHA. Include all matching workflow and job
attempts, without a branch, event or arbitrary time restriction.

The commit query computes job IDs in a scalar subquery. The old analyzer
evaluates it once per query block that references it, so a page that reads
`FINAL` at shared starts evaluates it three times: once for each union branch's
shared-start set and once for the direct read. A named table CTE would instead
expand at every reference. This is not an
application cache, and every request discovers current membership.

The runs table's `by_job` projection stores every replacement version and cannot
be read with `FINAL`. Bundle selection can use it when replacements cannot change
group membership or ordering: group IDs, the earliest start, catalog and workflow
fields, and matching a `rerun_number` filter. Both `outcome` and
`last_attempt_outcome` filters and ordering by outcome, end time or the last
attempt's number need replacement resolution. A commit page then resolves it by test
start: versions of one run share its start, so one `by_job` pass finds the starts
holding more than one stored row, a `FINAL` read pruned to those starts
deduplicates them, and every other row is read directly through `by_job`. The
statistics first group the commit's rows by job and test in one `by_job` pass: a
key holding one stored row is a one-attempt bundle in its only version and is
counted there, and only the other keys' rows, pruned by key on `by_job`, go
through the same start-based resolution before they are grouped into bundles. A job filter alone prunes nothing under `FINAL`, so a plain `FINAL`
read would scan the whole table. A test page reads `FINAL` by its primary key.
Attempt expansion always uses `FINAL`. Grouping by configuration and job must not
merge different test IDs or silently drop attempts from separate reports.
Page selection and attempt expansion are separate reads of current data, so newly
ingested attempts or replacements may change a bundle between those reads.

The live service runs the old analyzer. It materializes a tuple-typed scalar as
one value, which fails above 1,000,000 elements, so return arrays from scalar
subqueries. It copies the WITH clause into every subquery, so keep each IN set
one subquery level deep, keep predicate pushdown from copying page filters
into union branches, and keep large subqueries out of WITH scalars that nested
subqueries reference: a scalar holding the shared-start classification overflowed
the 500,000-node AST limit, so that set is an inline IN subquery. Do not ask a `by_job` read for DISTINCT `tests_id`, which
reads the main table in its sorting-key order instead.

Use [Tests API SQL validation](../../lib/api/tests/query-validation.md) for
current defaults, checked-in query evidence and the reproducible validation
command. The [commit notes](../../lib/api/tests/commit/query-validation.md)
and other notes beside the queries record earlier design experiments; their
measurements are historical. Preserve the correctness guarantees and measure
working-tree SQL with fixed, nonempty inputs when evaluating a rewrite.
