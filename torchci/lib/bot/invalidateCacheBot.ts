import { invalidateCache } from "lib/cacheGithubAPI";
import { Probot } from "probot";

export default function invalidateCacheBot(app: Probot): void {
  app.on(["pull_request"], async (context) => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const prNumber = context.payload.pull_request.number;
    await invalidateCache(
      `octokit.rest.pulls.get ${owner}/${repo}/${prNumber}`
    );
    await invalidateCache(
      `octokit.rest.pulls.listCommits ${owner}/${repo}/${prNumber}`
    );
  });

  app.on(["push"], async (context) => {
    const owner = context.payload.repository.owner.name;
    const repo = context.payload.repository.name;
    const sha = context.payload.after;
    // I don't know in what situation you would need to invalidate this cache
    // since you can't change the commit date after pushing, but do it just in
    // case
    await invalidateCache(
      `octokit.rest.git.getCommit date ${owner}/${repo}/${sha}`
    );
  });
}
