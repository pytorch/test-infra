import { BenchmarkComparisonPolicyConfig } from "components/benchmark_v3/configs/helpers/RegressionPolicy";
import dayjs from "dayjs";

export const DEFAULT_TARGET_FILED = "metric";

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

// How to render a single metric in a table
export interface BenchmarkUnitConfig {
  type: "percent" | "number" | "duration" | "bytes" | "none";
  unit?: string; // e.g. "%", "ms", "MB"
  scale?: number; // no scale will applied if not set
}

// The book: dictionary keyed by field name
export interface BenchmarkTimeSeriesChartRenderingBook {
  [id: string]: BenchmarkTimeSeriesChartRenderingConfig;
}

export interface BenchmarkTimeSeriesChartRenderingConfig {
  displayName?: string;
  unit: BenchmarkUnitConfig;
}

// Config for table rendering
export interface BenchmarkComparisonTableRenderingConfig {
  unit: BenchmarkUnitConfig;
}

// The book: dictionary keyed by field name
export interface BenchmarkComparisonTableRenderingBook {
  [id: string]: BenchmarkComparisonTableRenderingConfig;
}

export interface BenchmarkTitle {
  text: string; // display title in the table header
  description?: string; // optional help text
  link: string; // link to nav
}

export interface BenchmarkComparisonTitleMapping {
  [id: string]: BenchmarkTitle;
}
// Full renderOptions container
export interface BenchmarkComparisonTableRenderingOptions {
  title_group_mapping: BenchmarkComparisonTitleMapping;
  tableRenderingBook: BenchmarkComparisonTableRenderingBook;
}

export type ComparisonTableConfig = {
  nameKeys?: string[]; // the field name used to render the name of the row, if not set, use all groupinfo labels
  renderOptions?: BenchmarkComparisonTableRenderingOptions;
  // indicates the field to use for comparison policy map, and rendering map
  targetField?: string;
  comparisonPolicy?: {
    [key: string]: BenchmarkComparisonPolicyConfig;
  };
  enableDialog?: boolean;
  customizedConfirmDialog?: {
    type: string;
    id?: string;
  };
};

export type ChartGroupConfig = {
  type: "line";
  groupByFields?: string[];
  filterByFieldValues?: Record<string, Array<string>>;
  lineKey?: string[];
  renderOptions?: any;
  // default is true, if set to false, the chart section select mode will be disabled
  sectionSelectMode?: {
    [key: string]: boolean;
  };
  chart?: ChartConfig;
};

export type ChartConfig = {
  customizedConfirmDialog?: {
    type: string;
    id?: string;
  };

  renderOptions?: BenchmarkTimeSeriesCharRenderOpiton;
};

export type BenchmarkTimeSeriesCharRenderOpiton = {
  height?: string | number;
  title_group_mapping: BenchmarkComparisonTitleMapping;
  chartRenderBook?: BenchmarkTimeSeriesChartRenderingBook;
};

export type RawTimeSeriesPoint = {
  metric: string;
  value: number;
  legend_name: string;
  granularity_bucket: string;
  workflow_id: string;
  commit: string;
  branch: string;
  renderOptions?: {
    size?: number;
    color?: string;
  };
  [key: string]: any;
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

export function toGroupKeyMap(data: any[], fields: string[]) {
  const m = new Map<string, { key: string; labels: string[]; items: any }>();
  for (const s of data) {
    const gi = s.group_info || {};
    const { key, labels } = makeGroupKeyAndLabel(gi, fields);
    if (!m.has(key)) m.set(key, { key, labels, items: [] });
    m.get(key)!.items.push(s);
  }
  return m;
}

/**
 *
 * @param data data list, the gruop_info in data object must have workflow_id, commit and branch
 * @returns
 */
export function toSortedWorkflowIdMap(data: any[]) {
  const workflowIdMap = new Map<string, any>();
  for (const d of data) {
    if (!d.group_info) {
      throw new Error(
        "[toSortedWorkflowIdMap]group_info is missing when try to form the workflowIdMap "
      );
    }
    if (!d.group_info.workflow_id) {
      throw new Error(
        "[toSortedWorkflowIdMap]workflow_id is missing when try to form the workflowIdMap "
      );
    }

    const id = String(d.group_info.workflow_id);
    workflowIdMap.set(id, {
      workflow_id: id,
      label: id,
      commit: d.group_info.commit,
      branch: d.group_info.branch,
      date: d.group_info.granularity_bucket,
    });
  }
  return Array.from(workflowIdMap.values()).sort((a, b) => {
    return dayjs(a.date).unix() - dayjs(b.date).unix();
  });
}

export const shortSha = (id?: string) =>
  id ? (id.length > 10 ? id.slice(0, 7) : id) : "—";

export function getBenchmarkTimeSeriesTitle(
  default_title: string = "unknown",
  key: string,
  config?: ComparisonTableConfig | ChartConfig
) {
  if (!config?.renderOptions?.title_group_mapping) {
    return {
      text: default_title,
    };
  }
  const book = config.renderOptions.title_group_mapping;
  if (!book) {
    return {
      text: default_title,
    };
  }
  const text = book[key]?.text || default_title;
  const description = book[key]?.description || undefined;
  return {
    text,
    description,
  };
}

const DEFAULT_UNIT_TYPE = "none";
const DEFAULT_BYTE_UNIT = "B";
const DEFAULT_DURATION_UNIT = "ms";
const DEFAULT_PERCENT_UNIT = "%";

export function renderBasedOnUnitConifg(
  value: any,
  table_unit?: BenchmarkUnitConfig
) {
  if (!table_unit) return `${value}`;

  if (!value) return "";

  const type = table_unit?.type || DEFAULT_UNIT_TYPE;
  const scale = table_unit?.scale || undefined;
  let unit = table_unit?.unit || undefined;

  let renderedValue = value;
  if (scale) {
    renderedValue = value * scale;
  }

  switch (type) {
    case "percent":
      if (!unit) unit = DEFAULT_PERCENT_UNIT;
      return `${renderedValue}%`;
    case "number":
      return `${renderedValue}`;
    case "duration":
      if (!unit) unit = DEFAULT_DURATION_UNIT;
      return `${renderedValue}${unit}`;
    case "bytes":
      if (!unit) unit = DEFAULT_BYTE_UNIT;
      return `${renderedValue}${unit}`;
    case "none":
    default:
      if (unit) return `${renderedValue}${unit}`;
      return `${value}`;
  }
}

export function getBenchmarkTimeSeriesComparisionTableRenderingConfig(
  target: string,
  config?: ComparisonTableConfig
) {
  return config?.renderOptions?.tableRenderingBook?.[target];
}

export function getBenchmarkTimeSeriesChartRenderingConfig(
  target: string,
  renderOptions?: BenchmarkTimeSeriesCharRenderOpiton
) {
  return renderOptions?.chartRenderBook?.[target];
}

export function getBenchmarkTimeSeriesComparisonTableTarget(
  config?: ComparisonTableConfig
) {
  return config?.targetField || DEFAULT_TARGET_FILED;
}

export const fmtFixed2 = (v: any) =>
  v == null
    ? "—"
    : typeof v === "number"
    ? Number(v).toFixed(2)
    : String(v.toFixed(2));
