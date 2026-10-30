// The query of a page's URL as Next's router gives it, and what the pages
// write back into it: every parameter kept as it is but the ones named,
// and a parameter set to undefined left off, which is how a page leaves its
// defaults out of the URL.
export type UrlQuery = Record<string, string | string[] | undefined>;

export function mergedUrlQuery(
  current: UrlQuery,
  params: UrlQuery
): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries({ ...current, ...params })) {
    if (value !== undefined) next[name] = value;
  }
  return next;
}
