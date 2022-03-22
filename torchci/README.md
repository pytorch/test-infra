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

## Developing Probot

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
3. Run `rockset deploy -l <yourlambda>` to sync it to Rockset.
4. Update `rockset/prodVersion.json` with the new version of the lambda.

### Work on the query in Rockset console

1. Edit the query on console.rockset.com.
2. Save the query, creating a new version.
3. Download the query with `yarn node scripts/downloadQueryLambda.mjs <workspace> <queryname> <version>`.
4. Update `rockset/prodVersion.json` with the new version of the lambda.
