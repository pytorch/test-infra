import {
  commitPagePath,
  pageQueryString,
} from "lib/api/tests/pages/parameters";
import { commitPageStateFromUrl, commitUrlParams } from "lib/tests/commitPage";
import type { UrlQuery } from "lib/tests/url";

// The pull request page's glue, free of React: the URL of
// GET /api/tests/pull/{number} that finds the pull request's newest head,
// and the commit page the pull request page then opens.

// Where the API answers for a pull request. The number goes as the URL
// gave it; the API validates it.
export function pullRequestApiUrl(repo: string, number: string): string {
  return `/api/tests/pull/${encodeURIComponent(
    number
  )}?repo=${encodeURIComponent(repo)}`;
}

// The commit page of the pull request's head, with the commit page's
// parameters the pull request page's URL carries, read and written as the
// commit page reads and writes them: a value it refuses falls back to its
// default, defaults are left off, and anything else is dropped.
export function pullPageTarget(
  repo: string,
  sha: string,
  url: UrlQuery
): string {
  return `${commitPagePath(repo, sha)}${pageQueryString(
    commitUrlParams(commitPageStateFromUrl(url))
  )}`;
}
