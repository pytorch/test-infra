import { ComparisonTableConfig } from "../../../helper";

type GridRowModel = {
  id: string;
  label: string;
  name: string;
  metric: string;
  byWorkflow: Record<string, RowCellObj[]>;
  sampleInfo: any;
};

// used when find unique rows
const TO_ROW_EXCLUDE_KEYS = [
  "workflow_id",
  "commit",
  "branch",
  "granularity_bucket",
  "timestamp",
  "date",
];

function getGroupKeyAndLabel(gi: any) {
  const keys = Object.keys(gi ?? {})
    .filter((k) => !TO_ROW_EXCLUDE_KEYS.includes(k))
    .sort();
  const key = keys.map((k) => `${k}=${String(gi?.[k])}`).join("|");
  const label = keys.map((k) => String(gi?.[k])).join(" · ");
  return { key, label, metric: String(gi?.metric ?? "") };
}

export type RowCellObj = {
  value: number | string | null | undefined;
  [k: string]: any;
};
export type SnapshotRow = {
  group_info: any;
  sub_keys: string[];
  group_keys: string[];
  rows: RowCellObj[];
};

/** Helpers */
export const asNumber = (v: unknown) => (typeof v === "number" ? v : undefined);
export const valOf = (cell?: RowCellObj) => (cell ? cell.value : undefined);

export function ToComparisonTableRow(config: ComparisonTableConfig, data: any) {
  const m = new Map<string, GridRowModel>();
  for (const rowData of data ?? []) {
    const gi = rowData.group_info ?? {};
    const wf = String(gi?.workflow_id ?? "");
    const { key, label } = getGroupKeyAndLabel(gi);

    const name = config?.nameKeys
      ? config.nameKeys.map((k) => gi[k]).join(" · ")
      : label;
    const rowDataMap = rowData.data ?? {};
    if (!m.has(key)) {
      m.set(key, {
        ...gi,
        id: key,
        label,
        byWorkflow: {},
        sampleInfo: gi,
        name,
      });
    }
    m.get(key)!.byWorkflow[wf] = rowDataMap;
  }
  return Array.from(m.values());
}
