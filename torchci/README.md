## Getting Started

### Prerequisites

Here is a checklist of all the different services used by the HUD. Ask
@janeyx99 or @suo for help getting access to these services.

- [Rockset](https://rockset.com/): primary data and metrics backend.
- [Vercel](https://vercel.com/): hosting the website.
- [Sematext](https://sematext.com/): log drain for our Vercel instance.
- [AWS](http://aws.com/): data pipelines for populating Rockset, Lambda, S3, etc.

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
instructions](https://probot.github.io/docs/development/#manually-configuring-a-github-app)
to configure a repo to send webhooks to a Smee proxy, which will then forward
them to your local server.

## Deployment and monitoring

We use [Vercel](https://vercel.com/torchci) as our deployment platform. Pushes
to `main` and any other branches will automatically be deployed to Vercel; check out
the bot comments for how to view.

Logs for the Vercel instance can be found in [Sematext](https://sematext.com/).

## How to edit Rockset query lambdas

The source of truth for our query lambdas is in `rockset/`. We use the Rockset
CLI to deploy these queries to Rockset. To get started:

- Follow the steps to [install and authenticate the Rockset
  CLI](https://github.com/rockset/rockset-js/tree/master/packages/cli#download--installation-instructions).
- Optionally, install the [Rockset VSCode
  extension](https://marketplace.visualstudio.com/items?itemName=RocksetInc.rockset-vscode).

Then, you have two options for editing your query, locally or in the Rockset
console.

### Work on the query locally

1. Edit your query lambda. The SQL is found in `rockset/<workspace>/__sql/`, and
   parameter definitions are found in `rockset/<workspace>`.
2. You can test your query lambda using the [Rockset
   CLI](https://github.com/rockset/rockset-js/tree/master/packages/cli#execute-and-test-query-lambda-sql).
3. Run `yarn node scripts/uploadQueryLambda.mjs`. This will upload _all_ of the
   local query lambdas to Rockset and update `rockset/prodVersions.json` to
   point to the new versions.

### Work on the query in Rockset console

1. Edit the query on console.rockset.com.
2. Save the query, creating a new version.
3. Download the query with `yarn node scripts/downloadQueryLambda.mjs <workspace> <queryname> <version>`. (You can skip `<version>` if you want the latest version). This will auto-update sql and lambda files in the `rockset/<workspace>` dir and the query version in `rockset/prodVersion.json`.
4. Commit the updated files.

## Alerts

The scripts/check_alerts.py queries HUD, filters out pending jobs, and then checks to see if there are 2 consecutive
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
