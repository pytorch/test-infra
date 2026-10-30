import { searchPullRequestsByCreatedAt } from "lib/githubSearch";
import nock from "nock";
import { handleScope } from "./common";
import { testOctokit } from "./utils";

nock.disableNetConnect();

const octokit = testOctokit();
const QUERY = 'repo:pytorch/pytorch is:pr is:open label:"triaged"';

function search(since: number, until: number, data: object, page = 1) {
  return nock("https://api.github.com")
    .get("/search/issues")
    .query({
      q: `${QUERY} created:${new Date(since * 1000).toISOString()}..${new Date(
        until * 1000
      ).toISOString()}`,
      sort: "created",
      order: "asc",
      per_page: 100,
      ...(page === 1 ? {} : { page }),
    })
    .reply(200, data);
}

afterEach(() => nock.cleanAll());

test("splits creation ranges beyond GitHub's cap and reads every result page", async () => {
  const scopes = [
    search(0, 9, { total_count: 1001, items: [] }),
    search(0, 4, { total_count: 101, items: [{ number: 1 }] }),
    search(0, 4, { total_count: 101, items: [{ number: 101 }] }, 2),
    search(5, 9, { total_count: 1, items: [{ number: 1001 }] }),
  ];
  expect(await searchPullRequestsByCreatedAt(octokit, QUERY, 0, 9)).toEqual([
    { number: 1 },
    { number: 101 },
    { number: 1001 },
  ]);
  handleScope(scopes);
});

test("fails explicitly if one second alone exceeds the cap", async () => {
  const scope = search(0, 0, { total_count: 1001, items: [] });
  await expect(
    searchPullRequestsByCreatedAt(octokit, QUERY, 0, 0)
  ).rejects.toThrow("Too many PRs created in the same second");
  handleScope(scope);
});

test.each([1, 2])(
  "does not silently accept incomplete results on page %i",
  async (page) => {
    const scopes = [
      search(0, 9, {
        total_count: 101,
        items: [],
        incomplete_results: page === 1,
      }),
    ];
    if (page === 2) {
      scopes.push(
        search(
          0,
          9,
          { total_count: 101, items: [], incomplete_results: true },
          2
        )
      );
    }
    await expect(
      searchPullRequestsByCreatedAt(octokit, QUERY, 0, 9)
    ).rejects.toThrow("incomplete PR search results");
    handleScope(scopes);
  }
);
