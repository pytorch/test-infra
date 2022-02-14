export function includesCaseInsensitive(
  value: string,
  pattern: string
): boolean {
  return value.toLowerCase().includes(pattern.toLowerCase());
}
