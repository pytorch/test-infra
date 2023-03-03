import { getRepoIssuesWithLabel, resetIssuesCache } from './gh-issues';

import { Octokit } from '@octokit/rest';
import { createGitHubClientForRunnerRepo } from './gh-runners';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';
import { ScaleUpMetrics } from './metrics';
import { redisCached } from './cache';

jest.mock('./runners');
jest.mock('./gh-runners');
jest.mock('./cache');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  nock.disableNetConnect();

  mocked(redisCached).mockImplementation(
    async <T>(ns: string, k: string, t: number, j: number, fn: () => Promise<T>): Promise<T> => {
      return await fn();
    },
  );
});

describe('getRepoIssuesWithLabel', () => {
  const metrics = new ScaleUpMetrics();

  beforeEach(() => {
    jest.spyOn(metrics, 'sendMetrics').mockImplementation(async () => {
      return;
    });
  });

  test('gets the list', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const label = 'the label';
    const issues = [{ id: '1' }, { id: '2' }];

    const mockedOctokit = {
      paginate: jest.fn().mockResolvedValue(issues),
      search: {
        issuesAndPullRequests: 'The Thing',
      },
    };
    const mockedCreateGitHubClientForRunnerRepo = mocked(createGitHubClientForRunnerRepo);
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    mockedCreateGitHubClientForRunnerRepo.mockResolvedValue(mockedOctokit as any as Octokit);

    resetIssuesCache();
    expect(await getRepoIssuesWithLabel(repo, label, metrics)).toBe(issues);
    expect(await getRepoIssuesWithLabel(repo, label, metrics)).toBe(issues);

    expect(createGitHubClientForRunnerRepo).toBeCalledWith(repo, metrics);
    expect(mockedOctokit.paginate).toBeCalledWith(mockedOctokit.search.issuesAndPullRequests, {
      q: `repo:owner/repo is:open is:issue label:"${label}"`,
      per_page: 100,
    });
  });

  test('handles the exception', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const label = 'the label';
    const filter = 'is:closed';
    const errMsg = 'The error message';

    const mockedOctokit = {
      paginate: jest.fn().mockRejectedValue(Error(errMsg)),
      search: {
        issuesAndPullRequests: 'The Thing',
      },
    };
    const mockedCreateGitHubClientForRunnerRepo = mocked(createGitHubClientForRunnerRepo);
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    mockedCreateGitHubClientForRunnerRepo.mockResolvedValueOnce(mockedOctokit as any as Octokit);

    resetIssuesCache();
    await expect(getRepoIssuesWithLabel(repo, label, metrics, filter)).rejects.toThrowError(errMsg);

    expect(createGitHubClientForRunnerRepo).toBeCalledWith(repo, metrics);
    expect(mockedOctokit.paginate).toBeCalledWith(mockedOctokit.search.issuesAndPullRequests, {
      q: `repo:owner/repo is:closed is:issue label:"${label}"`,
      per_page: 100,
    });
  });
});
