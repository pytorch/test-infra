## Getting Started

### Prerequisites

Here is a checklist of all the different services used by the HUD. Ask
@pytorch/pytorch-dev-infra for help getting access to these services.

- [ClickHouse](https://console.clickhouse.cloud/): primary data and metrics backend.
- [Vercel](https://vercel.com/): hosting the website. If you are a metamate,
  make a post [like
  this](https://fb.workplace.com/groups/osssupport/posts/27574509675504286) in the
  [Open Source - Support](https://fb.workplace.com/groups/773769332671684) group
  to get access to Vercel.
- [AWS](http://aws.com/): data pipelines for populating ClickHouse, Lambda, S3, etc.

### Quickstart

1. Install [`yarn`](https://yarnpkg.com/getting-started/install), which we
   use for package and project management.
2. Install the required dependencies for the project:

```bash
yarn install
```

3. You will need to set up your `.env.local` file with various keys and
   permissions. Follow the instructions in `.env.example`.

4. Run the development server

```bash
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the
result! Any edits you make to the code will be reflected immediately in the
browser. You can also run our test suite with `yarn test`.

You can find additional yarn commands in `package.json` under the `scripts`
section, such as `yarn format` to run the linter.

We use Next.js as our framework. To learn more about Next.js, take a look at the
following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Testing

To run tests first make sure you're in the `torchci` folder and then:

- To run all tests:
  - `yarn test`
- To run all tests in a specific file:
  - `yarn test <path-to-file>`
  - e.g. `yarn test test/autoLabelBot.test.ts`
- To run a specific test in a specific file:
  - `yarn test <path-to-file> -t "<part-of-test-name>"`
  - e.g. `yarn test test/autoLabelBot.test.ts -t "triage"`
  - Note: This will run all tests that regex match the string you enter

The [underlying command](https://github.com/pytorch/test-infra/blob/05023d3001e0128018ad9e04a5ae2319a443e3f4/torchci/package.json#L9) of `yarn test` is `npx jest` ([jest docs](https://jestjs.io/docs/cli)).

### Testing Probot

The easiest way to develop probot actions is to use `nock` to mock out
interactions with the GitHub API and develop completely locally. If you _do_
need real webhooks, the easiest thing to do is [follow these
instructions](https://github.com/pytorch/test-infra/wiki/Testing-Probot-Locally)
to configure a repo to send webhooks to a Smee proxy, which will then forward
them to your local server.

## Deployment and monitoring

We use [Vercel](https://vercel.com/torchci) as our deployment platform. Pushes
to `main` and any other branches will automatically be deployed to Vercel; check out
the bot comments for how to view.

## Grafana CLI token (`gcx`)

`GET /api/gcx-token` mints a **read-only (Viewer)** Grafana service-account
token for the [`gcx`](https://github.com/grafana/gcx) CLI, so contributors can
self-serve a `GRAFANA_TOKEN` instead of creating one by hand in the Grafana UI.
Access is gated by GitHub identity: the caller must have write access to
`pytorch/pytorch` (or be on the allow list in `lib/auth/allowList.json`).

Primary usage — reuse an existing GitHub token (no browser, nothing to install):

```bash
export GRAFANA_TOKEN=$(curl -fsSL \
  -H "Authorization: Bearer $(gh auth token)" \
  "https://hud.pytorch.org/api/gcx-token?token_name=$(hostname)")
```

Each GitHub user gets a dedicated service account named `gcx-<github-login>`
with the Viewer role. The optional `token_name` param labels the token
(defaults to "default"), so you can hold one token per machine; re-running with
the same label replaces only that token. Revoke manually in the Grafana UI if
needed.

Required server-side env vars (Vercel):

- `GRAFANA_ADMIN_TOKEN` — a Grafana service-account token with Admin role
  (`serviceaccounts:write` / `serviceaccounts.tokens:write`). Used only
  server-side to mint Viewer tokens; never returned to callers.
- `GRAFANA_SERVER` — optional, defaults to `https://pytorchci.grafana.net`.

## How to edit ClickHouse queries

If you are familiar with the old setup for Rockset, ClickHouse does not have
versioned query lambdas. Instead, queries are defined in `clickhouse_queries/`
and HUD sends the entire query text to ClickHouse in the same way Rockset did
for queries not defined using a query lambda.

Each query should have a folder in `clickhouse_queries/` with two files: one
containing the query and the other containing a json dictionary with a
dictionary `params`, mapping parameters to their types, and a list `tests` of
sample values for the query.

To edit the query, only these files need to be changed. The change will be
reflected immediately in your local development and in the Vercel preview when
you submit your PR.

If you want to test your query in ClickHouse Cloud's console, you need to copy
the query text into the console. If you make changes, you will have to copy the
query back into the file.

To get access to ClickHouse Cloud's console, please see
[here](https://github.com/pytorch/test-infra/wiki/Querying-ClickHouse-database-for-fun-and-profit#prerequisites).

### `params.json`

An example `params.json` file with params and tests:

```
{
  "params": {
    "A": "DateTime64(3)"
  },
  "tests": [
    {"A": "2024-01-01 00:00:00.000"},
    {"A": "2024-01-07 00:00:00.000"},
    {"A": "2025-01-01 00:00:00.000"},
    {"A": {"from_now": 0}}
  ]
}
```

A test can set a parameter to be a dictionary with the field `from_now` to get a
dynamic timestamp where the entry is the difference from now in days. For
example `from_now: 0` is now and `from_now: -7` would be 7 days in the past.

### Linting a query

Two `lintrunner` linters cover a query folder: `SQLFLUFF` formats `query.sql`,
and `SQL_PARAMS` checks `params.json` against the parameters the query actually
uses. Install them with:

```
VIRTUAL_ENV=<path-to-your-venv> lintrunner init --take SQLFLUFF,SQL_PARAMS
```

`VIRTUAL_ENV` has to be set. `tools/linter/adapters/pip_init.py` appends
`--user` to its `pip install` when neither `VIRTUAL_ENV` nor `CONDA_PREFIX` is
in the environment, and pip refuses `--user` from inside a virtualenv.

Then lint the two files by path:

```
lintrunner torchci/clickhouse_queries/<name>/query.sql torchci/clickhouse_queries/<name>/params.json
```

Pass the paths positionally like that, or `git add` the new folder before
linting. `lintrunner -m main` takes its file list from `git diff-tree`, which
never lists untracked files, so a new query folder is skipped in silence and the
run reports no issues.

#### What a clean run does and does not mean

On a file sqlfluff can parse, the gate works: keyword casing and layout are
enforced, and it will reject a genuine layout defect. Every
`greenlight_quality_*` query parses, and mutating any of them is caught.
Do not read the rest of this section as a reason to distrust it.

Its reach on those files is still narrower than "sqlfluff passed", because the
adapter shells out to `sqlfluff format`, which hardcodes a restricted rule set
(`cli/commands.py`): all of `capitalisation` and `layout`, plus only
`ambiguous.union`, `convention.not_equal`, `convention.coalesce`,
`convention.select_trailing_comma`, `convention.is_null`, `jinja.padding` and
`structure.distinct`. Rules outside that list are never invoked even when
sqlfluff could fix them automatically, and `format` rejects `--rules`, so the
set cannot be widened from `.sqlfluff`. Those same queries parse cleanly, are
left untouched by `format`, and are still rewritten by
`sqlfluff fix --force` — `structure.column_order`,
`aliasing.self_alias.column` and `references.*` all fire outside the gate. Read
a clean run as "clean under format's subset", not "clean under sqlfluff".

The real limit is that **this gate has several ways of reporting clean when it
never looked at your file, and none of them are distinguishable from a pass.**
`ok No lint issues` means "nothing was reported", which is not the same as
"nothing is wrong". The `SQLFLUFF` linter is declared `is_formatter = true`, so
it reports a file only when `sqlfluff format` rewrites it — and anything that
stops sqlfluff producing a rewrite produces silence instead of an error. The
known ways in are an untracked path, an unparsable construct, a rule outside
`format`'s subset, and an oversized file. Treat that list as open.

**Unparsable constructs.** A region sqlfluff cannot parse makes every violation
in the file unfixable, the formatter therefore changes nothing, and the file
passes with no output — for the whole file, not just the unparsable part. A
lowercase `SELECT` that is caught in a parsable file goes unreported once
anything else in the same file fails to parse. This is not a rare edge case:
**98 of the 194 committed `query.sql` files — 51% — currently report a parse
error** under the exact transformation the adapter applies, and so are getting
no structural or stylistic checking at all.

**Oversized files.** sqlfluff refuses to look at any file over
`large_file_skip_byte_limit` bytes, warning `Skipping to avoid parser lock` and
reporting nothing; lintrunner renders that as a pass. The default is 20000. The
same 22,505-byte query linted under a 20000 limit yields the warning and zero
violations, and under a 32768 limit yields 175 — size alone is the discriminator.
`.sqlfluff` raises the limit to 32768 for this repo, so nothing is currently
skipped; the comment there explains why, and lowering it again silently unlints
the largest query. A query file grows over time, so this one arrives on its own.

Two known parse triggers, and the list is **not** exhaustive — assume any
construct may be one until you have checked:

- `ARRAY JOIN` with any clause after it. The clause parses on its own, and with
  a following `ORDER BY`, but a following `WHERE`, `GROUP BY` or `LIMIT` does
  not — in every form tested, including `LEFT ARRAY JOIN`, multi-column, an
  array literal, inside a subquery and inside a CTE. Since a realistic query
  filters or groups, treat `ARRAY JOIN` as unusable here and expand arrays with
  the `arrayJoin(arrayZip(...))` function form instead; that parses.
- A `{name: Type}` placeholder anywhere a bare string literal is not valid SQL.
  The adapter rewrites `{` to `'{` and `}` to `}'` before handing the file to
  sqlfluff, which makes placeholders parse in value positions
  (`= {repo: String}`) but not elsewhere — `IN {prNumbers: Array(Int64)}` becomes
  `IN '{prNumbers: Array(Int64)}'` and fails. **This one is not a defect in your
  query**: the SQL ClickHouse receives is valid, and the unparsable text only
  ever exists inside the linter. Do not contort a working query to satisfy it.

To find out whether your file was actually examined, and what it would have
been told, reproduce the substitution and run sqlfluff yourself. From the repo
root:

```
sed "s/{/'{/g; s/}/}'/g" <file> > /tmp/q.sql
sqlfluff lint  --config .sqlfluff --dialect clickhouse /tmp/q.sql | grep "over the limit"   # skipped for size?
sqlfluff parse --config .sqlfluff --dialect clickhouse /tmp/q.sql | grep "Found unparsable" # unparsable?
sqlfluff lint  --config .sqlfluff --dialect clickhouse /tmp/q.sql                           # everything the gate omits
```

Silence from the first two means the file was examined; the third then lists
what the gate did not report.

Two details make the difference between this telling you the truth and
misleading you. The `sed` matters: run sqlfluff on the raw file and the bare
`{name: Type}` placeholders are themselves unparsable, so 190 of the 194
committed queries look broken. And these must run against a **file path**, not
piped on stdin — sqlfluff does not apply the size limit to stdin, so the piped
form lints a file the real gate skipped and reports it clean.

Finally, do not run `.github/scripts/run_clickhouse_format.sh`. No workflow
invokes it, it rewrites every folder under `clickhouse_queries/` in place, and
the `clickhouse format` it shells out to strips every comment from the queries
it touches.

## Alerts

Code is in `test-infra/tools/torchci/check_alerts.py`. It queries HUD, filters out pending jobs, and then checks to see if there are 2 consecutive
SHAs that have the same failing job. If it does, it will either create a new Github Issue or update the existing
Github Issue.

A Meta internal Butterfly bot rule will trigger when the task is created or updated to assign the task to the oncall to notify the DevX team.

Butterfly bot links:

- [When a new alert is created](https://www.internalfb.com/butterfly/rule/5455687371213466)
- [When pytorch/pytorch failures are edited](https://www.internalfb.com/butterfly/rule/2024866984357962)
- [When flaky test detector bot alerts are edited](https://www.internalfb.com/butterfly/rule/741489054164977)

## Modifying Deployment Settings

If you ever need to modify the deployment settings like the oauth callbacks, domain names, there's a few places that you need to change these settings in. Here's a list:

1. [DNS Registry/Certificates](https://fb.workplace.com/groups/osssupport) (Contact the the OSS team)
2. [Environment Variables](https://vercel.com/fbopensource/torchci/settings/environment-variables)
3. [OAuth Project](https://github.com/settings/applications/1973779) / [OAuth Project Local](https://github.com/settings/applications/1976306)
4. [Domain Management](https://vercel.com/fbopensource/torchci/settings/domains)
