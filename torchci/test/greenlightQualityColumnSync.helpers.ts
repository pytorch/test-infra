// Parsers, readers and floors for test/greenlightQualityColumnSync.test.ts.
//
// Split from the assertions because the two halves share nothing but these parsers, and
// together they exceeded the project's 400-line ceiling. Everything here derives facts
// from a file on disk — a query's SELECT, a row interface, a page module — and asserts
// nothing; the test file next to it does all the asserting.

import fs from "fs";
import path from "path";

export const ROOT = path.join(__dirname, "..");

export const QUERY_CATALOG = path.join(ROOT, "lib/greenlight/qualityQuery.ts");

export const TILE_CONFIGS = path.join(
  ROOT,
  "components/greenlight/quality/tileConfigs.ts"
);

// Read out of the page's own catalog rather than restated here, so adding or dropping a
// query does not need this file edited — a hand-copied list goes stale exactly when the
// check matters. Scanned as text: importing the module pulls in lib/GeneralUtils and with
// it octokit, which does not load under this jest environment.
export function catalogQueries(): string[] {
  const src = fs.readFileSync(QUERY_CATALOG, "utf8");
  const block = src.match(/QUALITY_QUERIES\s*=\s*\{([\s\S]*?)\n\}/);
  if (block === null) {
    throw new Error(
      `${path.basename(
        QUERY_CATALOG
      )}: no QUALITY_QUERIES object literal found. ` +
        `The catalog moved or changed shape; re-target this parser at it rather than ` +
        `deleting the check.`
    );
  }
  return Array.from(block[1].matchAll(/"([a-z0-9_]+)"/g)).map((m) => m[1]);
}

export interface TileSplitFields {
  landField?: string;
  noLandField?: string;
}

// Each coverage tile's LAND and NO_LAND column names, keyed by the tile's own key. Split
// per entry rather than swept over the whole array, so which name sits on which tile
// survives the properties being reordered. Read as text for the same reason as the catalog
// above: tileConfigs.ts reaches lib/GeneralUtils through the row types it imports, and
// with it octokit, which does not load under this jest environment.
export function coverageTileFields(): {
  [_tileKey: string]: TileSplitFields;
} {
  const src = fs.readFileSync(TILE_CONFIGS, "utf8");
  const block = src.match(/COVERAGE_TILES[^=]*=\s*\[([\s\S]*?)\n\];/);
  const found: { [_tileKey: string]: TileSplitFields } = {};
  for (const entry of (block?.[1] ?? "").split(/^ {2}\{$/m).slice(1)) {
    const key = entry.match(/\bkey:\s*"([a-z0-9_]+)"/);
    if (key === null) {
      continue;
    }
    found[key[1]] = {
      landField: entry.match(/\blandField:\s*"([a-z0-9_]+)"/)?.[1],
      noLandField: entry.match(/\bnoLandField:\s*"([a-z0-9_]+)"/)?.[1],
    };
  }
  if (Object.keys(found).length === 0) {
    throw new Error(
      `${path.basename(
        TILE_CONFIGS
      )}: no COVERAGE_TILES entries parsed. The config ` +
        `moved or changed shape; re-target this parser at it rather than deleting the ` +
        `check.`
    );
  }
  return found;
}

// Below these the corresponding extractor has stopped matching and the subset assertion
// would hold vacuously. They are floors against silence, not assertions about content.
//
// Each sits exactly one below its true value — 4 queries, 7 columns in the thinnest
// query, 52 distinct reads, 21 fields in the thinnest row interface — so coverage cannot
// shrink by more than a single item without tripping this. A floor with slack in it
// cannot catch the thing it is for: at 40 reads against a true 50, ten could disappear
// in silence. These track the true counts in both directions; a floor left behind when
// the true count rises is as dead as one set too low. Re-baselining is a deliberate act,
// not a way past a red suite.
//
// The reads floor counts what the page ADDRESSES, not what the queries emit. Eight columns
// the queries still compute are addressed by nothing — cancelled_failed,
// verdicts_distinct_pr_sha, excluded_no_push_ts, excluded_pre_ledger,
// excluded_push_after_event, review_visible_after_s, human_approved, no_approval — and
// dropping them from the SQL would not move this number.
export const MIN_QUERIES = 3;
export const MIN_COLUMNS_PER_QUERY = 6;
export const MIN_READS_ACROSS_PAGE = 51;
export const MIN_FIELDS_PER_INTERFACE = 20;

// Which query each row interface describes. Stated rather than derived from the interface
// name: guessing "RevertRow" -> "reverts" would quietly bind to the wrong query after a
// rename, whereas a wrong name here fails loudly when emittedColumns cannot open the file.
//
// An opt-in registry, not a map of every row interface qualityQuery.ts declares. An
// interface absent from here is checked by none of the three tests that read it — not the
// field-list floor, not the SQL sync, not nullability. CoverageRow is absent to keep those
// three sharp: MIN_FIELDS_PER_INTERFACE is a single floor covering every entry, so
// registering a row far thinner than the rest means lowering the floor to admit it, and
// the wider interfaces could then lose most of their fields without tripping it. That row
// keeps its keyof check against tsc and forgoes the SQL sync.
export const ROW_INTERFACES: { [_interfaceName: string]: string } = {
  LatencyRow: "greenlight_quality_latency",
  RevertRow: "greenlight_quality_reverts",
};

export function declaredFields(interfaceName: string): string[] {
  const src = fs.readFileSync(QUERY_CATALOG, "utf8");
  const body = src.match(
    new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`)
  );
  if (body === null) {
    throw new Error(
      `${interfaceName} not found in ${path.basename(
        QUERY_CATALOG
      )}. It moved or ` +
        `changed shape; re-target this parser at it rather than deleting the check.`
    );
  }
  return Array.from(body[1].matchAll(/^\s*([a-z_][a-z0-9_]*)\??:/gm)).map(
    (m) => m[1]
  );
}

// Field name -> whether the declared type admits null. The sync checks above compare
// names only, so a column that gains a NULL branch server-side leaves a declaration
// asserting a value that can no longer be relied on.
export function declaredNullable(interfaceName: string): Map<string, boolean> {
  const src = fs.readFileSync(QUERY_CATALOG, "utf8");
  const body = src.match(
    new RegExp(`interface ${interfaceName} \\{([\\s\\S]*?)\\n\\}`)
  );
  const found = new Map<string, boolean>();
  for (const m of (body?.[1] ?? "").matchAll(
    /^\s*([a-z_][a-z0-9_]*)\??:\s*([^;]+);/gm
  )) {
    found.set(m[1], /\bnull\b/.test(m[2]));
  }
  return found;
}

// Files that address query output. The component directory is globbed whole, so a new
// panel is covered without editing this test. lib/greenlight cannot be: it also holds
// the comment renderer and the staleness sweep, which read misc.greenlight_pr_state
// directly, and their column names are not these queries' — globbing them would report
// ten dangling reads that are not bugs. So that directory is filtered by name, and the
// "closed under its own imports" test below is what stops the filter going stale.
export function uiSources(): string[] {
  const componentDir = path.join(ROOT, "components/greenlight/quality");
  const libDir = path.join(ROOT, "lib/greenlight");
  return [
    path.join(ROOT, "pages/greenlight_quality.tsx"),
    ...fs.readdirSync(componentDir).map((f) => path.join(componentDir, f)),
    ...fs
      .readdirSync(libDir)
      .filter((f) => f.startsWith("quality"))
      .map((f) => path.join(libDir, f)),
  ];
}

// Where a covered file's own imports land, for the two directories this check owns.
// Anything outside them is somebody else's module and not this test's business.
export const COVERED_ROOTS = [
  "lib/greenlight",
  "components/greenlight/quality",
];

// Shared greenlight modules the quality surface imports for a constant apiece, and which
// address misc.greenlight_pr_state rather than these queries — scanning them would report
// their ledger column names as dangling reads. Naming them here is what keeps the
// closure check meaningful: a NEW helper written for this page belongs in the scanned
// set, not in this list, and adding to it is a deliberate act.
export const NOT_QUERY_READERS = new Set([
  "greenlightConfig.ts",
  "greenlightRender.ts",
]);

export function localImports(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const specs = Array.from(src.matchAll(/from\s+"([^"]+)"/g)).map((m) => m[1]);
  const resolved: string[] = [];
  for (const spec of specs) {
    const base = spec.startsWith(".")
      ? path.resolve(path.dirname(file), spec)
      : path.join(ROOT, spec);
    if (!COVERED_ROOTS.some((r) => base.startsWith(path.join(ROOT, r)))) {
      continue;
    }
    const hit = [".ts", ".tsx"]
      .map((ext) => `${base}${ext}`)
      .find((p) => fs.existsSync(p));
    if (hit !== undefined) {
      resolved.push(hit);
    }
  }
  return resolved;
}

// sqlfluff owns the formatting of these files, so the parse keys off the one thing it does
// not move: the outermost SELECT and its terminating clause both sit at column 0, while
// every CTE body is indented inside `WITH ... AS (`.
export const TERMINATOR = /^(FROM|WHERE|GROUP|ORDER|LIMIT|HAVING)\b/;

export function selectBody(sql: string, queryName: string): string {
  const lines = sql.split("\n");
  // Every nested SELECT is indented inside its CTE, so a bare one at column 0 is the
  // outermost projection. Requiring exactly one turns a second — a top-level UNION, say —
  // into a failure here rather than a silent parse of whichever came first.
  const starts = lines.flatMap((l, i) => (l.trimEnd() === "SELECT" ? [i] : []));
  if (starts.length !== 1) {
    throw new Error(
      `${queryName}: expected exactly one \`SELECT\` alone at column 0, found ` +
        `${starts.length}${
          starts.length ? ` (lines ${starts.map((i) => i + 1).join(", ")})` : ""
        }. ` +
        `The query was restructured; re-target this parser at the new shape rather than ` +
        `deleting the check.`
    );
  }
  const rest = lines.slice(starts[0] + 1);
  const end = rest.findIndex((l) => TERMINATOR.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Split on commas outside parentheses and string literals: several projections are
// multi-line `if(...)` or `round(...)` expressions whose arguments are comma-separated.
export function topLevelItems(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const ch of body) {
    if (ch === "'") {
      quoted = !quoted;
    }
    if (!quoted && ch === "(") {
      depth += 1;
    }
    if (!quoted && ch === ")") {
      depth -= 1;
    }
    if (!quoted && ch === "," && depth === 0) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((i) => i.trim()).filter((i) => i.length > 0);
}

// A projection is either aliased (`expr AS name`) or a bare column forwarded from a
// subquery (`merged_evaluated_prs`). Anything else is an expression with no output name,
// which cannot be addressed by the UI and is skipped.
export function outputName(item: string): string | undefined {
  const aliased = item.match(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
  if (aliased) {
    return aliased[1];
  }
  const bare = item.match(/^([A-Za-z_][A-Za-z0-9_]*)$/);
  return bare ? bare[1] : undefined;
}

// Columns whose projection can evaluate to NULL, by the one shape these queries use to
// mask an epoch or an absent join: `if(<cond>, NULL, <expr>) AS name`. Case-sensitive and
// bounded, so the `Null` inside `ifNull(...)` is not a match.
export function nullableColumns(queryName: string): Set<string> {
  const sql = fs.readFileSync(
    path.join(ROOT, "clickhouse_queries", queryName, "query.sql"),
    "utf8"
  );
  const names = topLevelItems(selectBody(sql, queryName))
    .filter((item) => /(^|[,(\s])NULL([,)\s]|$)/.test(item))
    .map(outputName)
    .filter((n): n is string => n !== undefined);
  return new Set(names);
}

export function emittedColumns(queryName: string): Set<string> {
  const sql = fs.readFileSync(
    path.join(ROOT, "clickhouse_queries", queryName, "query.sql"),
    "utf8"
  );
  const names = topLevelItems(selectBody(sql, queryName))
    .map(outputName)
    .filter((n): n is string => n !== undefined);
  return new Set(names);
}

// Every shape by which the page names a query column.
//
// The snake_case pattern does not care what the receiver is called, which the
// `row`-prefixed ones do: the revert scalars are read off a local named `scalars`
// and were invisible to this check until it was added. Requiring an underscore is
// what keeps it from matching camelCase field access like `error?.message`; the
// `row`-prefixed patterns stay because they still cover the single-word columns
// (`verdict`, `title`) an underscore rule cannot reach.
export const READ_PATTERNS = [
  /\w\??\.([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g,
  /\brow\?\.([a-z][a-z0-9_]*)\b/g,
  /\brow\.([a-z][a-z0-9_]*)\b/g,
  /\brows\[0\]\?\.([a-z][a-z0-9_]*)\b/g,
  // Any `<something>Field: "column_name"` config key, not the current set by name: a new
  // key naming a column is how a column quietly stops being covered by this check.
  // Disjoint from the `field:` pattern below rather than a superset of it — the capital F
  // excludes `field:` itself, and `\bfield:` in turn reaches none of these, because there
  // is no word boundary inside an identifier like `defaultSortField`.
  /\b[a-z][A-Za-z0-9]*Field:\s*"([a-z0-9_]+)"/g,
  /\bfield:\s*"([a-z0-9_]+)"/g,
  // Any `<something>Col("column_name"` helper, not stampCol by name: a second
  // such helper is how a column quietly stops being covered by this check.
  /\b[a-z][A-Za-z0-9]*Col\("([a-z0-9_]+)"/g,
];

// The literals a `multiIf(cond, result, cond, result, ..., else)` can evaluate to.
// Arguments alternate, so results are the odd positions plus the trailing else — which
// is what keeps the `''` in a condition like `merged_head = ''` out of the answer.
export function multiIfResults(sql: string, alias: string): string[] {
  const start = sql.indexOf("multiIf(");
  const projection = sql.slice(start, sql.indexOf(`AS ${alias}`, start));
  if (start === -1 || !projection.includes("multiIf(")) {
    throw new Error(
      `no multiIf projection aliased ${alias} found. The column moved or changed ` +
        `shape; re-target this parser at it rather than deleting the check.`
    );
  }
  const inner = projection.slice(
    projection.indexOf("(") + 1,
    projection.lastIndexOf(")")
  );
  const args = topLevelItems(inner);
  const results = args.filter((_, i) => i % 2 === 1);
  if (args.length % 2 === 1) {
    results.push(args[args.length - 1]);
  }
  return results.map((r) => r.replace(/^'([\s\S]*)'$/, "$1"));
}

export function readColumns(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of uiSources()) {
    const src = fs.readFileSync(file, "utf8");
    for (const pattern of READ_PATTERNS) {
      for (const m of src.matchAll(pattern)) {
        const files = found.get(m[1]) ?? new Set<string>();
        files.add(path.basename(file));
        found.set(m[1], files);
      }
    }
  }
  return found;
}
