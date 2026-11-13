export function isSafeReleaseUrl(
  value: string | null | undefined
): value is string {
  if (!value || /[\s\x00-\x1f]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      Boolean(parsed.hostname) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}
