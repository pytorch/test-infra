import { getRepoIssuesWithLabel, resetIssuesCache } from './gh-issues';

import { Octokit } from '@octokit/rest';
import { createGitHubClientForRunnerRepo } from './runners';
import { mocked } from 'ts-jest/utils';
import nock from 'nock';

jest.mock('./runners');

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  nock.disableNetConnect();
});

describe('getRepoIssuesWithLabel', () => {
  test('gets the list', async () => {
    const repo = { owner: 'owner', repo: 'repo' };
    const label = 'the label';
    const issues = [{ id: '1' }, { id: '2' }];

    const mockedOctokit = {
      paginate: jest.fn().mockResolvedValue({ items: issues }),
      search: {
        issuesAndPullRequests: 'The Thing',
      },
    };
    const mockedCreateGitHubClientForRunnerRepo = mocked(createGitHubClientForRunnerRepo);
    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    mockedCreateGitHubClientForRunnerRepo.mockResolvedValue(mockedOctokit as any as Octokit);

    resetIssuesCache();
    expect(await getRepoIssuesWithLabel(repo, label)).toBe(issues);
    expect(await getRepoIssuesWithLabel(repo, label)).toBe(issues);

    expect(createGitHubClientForRunnerRepo).toBeCalledWith(repo);
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
    await expect(getRepoIssuesWithLabel(repo, label, filter)).rejects.toThrowError(errMsg);

    expect(createGitHubClientForRunnerRepo).toBeCalledWith(repo);
    expect(mockedOctokit.paginate).toBeCalledWith(mockedOctokit.search.issuesAndPullRequests, {
      q: `repo:owner/repo is:closed is:issue label:"${label}"`,
      per_page: 100,
    });
  });
});
