import { LogSrc } from "./BenchmarkLogViewContent";

export function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .split(/\s+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

export function flattenInfo(val: unknown, out: string[] = []): string[] {
  if (val == null) return out;
  if (
    typeof val === "string" ||
    typeof val === "number" ||
    typeof val === "boolean"
  ) {
    out.push(String(val));
  } else if (Array.isArray(val)) {
    for (const v of val) flattenInfo(v, out);
  } else if (typeof val === "object") {
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      out.push(k);
      flattenInfo(v, out);
    }
  }
  return out;
}

export function buildHaystack(u: LogSrc): string {
  return [u.label ?? "", u.url ?? "", ...flattenInfo(u.info ?? {})]
    .join(" ")
    .toLowerCase();
}

export function filterByTerms(urls: LogSrc[], terms: string[]): LogSrc[] {
  if (!terms.length) return urls;
  return urls.filter((u) => {
    const hay = buildHaystack(u);
    return terms.every((t) => hay.includes(t));
  });
}

export function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function makeJumpRegex(terms: string[]): RegExp | null {
  if (!terms.length) return null;
  return new RegExp(`(${terms.map(escapeRegExp).join("|")})`, "i");
}
