import { ComparisonTableConfig } from "../../../helper";

type GridItemModel = {
  value: number | string | null | undefined;
  displayName: string;
};

type GridRowModel = {
  id: string;
  label: string;
  primary: string;
  metadataColumns: GridItemModel[];
  metric: string;
  byWorkflow: Record<string, RowCellObj[]>;
  groupInfo: any;
};

// used when find unique rows
const TO_ROW_EXCLUDE_KEYS = [
  "repo",
  "job_id",
  "workflow_id",
  "commit",
  "branch",
  "granularity_bucket",
  "timestamp",
  "date",
];

export function groupKeyAndLabel(gi: any, exclude_keys: string[] = []) {
  const keys = Object.keys(gi ?? {})
    .filter((k) => !exclude_keys.includes(k))
    .sort();
  const key = keys.map((k) => `${k}=${String(gi?.[k])}`).join("|");
  const label = keys.map((k) => String(gi?.[k])).join(" · ");
  return { key, label, metric: String(gi?.metric ?? "") };
}

function getGroupKeyAndLabel(gi: any) {
  return groupKeyAndLabel(gi, TO_ROW_EXCLUDE_KEYS);
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
export const asNumber = (v: unknown): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const num = Number(v);
    return isNaN(num) ? undefined : num;
  }
  return undefined;
};
export const valOf = (cell?: RowCellObj) => (cell ? cell.value : undefined);
export const displayNameOf = (cell?: RowCellObj) =>
  cell ? cell.displayName : undefined;

/**
 * convert the data to ready to render table row
 * @param data
 * @returns
 */
export function ToComparisonTableRow(config: ComparisonTableConfig, data: any) {
  const m = new Map<string, GridRowModel>();
  for (const rowData of data ?? []) {
    const gi = rowData.group_info ?? {};
    const wf = String(gi?.workflow_id ?? "");
    const { key, label } = getGroupKeyAndLabel(gi);

    const primaryRowValue = config?.primary?.fields
      ? config.primary.fields.map((k) => gi[k]).join(" · ")
      : label;

    const rowDataMap = rowData.data ?? {};
    if (!m.has(key)) {
      m.set(key, {
        ...gi,
        id: key,
        label,
        byWorkflow: {},
        groupInfo: gi,
        primary: primaryRowValue,
      });
    }
    m.get(key)!.byWorkflow[wf] = rowDataMap;
  }
  return Array.from(m.values());
}
