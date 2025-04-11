## Getting Started

### Prerequisites

Here is a checklist of all the different services used by the HUD. Ask
@janeyx99 or @suo for help getting access to these services.

- [ClickHouse](https://console.clickhouse.cloud/): primary data and metrics backend.
- [Vercel](https://vercel.com/): hosting the website. If you are a metamate,
  make a post [like
  this](https://fb.workplace.com/groups/osssupport/posts/27574509675504286) in the
  [Open Source - Support](https://fb.workplace.com/groups/773769332671684) group
  to get access to Vercel.
- [Sematext](https://sematext.com/): log drain for our Vercel instance.
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
section, such as `yarn test` to run the test suite.

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
  - Note: This will run all tests that contain the string you entered

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

Logs for the Vercel instance can be found in [Sematext](https://sematext.com/).

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
