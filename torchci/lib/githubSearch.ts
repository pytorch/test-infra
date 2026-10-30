import { Octokit } from "octokit";

type SearchItems = Awaited<
  ReturnType<Octokit["rest"]["search"]["issuesAndPullRequests"]>
>["data"]["items"];

// GitHub search exposes only the first 1,000 results. Split creation-date
// ranges until every result can be paginated. Boundaries are inclusive seconds.
export async function searchPullRequestsByCreatedAt(
  octokit: Octokit,
  query: string,
  since: number,
  until: number
): Promise<SearchItems> {
  const params = {
    q: `${query} created:${new Date(since * 1000).toISOString()}..${new Date(
      until * 1000
    ).toISOString()}`,
    sort: "created" as const,
    order: "asc" as const,
    per_page: 100,
  };
  const { data } = await octokit.rest.search.issuesAndPullRequests(params);
  if (data.incomplete_results) {
    throw new Error("GitHub returned incomplete PR search results");
  }
  if (data.total_count > 1000) {
    if (since >= until) {
      throw new Error("Too many PRs created in the same second");
    }
    const middle = Math.floor((since + until) / 2);
    return [
      ...(await searchPullRequestsByCreatedAt(octokit, query, since, middle)),
      ...(await searchPullRequestsByCreatedAt(
        octokit,
        query,
        middle + 1,
        until
      )),
    ];
  }
  const items = [...data.items];
  for (let page = 2; page <= Math.ceil(data.total_count / 100); page++) {
    const response = await octokit.rest.search.issuesAndPullRequests({
      ...params,
      page,
    });
    if (response.data.incomplete_results) {
      throw new Error("GitHub returned incomplete PR search results");
    }
    items.push(...response.data.items);
  }
  return items;
}
