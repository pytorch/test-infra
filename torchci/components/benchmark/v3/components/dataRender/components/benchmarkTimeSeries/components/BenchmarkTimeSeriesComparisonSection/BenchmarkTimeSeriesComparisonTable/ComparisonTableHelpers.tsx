import { ComparisonTableConfig } from "../../../helper";

type GridRowModel = {
  id: string;
  label: string;
  name: string;
  metric: string;
  byWorkflow: Record<string, RowColumns>;
  sampleInfo: any;
};

// used when find unique rows
const EXCLUDE_KEYS = ["workflow_id", "commit", "branch"];
function getGroupKeyAndLabel(gi: any) {
  const keys = Object.keys(gi ?? {})
    .filter((k) => !EXCLUDE_KEYS.includes(k))
    .sort();
  const key = keys.map((k) => `${k}=${String(gi?.[k])}`).join("|");
  const label = keys.map((k) => String(gi?.[k])).join(" · ");
  return { key, label, metric: String(gi?.metric ?? "") };
}

/** Input types (your shape) */
export type RowCellObj = {
  value: number | string | null | undefined;
  [k: string]: any;
};
export type RowColumns = Record<string, RowCellObj>;
export type SnapshotRow = { group_info: any; rows: RowColumns };

/** Helpers */
export const asNumber = (v: unknown) => (typeof v === "number" ? v : undefined);
export const valOf = (cell?: RowCellObj) => (cell ? cell.value : undefined);

export function getComparisonTableRowDefinition(
  config: ComparisonTableConfig,
  data: any
) {
  const m = new Map<string, GridRowModel>();
  for (const item of data ?? []) {
    const gi = item.group_info ?? {};
    const wf = String(gi?.workflow_id ?? "");
    const { key, label, metric } = getGroupKeyAndLabel(gi);

    const name = config.nameKey ? gi?.[config.nameKey] : label;
    if (!m.has(key)) {
      m.set(key, {
        id: key,
        label,
        metric,
        byWorkflow: {},
        sampleInfo: gi,
        name,
      });
    }
    m.get(key)!.byWorkflow[wf] = item.rows ?? {};
  }
  return Array.from(m.values());
}
