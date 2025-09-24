import { BenchmarkComparisonPolicyConfig } from "components/benchmark/v3/configs/helpers/RegressionPolicy";

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
  nameKeys?: string[]; // the field name used to render the name of the row, if not set, use all groupinfo labels
  renderOptions?: {};
  // indicates the field to use for comparison policy map
  comparisonPolicyTargetField?: string;
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
  titleMapping?: Record<string, string>;
  groupByFields?: string[];
  filterByFieldValues?: Record<string, Array<string>>;
  lineKey?: string[];
  renderOptions?: any;
  chart?: ChartConfig;
};

export type ChartConfig = {
  customizedConfirmDialog?: {
    type: string;
    id?: string;
  };
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
    });
  }
  // Sort by numeric if all ids are numbers, else lexicographically
  return Array.from(workflowIdMap.values()).sort((a, b) => {
    const na = /^\d+$/.test(a.workflow_id) ? Number(a.workflow_id) : NaN;
    const nb = /^\d+$/.test(b.workflow_id) ? Number(b.workflow_id) : NaN;
    return Number.isNaN(na) || Number.isNaN(nb)
      ? a.workflow_id.localeCompare(b.workflow_id)
      : na - nb;
  });
}

export const shortSha = (id?: string) =>
  id ? (id.length > 10 ? id.slice(0, 7) : id) : "—";
