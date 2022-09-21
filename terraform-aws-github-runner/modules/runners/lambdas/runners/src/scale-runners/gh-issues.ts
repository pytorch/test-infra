import { Repo, getRepoKey } from './utils';
import LRU from 'lru-cache';
import { Octokit } from '@octokit/rest';
import { createGitHubClientForRunnerRepo } from './gh-runners';
import { Metrics } from './metrics';

type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhIssues = UnboxPromise<ReturnType<Octokit['search']['issuesAndPullRequests']>>['data']['items'];

const issuesCache = new LRU({ maxAge: 30 * 1000 });

export function resetIssuesCache() {
  issuesCache.reset();
}

export async function getRepoIssuesWithLabel(
  repo: Repo,
  label: string,
  metrics: Metrics,
  status = 'is:open',
): Promise<GhIssues> {
  const repoKey = getRepoKey(repo);
  const key = `${repoKey}|${label}`;

  try {
    let issues = issuesCache.get(key) as GhIssues;

    if (issues === undefined) {
      const localGithubClient = (await createGitHubClientForRunnerRepo(repo, metrics)) as Octokit;
      const issueResponse = await metrics.trackRequest(
        metrics.issuesAndPullRequestsGHCallSuccess,
        metrics.issuesAndPullRequestsGHCallFailure,
        () => {
          return localGithubClient.paginate(localGithubClient.search.issuesAndPullRequests, {
            q: `repo:${repoKey} ${status} is:issue label:"${label}"`,
            per_page: 100,
          });
        },
      );
      /* istanbul ignore next */
      issues = issueResponse || [];
      issuesCache.set(key, issues);
    }

    return issues;
  } catch (e) {
    console.error(`[getRepoIssuesWithLabel] ${e}`);
    throw e;
  }
}
