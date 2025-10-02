export function extractBackendSqlStyle(
  output: string,
  suite: string,
  dtype: string,
  mode: string,
  device: string
): string | null {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tail = `_${esc(suite)}_${esc(dtype)}_${esc(mode)}_${esc(device)}_`;

  const temp = output.replace(new RegExp(`${tail}.*$`), "");

  const m = temp.match(/.*[\/\\]([^\/\\]+)$/);
  return m ? m[1] : null;
}

export function toQueryArch(device: string, arch: string) {
  if (arch === undefined) return [];
  if (!device) return [];
  switch (device) {
    case "rocm":
      if (arch === "mi300x" || arch == "") return ["mi300x", "mi325x"];
      return [arch];
    default:
      if (arch === "") {
        return [];
      }
      return [arch];
  }
}

export function toApiArch(device: string, arch: string): string {
  const norm = arch.toLowerCase();
  switch (device) {
    case "cpu":
      return norm;
    case "cuda":
      if (norm.includes("h100")) return "h100";
      if (norm.includes("a100")) return "a100";
      if (norm.includes("a10g")) return "a10g";
      if (norm.includes("b200")) return "b200";
      return norm;
    case "rocm":
      if (norm.includes("mi300x")) return "mi300x";
      if (norm.includes("mi325x")) return "mi300x";
      return norm;
    case "mps":
      return norm;
    default:
      return norm;
  }
}

function deepDiff(obj1: any, obj2: any) {
  const diffs: string[] = [];
  const allKeys = new Set([...Object.keys(obj1), ...Object.keys(obj2)]);
  for (const key of allKeys) {
    const v1 = obj1[key];
    const v2 = obj2[key];
    if (
      typeof v1 === "object" &&
      v1 !== null &&
      typeof v2 === "object" &&
      v2 !== null
    ) {
      if (JSON.stringify(v1) !== JSON.stringify(v2)) {
        diffs.push(
          `Key "${key}" differs: ${JSON.stringify(v1)} vs ${JSON.stringify(v2)}`
        );
      }
    } else if (v1 !== v2) {
      diffs.push(`Key "${key}" differs: ${v1} vs ${v2}`);
    }
  }

  return diffs;
}

export function parseTimestampToken(
  token: string | number | null | undefined
): number | null {
  if (token == null) return null;

  if (typeof token === "string") {
    const ms = Date.parse(token.trim()); // parses ISO, RFC2822, etc.
    return isNaN(ms) ? null : ms; // return epoch ms
  }

  if (typeof token === "number") {
    const d = new Date(token);
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  return null;
}

export function parseTimestampTokenSeconds(
  token: string | number | null | undefined
): number | null {
  const ms = parseTimestampToken(token);
  return ms == null ? null : Math.floor(ms / 1000);
}

export function badRequest(message: string, res: any) {
  return res.json({ error: message }, { status: 400 });
}
