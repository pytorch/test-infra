## Getting Started

1. Install [`yarn`](https://yarnpkg.com/getting-started/install), which we
   use for package and project management.
2. Install the required dependencies for the project:

```bash
yarn install
```

3. You will need to set up your `.env.local` file with various keys and
   permissions. Follow the instructions in `.env.example`.

4. Run the development server:

```bash
yarn dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the
result! Any edits you make to the code will be reflected immediately in the
browser. You can also run our test suite with `yarn test`.

We use Next.js as our framework. To learn more about Next.js, please take a look at the
following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

## Developing Probot

The easiest way to develop probot actions is to use `nock` to mock out
interactions with the GitHub API and develop completely locally. If you *do*
need real webhooks, the easiest thing to do is [follow these
instructions](https://probot.github.io/docs/development/#manually-configuring-a-github-app)
to configure a repo to send webhooks to a Smee proxy, which will then forward
them to your local server.

## Deployment

We use [Vercel](https://vercel.com/torchci) as our deployment platform. Pushes
to `main` and any other branches will automatically be deployed to Vercel; check out
the bot comments for how to view.
