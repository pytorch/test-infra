import { isDayjs } from "dayjs";

/** Decide if a key should be excluded (supports exact key or prefix match) */
export function shouldExclude(key: string, exclude: Set<string>) {
  if (exclude.has(key)) return true;
  for (const p of exclude) {
    if (p && (key === p || key.startsWith(p + "."))) return true;
  }
  return false;
}

/** Convert state object → query params (dotted keys + repeat style arrays) */
export function stateToQuery(
  obj: Record<string, any>,
  excludeKeys: string[] = []
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  const exclude = new Set(excludeKeys);

  const set = (k: string, v: string | string[]) => {
    if (shouldExclude(k, exclude)) return;
    if (Array.isArray(v)) {
      const vv = v.filter((x) => x != null).map(String);
      if (vv.length) out[k] = vv;
    } else if (v != null) {
      out[k] = String(v);
    }
  };

  const toIso = (v: any): string => {
    const d = isDayjs(v) ? v.toDate() : v;
    return d.toISOString();
  };

  const walk = (prefix: string, value: any) => {
    if (value == null) return;

    // Dates / Dayjs
    if (
      value instanceof Date ||
      isDayjs(value) ||
      (value?.toISOString && typeof value.toISOString === "function")
    ) {
      set(prefix, toIso(value));
      return;
    }

    // Arrays
    if (Array.isArray(value)) {
      const hasObject = value.some((v) => typeof v === "object" && v !== null);
      if (hasObject) {
        value.forEach((v, i) => walk(`${prefix}.${i}`, v));
      } else {
        set(prefix, value.map(String));
      }
      return;
    }

    // Objects
    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(prefix ? `${prefix}.${k}` : k, v);
      }
      return;
    }

    // Primitives
    set(prefix, String(value));
  };

  for (const [k, v] of Object.entries(obj ?? {})) walk(k, v);
  return out;
}

// Normalize query object (so arrays and single values compare fairly)
export function stableQuerySig(q: Record<string, any>): string {
  const map: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(q ?? {})) {
    if (v == null) continue;
    const arr = Array.isArray(v) ? v : [v];
    map[k] = arr.map(String).sort(); // insensitive to ordering
  }
  const keys = Object.keys(map).sort();
  const pairs: [string, string][] = [];
  for (const k of keys) for (const v of map[k]) pairs.push([k, v]);
  return new URLSearchParams(pairs).toString();
}

export function sameQuery(a: Record<string, any>, b: Record<string, any>) {
  return stableQuerySig(a) === stableQuerySig(b);
}

/** Convert query object -> nested state */
export function queryToState(
  query: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, any> = {};

  for (const [rawKey, rawValue] of Object.entries(query ?? {})) {
    if (rawValue == null) continue; // skip null/undefined
    const parts = rawKey.split(".");
    let cur: any = result;

    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];

      const isLeaf = i === parts.length - 1;
      if (isLeaf) {
        const values = Array.isArray(rawValue) ? rawValue : [rawValue];
        // Normalize to string(s)
        cur[key] =
          values.length > 1 ? values.map(String) : String(values[0] as any);
      } else {
        // Ensure the intermediate node is a plain object
        const v = cur[key];
        if (typeof v !== "object" || v === null || Array.isArray(v)) {
          cur[key] = {};
        }
        cur = cur[key];
      }
    }
  }

  return result;
}
