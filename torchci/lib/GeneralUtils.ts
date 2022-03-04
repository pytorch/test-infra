export function includesCaseInsensitive(
  value: string,
  pattern: string
): boolean {
  return value.toLowerCase().includes(pattern.toLowerCase());
}

export const fetcher = (url: string) => fetch(url).then((res) => res.json());
