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

// Scanned as text rather than imported: the module pulls in lib/GeneralUtils and with it
// octokit, which does not load under this jest environment.
export function catalogSource(): string {
  return fs.readFileSync(QUERY_CATALOG, "utf8");
}

export function querySql(queryName: string): string {
  return fs.readFileSync(
    path.join(ROOT, "clickhouse_queries", queryName, "query.sql"),
    "utf8"
  );
}

// Modelled on the reader in lib/clickhouse.ts, which takes an absent `params` or
// `defaults` as empty. A params.json missing one has to reach the assertions as a missing
// entry, which is the thing being checked, rather than as a TypeError in this parser.
export function queryParamsJson(queryName: string): {
  params: { [_name: string]: string };
  defaults: { [_name: string]: string };
  tests: { [_name: string]: string }[];
} {
  const parsed = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, "clickhouse_queries", queryName, "params.json"),
      "utf8"
    )
  );
  return {
    params: parsed.params ?? {},
    defaults: parsed.defaults ?? {},
    tests: parsed.tests ?? [],
  };
}

// Read out of the page's own catalog rather than restated here, so adding or dropping a
// query does not need this file edited — a hand-copied list goes stale exactly when the
// check matters.
export function catalogQueries(): string[] {
  const src = catalogSource();
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
  const src = catalogSource();
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
  const src = catalogSource();
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
  const sql = querySql(queryName);
  const names = topLevelItems(selectBody(sql, queryName))
    .filter((item) => /(^|[,(\s])NULL([,)\s]|$)/.test(item))
    .map(outputName)
    .filter((n): n is string => n !== undefined);
  return new Set(names);
}

export function emittedColumns(queryName: string): Set<string> {
  const sql = querySql(queryName);
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

// The ClickHouse parameter behind the page's shadow-population control, and the type it is
// declared with. Named once because the contract spells it in five places nothing else
// ties together: params.json's `params`, its `defaults`, each of its `tests` entries, the
// SQL placeholder, and the TypeScript union the page holds in state.
export const SHADOW_MODE_PARAM = "shadowMode";
export const SHADOW_MODE_TYPE = "String";

// The per-unit flag each query groups the ledger's rows into before filtering on it.
export const IS_SHADOW_COLUMN = "is_shadow";

const SHADOW_PLACEHOLDER = `\\{${SHADOW_MODE_PARAM}: ${SHADOW_MODE_TYPE}\\}`;

// One selecting arm: the mode it tests for and the column it tests. The table qualifier is
// dropped, so `u.is_shadow` and `is_shadow` read as the same column.
const SHADOW_ARM = new RegExp(
  `${SHADOW_PLACEHOLDER}\\s*=\\s*'([a-z_]+)'\\s+AND\\s+(?:NOT\\s+)?(?:[A-Za-z_]\\w*\\.)?` +
    `([A-Za-z_]\\w*)`,
  "g"
);

// The arm that lets every other value through, and the one arm every filter ends with —
// which is what makes it usable as the delimiter between filters.
const SHADOW_FALL_OPEN = new RegExp(
  `${SHADOW_PLACEHOLDER}\\s+NOT IN\\s*\\(([^)]*)\\)`,
  "g"
);

const MODE_LITERAL = /'([a-z_]+)'/g;

// All four queries carry a prose block above the filter describing it, so a comment that
// quoted the SQL would otherwise parse as a filter of its own.
function sqlCode(queryName: string): string {
  return querySql(queryName).replace(/^[ \t]*--.*$/gm, "");
}

export interface ShadowFilter {
  // Mode literal -> the column that mode's own arm tests.
  selects: Map<string, string>;
  // The modes the fall-open arm declines to cover, on the understanding that an arm above
  // it already does. Held apart from `selects` because the two halves of the filter are
  // written separately and so drift separately.
  handled: Set<string>;
}

// Every `(mode = X AND col) OR ... OR mode NOT IN (...)` filter in a query, in file order.
// Delimited by the fall-open arm, so the selecting arms belonging to one filter are those
// standing between it and the end of the previous.
export function shadowFilters(queryName: string): ShadowFilter[] {
  const sql = sqlCode(queryName);
  const filters: ShadowFilter[] = [];
  let from = 0;
  for (const fallOpen of Array.from(sql.matchAll(SHADOW_FALL_OPEN))) {
    const at = fallOpen.index ?? 0;
    const selects = new Map<string, string>();
    for (const arm of Array.from(sql.slice(from, at).matchAll(SHADOW_ARM))) {
      selects.set(arm[1], arm[2]);
    }
    filters.push({
      selects,
      handled: new Set(
        Array.from(fallOpen[1].matchAll(MODE_LITERAL)).map((m) => m[1])
      ),
    });
    from = at + fallOpen[0].length;
  }
  if (filters.length === 0) {
    throw new Error(
      `${queryName}: no \`{${SHADOW_MODE_PARAM}: ${SHADOW_MODE_TYPE}}\` filter found. ` +
        `The query stopped selecting a population, or the filter changed shape; ` +
        `re-target this parser at it rather than deleting the check.`
    );
  }
  return filters;
}

// How many times a query groups the ledger's rows and attributes the flag to the whole
// unit. Each grouping exists in order to be filtered on, so this is what the number of
// filters naming that column is measured against.
export function isShadowGroupings(queryName: string): number {
  return Array.from(
    sqlCode(queryName).matchAll(new RegExp(`\\bAS ${IS_SHADOW_COLUMN}\\b`, "g"))
  ).length;
}

export interface ShadowContract {
  // The literals the ShadowMode union admits.
  modes: string[];
  // What an un-parameterised call resolves to, and the one mode no query selects on,
  // because every filter falls open on it.
  fallback: string;
  // The values the control offers, which is what the page can actually be put into.
  offered: string[];
}

// The shadow contract as the page's own TypeScript states it. Read in one pass and
// reported together, so a restructure that moves all three names all three.
export function shadowContract(): ShadowContract {
  const src = catalogSource();
  const union = src.match(/export type ShadowMode\s*=([^;]*);/);
  const fallback = src.match(/DEFAULT_SHADOW_MODE[^=]*=\s*"([a-z_]+)"/);
  const offered = src.match(/SHADOW_MODE_OPTIONS[^=]*=\s*\[([\s\S]*?)\n\];/);
  if (union === null || fallback === null || offered === null) {
    const missing = [
      union === null ? "the ShadowMode union" : "",
      fallback === null ? "DEFAULT_SHADOW_MODE" : "",
      offered === null ? "SHADOW_MODE_OPTIONS" : "",
    ].filter((m) => m.length > 0);
    throw new Error(
      `${path.basename(QUERY_CATALOG)}: ${missing.join(
        ", "
      )} not found. The shadow ` +
        `contract moved or changed shape; re-target this parser at it rather than ` +
        `deleting the check.`
    );
  }
  return {
    modes: Array.from(union[1].matchAll(/"([a-z_]+)"/g)).map((m) => m[1]),
    fallback: fallback[1],
    offered: Array.from(offered[1].matchAll(/\bvalue:\s*"([a-z_]+)"/g)).map(
      (m) => m[1]
    ),
  };
}

// Mode sets are compared as sorted text, so a mismatch reads as the two lists rather than
// as two Sets printed in insertion order.
export function modeList(modes: Iterable<string>): string {
  return Array.from(modes).sort().join(", ");
}
