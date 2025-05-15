import { DataGrid } from "@mui/x-data-grid";
import { deepClone } from "@mui/x-data-grid/internals";
import Link from "next/link";

export enum ValueType {
  String = "string",
  Number = "number",
  Boolean = "boolean",
  List = "list",
  Link = "link",
}

export interface MetricsTableUserMappingEntry {
  /**
   * Optional: field name from the data object (e.g. 'group_key', 'metrics')
   */
  field?: string;

  /**
   * Optional: template string to compute a custom field value (e.g. "${group_key}|${parent_group}")
   */
  custom_field_expression?: string;

  /**
   * Optional: the column header name to display in UI tables
   */
  headerName?: string;

  /**
   * Data type of the field; used for rendering and formatting
   */
  value_type: ValueType | string;

  /**
   * Whether this field should be visible in the UI (default is true)
   */
  visible?: boolean;

  /**
   * linkurl template if value_type is "link", e.g. "/job/${job_id}"
   */
  link_url?: string;

  unit?: string;
}

type Props = {
  userMapping: { [key: string]: MetricsTableUserMappingEntry };
  data: any[];
};

export default function MetricsTable({ userMapping, data }: Props) {
  const staticColumns = generateStaticColumns(userMapping);
  const metricKeys = extractMetricKeys(data);
  const metricColumns = generateMetricColumns(metricKeys, userMapping);
  const columns = [...staticColumns, ...metricColumns];
  const rows = getRows(data, userMapping);

  return (
    <div style={{ height: "1000px", width: "100%" }}>
      <DataGrid
        rows={rows}
        columns={columns}
        pageSizeOptions={[100]}
        density="compact"
        pagination
      />
    </div>
  );
}

function generateStaticColumns(userMapping: { [key: string]: any }) {
  return Object.entries(userMapping)
    .filter(([, conf]) => conf.visible !== false)
    .map(([field, conf]) => ({
      field,
      headerName: conf.headerName ?? field,
      width: 120,
      renderCell: (params: any) => {
        const value = params.value;
        const row = params.row;
        if (conf.value_type === "link" && conf.link_url) {
          const url = row.__links?.[field];
          return (
            <Link
              href={url}
              style={{ textDecoration: "underline", color: "#007bff" }}
            >
              {value}
            </Link>
          );
        }
        return <div>{params.formattedValue}</div>;
      },
    }));
}

function extractMetricKeys(dataList: any[]): string[] {
  const metricKeys = new Set<string>();
  dataList.map((d) => {
    if (d.metrics && typeof d.metrics === "object") {
      Object.keys(d.metrics).forEach((k) => metricKeys.add(k));
    }
  });
  return Array.from(metricKeys);
}

function getRows(data: any[], userMapping: { [key: string]: any }) {
  const rows = deepClone(data).map((item: any, index: number) => {
    const row: any = { id: index }; // fallback id

    for (const [key, conf] of Object.entries(userMapping)) {
      if ("custom_field_expression" in conf) {
        row[key] = resolveExpression(conf.custom_field_expression, item);
      } else if (conf.field) {
        row[key] = item[conf.field];
      }

      if (conf.value_type === "link" && conf.link_url) {
        row.__links = row.__links || {};
        row.__links[key] = safeLinkRoute(conf.link_url, item);
      }
    }

    if (item.metrics && typeof item.metrics === "object") {
      for (const [k, v] of Object.entries(item.metrics)) {
        row[k] = v;
      }
    }

    return row;
  });
  return rows;
}

function generateMetricColumns(
  metricKeys: string[],
  userMapping: { [key: string]: any }
) {
  if (metricKeys.length == 0) {
    return [];
  }

  let config: any = {};
  if ("metrics" in userMapping) {
    config = userMapping["metrics"];
  } else {
    return [];
  }

  return metricKeys.map((key) => ({
    field: key,
    headerName: key,
    width: 120,
    renderCell: (params: any) => {
      let bgColor = "";
      if (typeof params.value === "number") {
        return (
          <div
            style={{
              width: "100%",
              height: "100%",
              backgroundColor: bgColor,
              display: "flex",
              alignItems: "center",
              paddingLeft: 8,
            }}
          >
            {Number(params.value).toFixed(2)} {config?.unit ?? ""}
          </div>
        );
      }
      if (typeof params.value === "boolean") {
        return <div>{params.value ? "True" : "False"}</div>;
      }
      return <div>{params.formattedValue}</div>;
    },
  }));
}

function safeLinkRoute(template: string, row: any) {
  const replaced = template.replace(/\$\{(\w+)\}/g, (_, key) => row[key] ?? "");
  const url = new URL(replaced, "http://dummy"); // dummy base for relative URL
  const searchParams = new URLSearchParams();

  for (const [key, value] of url.searchParams.entries()) {
    searchParams.set(key, value); // let URLSearchParams handle encoding
  }
  return `${url.pathname}?${searchParams.toString()}`;
}

function isValidValueType(val: string): val is ValueType {
  return Object.values(ValueType).includes(val as ValueType);
}

const resolveExpression = (expr: string, row: any): string =>
  expr.replace(/\${(.*?)}/g, (_, key) => row[key] ?? "");
