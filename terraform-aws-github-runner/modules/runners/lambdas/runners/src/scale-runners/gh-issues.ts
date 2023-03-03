import { Repo, getRepoKey } from './utils';

import { Metrics } from './metrics';
import { Octokit } from '@octokit/rest';
import { createGitHubClientForRunnerRepo } from './gh-runners';
import { redisCached, clearLocalCacheNamespace } from './cache';

type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhIssues = UnboxPromise<ReturnType<Octokit['search']['issuesAndPullRequests']>>['data']['items'];

export function resetIssuesCache() {
  clearLocalCacheNamespace('ghIssues');
}

export async function getRepoIssuesWithLabel(
  repo: Repo,
  label: string,
  metrics: Metrics,
  status = 'is:open',
): Promise<GhIssues> {
  const repoKey = getRepoKey(repo);
  const key = `${repoKey}|${label}`;

  return (
    (await redisCached('ghIssues', key, 10 * 60, 1.0, async () => {
      try {
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
        return (issueResponse || []) as GhIssues;
      } catch (e) {
        console.error(`[getRepoIssuesWithLabel] ${e}`);
        throw e;
      }
    })) || []
  );
}
