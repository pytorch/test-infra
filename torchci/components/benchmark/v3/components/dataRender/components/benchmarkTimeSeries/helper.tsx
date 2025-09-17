export type BenchmarkChartSectionConfig = {
  titleMapping?: Record<string, string>;
  groupByFields: string[];
  filterByFieldValues?: Record<string, Array<string>>;
  chartGroup: ChartGroupConfig;
};

export type BenchmarkComparisonTableSectionConfig = {
  titleMapping?: Record<string, string>;
  groupByFields: string[];
  filterByFieldValues?: Record<string, Array<string>>;
  tableConfig: ComparisonTableConfig;
};

export type ComparisonTableConfig = {
  titleMapping?: Record<string, string>;
  nameKey: string;
  renderOptions?: {
    columnPolicy: any;
  };
};

export type ChartGroupConfig = {
  type: "line";
  titleMapping?: Record<string, string>;
  groupByFields?: string[];
  filterByFieldValues?: Record<string, Array<string>>;
  lineKey?: string[];
  renderOptions?: any;
  chart?: ChartConfig;
};

export type ChartConfig = {
  renderOptions?: any;
};

export type RawTimeSeriesPoint = {
  metric: string;
  value: number;
  legend_name: string;
  granularity_bucket: string;
  workflow_id: string;
  commit: string;
  branch: string;
  [key: string]: string | number;
};

/** Input structure: multiple lines, each with group_info and data points. */
export type BenchmarkTimeSeriesInput = {
  group_info: Record<string, string | number>;
  legend_name: string;
  data: RawTimeSeriesPoint[];
};

function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

export function passesFilter(
  gi: Record<string, any>,
  filter?: Record<string, Array<string | number>>
): boolean {
  if (!filter) return true;
  for (const [k, allowed] of Object.entries(filter)) {
    if (!allowed || allowed.length === 0) continue;
    const val = gi?.[k];
    if (!allowed.map(toStr).includes(toStr(val))) return false;
  }
  return true;
}

export function makeGroupKeyAndLabel(
  gi: Record<string, any>,
  fields: string[]
): { key: string; labels: string[] } {
  if (!fields.length) return { key: "__ALL__", labels: [] };
  const parts = fields.map((f) => `${f}=${toStr(gi?.[f])}`);
  const labels = fields.map((f) => `${toStr(gi?.[f])}`);
  return { key: parts.join("|"), labels };
}
