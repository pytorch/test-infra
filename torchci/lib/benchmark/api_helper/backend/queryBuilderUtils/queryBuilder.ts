import { queryClickhouse } from "lib/clickhouse";

export type SelectItem = string | [field: string, alias: string];

interface BuildQueryClassOptions {
  table: string;
  orderBy?: string[]; // raw ORDER BY list
  defaultSelect?: SelectItem[]; // default SELECT list
  defaultWhere?: WhereItem[]; // default WHERE list
}

type WhereItem = {
  /** Unique key for merging/overriding (e.g. "repo", "has_benchmarkNames") */
  key: string;
  /** Raw SQL fragment without "WHERE" and without leading AND */
  sql: string;
};

interface Defaults {
  table: string;
  distinct?: boolean;
  select?: SelectItem[];
  prewhere?: string[];
  where?: string[];
  orderBy?: string[];
  selectAll?: boolean;
  prewhere_exists?: boolean;
  where_exists?: boolean;
  order_by_exists?: boolean;
  select_exists?: boolean;
}

/**
 * Dynamic SQL builder for clickhouse queries.
 * special tokens:
 *
 * - {{DISTINCT}}: based on input customDistinct
 * - {{SELECT}}: select items, comma-separated
 * - {{TABLE}}: table
 * - {{PREWHERE}}: prewhere []string
 * - {{WHERE}}: where items, AND-separated
 * {{ORDER_BY}}: order by items, comma-separated
 *
 * default template:
 *
 * SELECT {{DISTINCT}}
 *      {{SELECT}}
 *   FROM
 *       {{TABLE}}{{PREWHERE}}{{WHERE}}{{ORDER_BY}}
 *
 */
export class QueryBuilder {
  private template: string;
  private defaults: Defaults;

  private extraSelect: SelectItem[] = [];
  private extraWhere: string[] = [];
  private customTable?: string;
  private customDistinct?: boolean;

  constructor(
    defaults: Defaults,
    template = `
    SELECT {{DISTINCT}}
        {{SELECT}}
    FROM
        {{TABLE}}{{PREWHERE}}{{WHERE}}{{ORDER_BY}}
    `.trim()
  ) {
    this.defaults = defaults;
    this.template = template;
  }
  addSelect(items: SelectItem[]) {
    this.extraSelect.push(...items);
    return this;
  }

  /** Append WHERE clauses (exact-string dedupe). */
  addWhere(clauses: string[]) {
    this.extraWhere.push(...clauses);
    return this;
  }

  /** Build final SQL string. */
  build(): string {
    // SELECT: map by declared alias (right side); later entries override earlier ones.
    const byField = new Map<string, SelectItem>();
    const key = (s: SelectItem) => (Array.isArray(s) ? s[1] : s);
    for (const it of this.defaults.select ?? []) byField.set(key(it), it);
    for (const it of this.extraSelect) byField.set(key(it), it);

    let SELECT = [...byField.values()]
      .map((it) => (Array.isArray(it) ? `${it[0]} AS ${it[1]}` : it))
      .join(",\n    ");

    if (this.defaults.selectAll === true) {
      SELECT = "*";
    }
    if (SELECT && this.defaults.select_exists) {
      SELECT = ",\n " + SELECT;
    }

    // PREWHERE
    const pre = (this.defaults.prewhere ?? []).filter(Boolean);
    const prewherePreifx = this.defaults.prewhere_exists
      ? "\n    AND"
      : "\nPREWHERE\n";
    const PREWHERE = pre.length
      ? `${prewherePreifx}    ${pre.join("\n    AND ")}`
      : "";

    // WHERE (defaults + extras, dedup by exact string)
    const whereSet = new Set<string>(this.defaults.where ?? []);
    for (const w of this.extraWhere) if (w && w.trim()) whereSet.add(w.trim());
    const whereArr = [...whereSet].filter(Boolean);
    const wherePreifx = this.defaults.where_exists ? "\n AND" : "\nWHERE\n";
    const WHERE = whereArr.length
      ? `${wherePreifx}  ${whereArr.join("\n    AND ")}`
      : "";

    // ORDER BY
    const order = (this.defaults.orderBy ?? []).filter(Boolean);
    const orderPreifx = this.defaults.order_by_exists
      ? ",\n   "
      : "\nORDER BY\n";
    const ORDER_BY = order.length
      ? `${orderPreifx}  ${order.join(",\n    ")}`
      : "";

    const TABLE = this.customTable ?? this.defaults.table;
    const DISTINCT =
      (this.customDistinct ?? this.defaults.distinct) === false
        ? ""
        : "DISTINCT";

    return this.template
      .replaceAll("{{DISTINCT}}", DISTINCT)
      .replaceAll("{{SELECT}}", SELECT)
      .replaceAll("{{TABLE}}", TABLE)
      .replaceAll("{{PREWHERE}}", PREWHERE)
      .replaceAll("{{WHERE}}", WHERE)
      .replaceAll("{{ORDER_BY}}", ORDER_BY)
      .trim();
  }
}

export type QueryExecutor = (
  sql: string,
  params: Record<string, any>,
  query_id?: string,
  useQueryCache?: boolean
) => Promise<any>;

export interface BuildableQuery {
  build(): string; // must return SQL string
  toQueryParams(inputs: any, id?: string): Record<string, any>;
}

/**
 * Base class for executable queries.
 */
export abstract class ExecutableQueryBase implements BuildableQuery {
  abstract build(): string;

  /** Default: pass inputs through as params (override in subclasses if needed). */
  toQueryParams(inputs: any, id?: string): Record<string, any> {
    return inputs;
  }

  /** Build SQL and execute via provided executor. */
  async applyQuery(
    inputs: any,
    executor: QueryExecutor = queryClickhouse
  ): Promise<any> {
    const sql = this.build();
    const params = this.toQueryParams(inputs);
    return executor(sql, params);
  }
}
